import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission, type Role } from '../../platform/permissions.js';
import { Unauthorized } from '../../platform/errors.js';

/**
 * Audit access.
 *
 * Read-only, and deliberately so: there is no update or delete endpoint here
 * because there is no update or delete grant in the database. The absence is the
 * feature.
 *
 * Practice managers can read this without being able to read clinical notes.
 * That separation is the point — *who accessed what* is a compliance question,
 * *what the patient said* is not their business.
 */

interface Actor { userId: string; role: Role; practiceId: string }

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(a: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: a.practiceId, userId: a.userId }, work);

  app.get('/audit', {
    preHandler: requirePermission('reviewAudit'),
    handler: async (request) => {
      const q = z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        actorId: z.string().uuid().optional(),
        severity: z.enum(['info', 'notice', 'alert']).optional(),
        action: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }).parse(request.query);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const params: unknown[] = [];
        const where: string[] = [];
        if (q.from) { params.push(q.from); where.push(`occurred_at >= $${params.length}`); }
        if (q.to) { params.push(q.to); where.push(`occurred_at < $${params.length}`); }
        if (q.actorId) { params.push(q.actorId); where.push(`actor_id = $${params.length}`); }
        if (q.severity) { params.push(q.severity); where.push(`severity = $${params.length}`); }
        if (q.action) { params.push(`%${q.action}%`); where.push(`action ILIKE $${params.length}`); }
        params.push(q.limit);

        const { rows } = await client.query(
          `SELECT id, occurred_at, actor_name, actor_role, action,
                  subject_type, subject_name, detail, severity, ip, origin_node
             FROM luminary.audit_event
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY occurred_at DESC
            LIMIT $${params.length}`,
          params,
        );
        return rows;
      });
    },
  });

  /**
   * What a compliance review actually opens with: how much happened, how much
   * of it was exceptional, and whether anyone has looked.
   */
  app.get('/audit/summary', {
    preHandler: requirePermission('reviewAudit'),
    handler: async (request) => {
      const { days } = z.object({
        days: z.coerce.number().int().min(1).max(365).default(30),
      }).parse(request.query);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const [totals, byAction, breakGlass, grants] = await Promise.all([
          client.query(
            `SELECT count(*)::int AS events,
                    count(*) FILTER (WHERE severity = 'alert')::int AS alerts,
                    count(DISTINCT actor_id)::int AS actors
               FROM luminary.audit_event
              WHERE occurred_at >= now() - make_interval(days => $1)`, [days]),
          client.query(
            `SELECT action, count(*)::int AS events
               FROM luminary.audit_event
              WHERE occurred_at >= now() - make_interval(days => $1)
              GROUP BY action ORDER BY events DESC LIMIT 10`, [days]),
          client.query(
            `SELECT actor_name, subject_name AS patient, detail AS reason, occurred_at
               FROM luminary.audit_event
              WHERE severity = 'alert'
                AND action = 'Break-glass access'
                AND occurred_at >= now() - make_interval(days => $1)
              ORDER BY occurred_at DESC LIMIT 20`, [days]),
          client.query(
            `SELECT count(*)::int AS live_grants
               FROM luminary.access_grant
              WHERE deleted_at IS NULL AND valid_until > now()`),
        ]);

        return {
          window: `${days} days`,
          totals: totals.rows[0],
          topActions: byAction.rows,
          breakGlass: breakGlass.rows,
          liveAccessGrants: grants.rows[0].live_grants,
        };
      });
    },
  });

  /** Everything one person did — the question asked after something goes wrong. */
  app.get('/audit/users/:id', {
    preHandler: requirePermission('reviewAudit'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { days } = z.object({
        days: z.coerce.number().int().min(1).max(365).default(30),
      }).parse(request.query);

      const actor = actorOf(request);
      return run(actor, async (client) => {
        const { rows } = await client.query(
          `SELECT occurred_at, action, subject_type, subject_name, detail, severity
             FROM luminary.audit_event
            WHERE actor_id = $1 AND occurred_at >= now() - make_interval(days => $2)
            ORDER BY occurred_at DESC
            LIMIT 500`,
          [id, days],
        );
        return rows;
      });
    },
  });
}
