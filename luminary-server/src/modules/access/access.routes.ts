import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { can, requirePermission, type Role } from '../../platform/permissions.js';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../../platform/errors.js';
import { requirePatientInTenant, requireUserInTenant } from '../../platform/tenant-refs.js';

/**
 * Access grants and their review.
 *
 * Layer 3 of the access model: role decides *what kind* of action, this decides
 * *for whom*. A grant is time-bounded and carries a reason, because ownership
 * cannot express "cover this list for two weeks" and an untraceable permission
 * is indistinguishable from a mistake.
 *
 * The review endpoints matter as much as the granting ones. Break-glass is only
 * a control if somebody actually looks at it; unreviewed, it is a formality that
 * teaches staff the reason box is a nuisance rather than a record.
 */

interface Actor { userId: string; role: Role; practiceId: string }

export async function accessRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(a: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: a.practiceId, userId: a.userId }, work);

  app.get('/access-grants', {
    preHandler: requirePermission('manageCover'),
    handler: async (request) => {
      const { includeExpired } = z.object({
        includeExpired: z.coerce.boolean().default(false),
      }).parse(request.query);
      const actor = actorOf(request);

      return run(actor, async (client) => {
        const { rows } = await client.query(
          `SELECT g.id, g.kind, g.reason, g.valid_from, g.valid_until,
                  (g.valid_until > now()) AS live,
                  holder.display_name AS holder, holder.id AS holder_id,
                  p.full_name AS patient, p.reference AS patient_reference,
                  granter.display_name AS granted_by
             FROM luminary.access_grant g
             JOIN luminary.app_user holder ON holder.id = g.user_id
             JOIN luminary.patient p ON p.id = g.patient_id
             LEFT JOIN luminary.app_user granter ON granter.id = g.granted_by
            WHERE g.deleted_at IS NULL
              AND ($1::boolean OR g.valid_until > now())
            ORDER BY g.valid_until DESC`,
          [includeExpired],
        );
        return rows;
      });
    },
  });

  /**
   * Covering and referral grants, issued by a manager or administrator.
   *
   * Break-glass is deliberately NOT creatable here — it is granted by the
   * clinician to themselves at the moment of need, via the patient endpoint,
   * with the friction and the alert-level audit entry that implies. Letting an
   * administrator mint one in advance would remove exactly the accountability
   * that makes it acceptable.
   */
  app.post('/access-grants', {
    preHandler: requirePermission('manageCover'),
    handler: async (request, reply) => {
      const body = z.object({
        userId: z.string().uuid(),
        patientId: z.string().uuid(),
        kind: z.enum(['covering', 'referral']),
        reason: z.string().min(10, 'Give a fuller reason'),
        validUntil: z.string().datetime({ offset: true }),
      }).parse(request.body);

      const actor = actorOf(request);
      if (new Date(body.validUntil) <= new Date()) {
        throw new BadRequest('A grant that has already expired confers nothing');
      }

      return run(actor, async (client) => {
        const holder = await requireUserInTenant(client, body.userId);
        await requirePatientInTenant(client, body.patientId);
        if (!holder.active) throw new BadRequest(`${holder.display_name} is deactivated`);

        const { rows } = await client.query(
          `INSERT INTO luminary.access_grant
             (practice_id, user_id, patient_id, kind, reason, granted_by, valid_until)
           VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [body.userId, body.patientId, body.kind, body.reason.trim(), actor.userId, body.validUntil],
        );
        await client.query(
          `SELECT luminary.write_audit('Granted access', 'user', $1, $2, $3, 'notice')`,
          [body.userId, holder.display_name, `${body.kind}: ${body.reason.trim()}`],
        );
        return reply.code(201).send(rows[0]);
      });
    },
  });

  /** Ends a grant early — a tombstone, so the fact it existed survives. */
  app.delete('/access-grants/:id', {
    preHandler: requirePermission('manageCover'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);

      await run(actor, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE luminary.access_grant SET deleted_at = now()
            WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        if (rowCount === 0) throw new NotFound('Grant not found');
        await client.query(
          `SELECT luminary.write_audit('Revoked access grant', 'grant', $1, NULL, NULL, 'notice')`,
          [id],
        );
      });
      return reply.code(204).send();
    },
  });

  /**
   * The break-glass review queue.
   *
   * Every access taken without a standing relationship, newest first, so a
   * manager can ask the obvious question while people still remember the day.
   */
  app.get('/access-grants/break-glass', {
    preHandler: requirePermission('reviewAudit'),
    handler: async (request) => {
      const { since } = z.object({ since: z.string().optional() }).parse(request.query);
      const actor = actorOf(request);

      return run(actor, async (client) => {
        const { rows } = await client.query(
          `SELECT a.occurred_at, a.actor_name, a.subject_name AS patient, a.detail AS reason,
                  a.action
             FROM luminary.audit_event a
            WHERE a.severity = 'alert'
              AND a.action IN ('Break-glass access', 'Chart access without relationship')
              AND ($1::timestamptz IS NULL OR a.occurred_at >= $1::timestamptz)
            ORDER BY a.occurred_at DESC
            LIMIT 200`,
          [since ?? null],
        );
        return rows;
      });
    },
  });

  /** Why the caller may see this patient — the same answer the chart banner shows. */
  app.get('/patients/:id/relationship', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actor = actorOf(request);
    if (!can(actor.role, 'viewPatientDirectory')) {
      throw new Forbidden('Your role does not include patient access');
    }
    return run(actor, async (client) => {
      const { rows } = await client.query(
        `SELECT luminary.care_relationship($1, $2) AS relationship`,
        [actor.userId, id],
      );
      return {
        relationship: rows[0]?.relationship ?? null,
        requiresBreakGlass: rows[0]?.relationship === null,
      };
    });
  });
}
