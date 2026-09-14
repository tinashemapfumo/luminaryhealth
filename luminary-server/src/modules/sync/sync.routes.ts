import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withoutTenant } from '../../platform/db.js';
import { config } from '../../platform/config.js';
import { syncService, SNAPSHOT_ORDER, type Change } from './sync.service.js';
import { Forbidden, NotFound, Unauthorized } from '../../platform/errors.js';
import { requirePermission } from '../../platform/permissions.js';

/**
 * Peer-to-peer replication endpoints.
 *
 * These are called by another *server*, not by a browser, so they authenticate
 * with a shared node secret rather than a user session. The practice being
 * synchronised is named in the request and checked against the secret's scope —
 * a node key is issued per practice precisely so a compromised clinic server
 * cannot reach into another clinic's data.
 */

const changeSchema = z.object({
  // `seq` is a bigserial, which node-postgres returns as a string to avoid
  // silently truncating values beyond Number.MAX_SAFE_INTEGER. Coerce rather
  // than demand a number, or every push is rejected as malformed.
  seq: z.coerce.number(),
  practice_id: z.string().uuid(),
  table_name: z.string(),
  row_id: z.string().uuid(),
  operation: z.enum(['insert', 'update', 'delete']),
  payload: z.record(z.unknown()),
  origin_node: z.string(),
  occurred_at: z.string(),
});

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Node-to-node auth. Constant-time compare, and absent config means closed.
   *
   * The secret proves the caller is *a* node; it does not prove which practice
   * it may speak for. That second question is answered from data rather than
   * configuration: cloud already records which node is a practice's home, so a
   * peer may only name a practice registered to it. Without that check a node
   * holding the shared secret could ask for any practice by id — and
   * `/sync/identity` reads outside any tenant context, so RLS would not be
   * there to catch it.
   */
  const authenticateNode = async (
    request: FastifyRequest,
  ): Promise<{ peer: string; practiceId: string }> => {
    const header = request.headers.authorization;
    const peer = request.headers['x-luminary-node'];
    const practiceId = request.headers['x-luminary-practice'];

    if (!config.syncSecret) throw new Forbidden('Replication is not enabled on this node');
    if (typeof peer !== 'string' || typeof practiceId !== 'string') {
      throw new Unauthorized('Node and practice headers are required');
    }
    if (header !== `Bearer ${config.syncSecret}`) throw new Unauthorized('Unknown peer');

    const registered = await withoutTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM luminary.practice
          WHERE id = $1 AND home_node = $2 AND deleted_at IS NULL`,
        [practiceId, peer],
      );
      return rows.length > 0;
    });
    // Same message as a bad secret: a peer asking about a practice that is not
    // its own learns nothing about whether that practice exists.
    if (!registered) throw new Unauthorized('Unknown peer');

    return { peer, practiceId };
  };

  // A peer hands us changes.
  app.post('/sync/push', async (request) => {
    const { peer, practiceId } = await authenticateNode(request);
    const { changes } = z.object({ changes: z.array(changeSchema).max(1000) }).parse(request.body);

    return withTenant({ practiceId, userId: null }, (client) =>
      syncService.apply(client, peer, changes as Change[]),
    );
  });

  /**
   * The practice row itself, for a node that does not yet have one.
   *
   * Every other seed endpoint runs inside a tenant context, which a brand-new
   * node cannot establish: the practice is the tenant, so it is the one row that
   * cannot arrive through tenant-scoped replication. It is served on its own
   * here, by id, against a secret already scoped to that practice — so this
   * reads exactly one known row and can enumerate nothing.
   */
  app.get('/sync/identity', async (request) => {
    const { practiceId } = await authenticateNode(request);

    return withoutTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM luminary.practice WHERE id = $1 AND deleted_at IS NULL`,
        [practiceId],
      );
      if (!rows[0]) throw new NotFound('practice');
      return rows[0];
    });
  });

  // A peer that has just been brought up asks for what already exists.
  //
  // Read-only and paged, so it costs the serving node a bounded query per
  // request rather than materialising a practice's whole history at once.
  app.get('/sync/snapshot', async (request) => {
    const { peer: _peer, practiceId } = await authenticateNode(request);
    const { table, after, limit } = z.object({
      // Restricted to the seed list here rather than in the service, so a bad
      // name is a 400 from validation instead of a 500 from a thrown Error.
      table: z.enum(SNAPSHOT_ORDER as unknown as [string, ...string[]]),
      after: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }).parse(request.query);

    return withTenant({ practiceId, userId: null }, (client) =>
      syncService.snapshot(client, table, after ?? null, limit),
    );
  });

  // A peer asks for ours.
  app.get('/sync/pull', async (request) => {
    const { peer, practiceId } = await authenticateNode(request);
    const { limit } = z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }).parse(request.query);

    return withTenant({ practiceId, userId: null }, (client) =>
      syncService.collect(client, peer, limit),
    );
  });

  // The peer confirms it stored what we sent, so we can advance our mark. Only
  // then is a change considered replicated — optimistically marking it on send
  // would lose data whenever a request failed midway.
  app.post('/sync/ack', async (request) => {
    const { peer, practiceId } = await authenticateNode(request);
    const { upTo } = z.object({ upTo: z.number().int().nonnegative() }).parse(request.body);

    await withTenant({ practiceId, userId: null }, (client) =>
      syncService.markSent(client, peer, upTo),
    );
    return { acknowledged: upTo };
  });

  // --- Operator-facing, session-authenticated ---

  app.get('/sync/status', async (request) => {
    if (!request.session) throw new Unauthorized();
    const { practiceId, userId } = request.session;
    return withTenant({ practiceId, userId }, (client) => syncService.status(client));
  });

  app.get('/sync/conflicts', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request) => {
      const { practiceId, userId } = request.session!;
      return withTenant({ practiceId, userId }, (client) => syncService.listConflicts(client));
    },
  });

  app.post('/sync/conflicts/:id/resolve', {
    preHandler: requirePermission('manageConfiguration'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { keep } = z.object({ keep: z.enum(['local', 'peer']) }).parse(request.body);
      const { practiceId, userId } = request.session!;
      return withTenant({ practiceId, userId }, (client) =>
        syncService.resolveConflict(client, id, keep, userId),
      );
    },
  });
}
