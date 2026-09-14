import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requireIntegration } from '../../platform/integration.js';
import { requirePermission } from '../../platform/permissions.js';
import { agentService } from './agent.service.js';
import { Unauthorized } from '../../platform/errors.js';
import type { Actor } from '../billing/billing.service.js';

/**
 * The tool surface for a WhatsApp assistant.
 *
 * Every tool below takes a `conversationId` and **never a patient id**. The
 * patient was resolved from the phone number when the conversation opened, and
 * is read from the conversation on every call — so a patient who talks the
 * agent into naming somebody else changes nothing, because there is no
 * parameter for the agent to pass.
 *
 * Practical consequence for the workflow: call `POST /agent/conversations`
 * once per incoming message with the sender's number, then pass the id it
 * returns to every tool for that turn.
 */

const conversationRef = z.object({ conversationId: z.string().uuid() });

/** The agent's own retry key, so a repeated tool call is not a second booking. */
const idempotent = z.object({ requestKey: z.string().min(8).max(200).optional() });

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };

  /** Machine routes run in the credential's practice, never one named in a body. */
  const asAgent = <T>(request: FastifyRequest, work: Parameters<typeof withTenant<T>>[1]) => {
    const caller = request.integration;
    if (!caller) throw new Unauthorized();
    return withTenant<T>({ practiceId: caller.practiceId, userId: null }, work);
  };

  app.post('/agent/conversations', {
    preHandler: requireIntegration('agent:converse'),
    handler: async (request, reply) => {
      const body = z.object({
        channel: z.enum(['whatsapp', 'sms']).default('whatsapp'),
        from: z.string().min(5),
      }).parse(request.body);
      const caller = request.integration!;

      const result = await asAgent(request, (client) =>
        agentService.openConversation(client, { credentialId: caller.credentialId, ...body }));

      return reply.code(result.reused ? 200 : 201).send({
        conversationId: result.conversation.id,
        // The agent needs to know whether it is talking to somebody the
        // practice knows, and must be told plainly rather than inferring it.
        knownPatient: Boolean(result.conversation.patient_id),
        patientName: result.patientName ?? null,
        verification: result.conversation.verification,
        expiresAt: result.conversation.expires_at,
        ...(result.ambiguous
          ? { handOver: 'Two patients share this number — ask the practice to help.' }
          : {}),
      });
    },
  });

  app.post('/agent/verify/start', {
    preHandler: requireIntegration('agent:converse'),
    handler: async (request) => {
      const { conversationId } = conversationRef.parse(request.body);
      return asAgent(request, async (client) => {
        const conversation = await agentService.requireConversation(client, conversationId);
        return agentService.startVerification(client, conversation);
      });
    },
  });

  app.post('/agent/verify/confirm', {
    preHandler: requireIntegration('agent:converse'),
    handler: async (request) => {
      const { conversationId, code } = conversationRef
        .extend({ code: z.string().regex(/^\d{6}$/) })
        .parse(request.body);
      return asAgent(request, async (client) => {
        const conversation = await agentService.requireConversation(client, conversationId);
        return agentService.confirmVerification(client, conversation, code);
      });
    },
  });

  // --- scheduling ----------------------------------------------------------

  app.post('/agent/availability', {
    preHandler: requireIntegration('agent:schedule'),
    handler: async (request) => {
      const body = conversationRef.extend({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        providerId: z.string().uuid().optional(),
      }).parse(request.body);
      return asAgent(request, async (client) => {
        await agentService.requireConversation(client, body.conversationId);
        return agentService.availability(client, body);
      });
    },
  });

  app.post('/agent/appointments', {
    preHandler: requireIntegration('agent:schedule'),
    handler: async (request, reply) => {
      const body = conversationRef.merge(idempotent).extend({
        providerId: z.string().uuid(),
        startsAt: z.string().datetime({ offset: true }),
        durationMin: z.number().int().positive().max(240).optional(),
        visitType: z.string().max(120).optional(),
      }).parse(request.body);

      const result = await asAgent(request, async (client) => {
        const conversation = await agentService.requireConversation(client, body.conversationId);

        // A retried tool call returns what the first one did rather than
        // booking a second slot for the same person.
        if (body.requestKey) {
          const prior = await agentService.replay(client, conversation.id, body.requestKey);
          if (prior) return { appointment: { id: prior.subject_id }, replayed: true };
        }

        const appointment = await agentService.book(client, conversation, body);
        await agentService.logAction(client, {
          conversationId: conversation.id, tool: 'book', requestKey: body.requestKey,
          args: body, outcome: 'ok', subjectId: appointment.id,
        });
        return { appointment, replayed: false };
      });

      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  });

  app.post('/agent/appointments/reschedule', {
    preHandler: requireIntegration('agent:schedule'),
    handler: async (request) => {
      const body = conversationRef.merge(idempotent).extend({
        appointmentId: z.string().uuid(),
        startsAt: z.string().datetime({ offset: true }),
      }).parse(request.body);

      return asAgent(request, async (client) => {
        const conversation = await agentService.requireConversation(client, body.conversationId);
        if (body.requestKey) {
          const prior = await agentService.replay(client, conversation.id, body.requestKey);
          if (prior) return { appointmentId: prior.subject_id, replayed: true };
        }
        const moved = await agentService.reschedule(client, conversation, body);
        await agentService.logAction(client, {
          conversationId: conversation.id, tool: 'reschedule', requestKey: body.requestKey,
          args: body, outcome: 'ok', subjectId: body.appointmentId,
        });
        return { appointment: moved, replayed: false };
      });
    },
  });

  app.post('/agent/appointments/upcoming', {
    preHandler: requireIntegration('agent:schedule'),
    handler: async (request) => {
      const { conversationId } = conversationRef.parse(request.body);
      return asAgent(request, async (client) => {
        const conversation = await agentService.requireConversation(client, conversationId);
        return agentService.upcoming(client, conversation);
      });
    },
  });

  // --- intake and follow-up ------------------------------------------------

  app.post('/agent/intake', {
    preHandler: requireIntegration('agent:intake'),
    handler: async (request, reply) => {
      const body = conversationRef.extend({
        fields: z.array(z.object({
          field: z.string().min(1),
          value: z.string().min(1).max(400),
          // What the patient actually said. A reviewer judging the proposal
          // needs the sentence, not only the agent's reading of it.
          sourceText: z.string().max(1000).optional(),
        })).min(1).max(12),
      }).parse(request.body);

      const result = await asAgent(request, async (client) => {
        const conversation = await agentService.requireConversation(client, body.conversationId);
        return agentService.proposeIntake(client, conversation, body);
      });

      // 202: taken, not applied. The agent should tell the patient their
      // details have been passed on, never that they have been updated.
      return reply.code(202).send({
        ...result,
        applied: false,
        message: 'Passed to the practice for confirmation.',
      });
    },
  });

  app.post('/agent/status', {
    preHandler: requireIntegration('agent:status'),
    handler: async (request) => {
      const { conversationId } = conversationRef.parse(request.body);
      return asAgent(request, async (client) => {
        const conversation = await agentService.requireConversation(client, conversationId);
        return agentService.followUpStatus(client, conversation);
      });
    },
  });

  // --- the review queue, for staff ----------------------------------------

  app.get('/intake-proposals', {
    preHandler: requirePermission('editDemographics'),
    handler: async (request) => {
      const actor = actorOf(request);
      return withTenant({ practiceId: actor.practiceId, userId: actor.userId }, async (client) => {
        const { rows } = await client.query(
          `SELECT ip.*, p.full_name AS patient_name
             FROM luminary.intake_proposal ip
             JOIN luminary.patient p ON p.id = ip.patient_id
            WHERE ip.status = 'pending' AND ip.deleted_at IS NULL
            ORDER BY ip.created_at`,
        );
        return rows;
      });
    },
  });

  app.post('/intake-proposals/:id/review', {
    preHandler: requirePermission('editDemographics'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { accept } = z.object({ accept: z.boolean() }).parse(request.body);
      const actor = actorOf(request);

      return withTenant({ practiceId: actor.practiceId, userId: actor.userId }, async (client) => {
        const { rows } = await client.query(
          `UPDATE luminary.intake_proposal
              SET status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
            RETURNING *`,
          [id, accept ? 'accepted' : 'rejected', actor.userId],
        );
        const proposal = rows[0];
        if (!proposal) throw new Unauthorized('That proposal is no longer pending');

        if (accept) {
          /*
           * The column is whitelisted in the service before a proposal is ever
           * created, and re-checked here. Building an UPDATE from a value that
           * originated in a patient's text message is exactly the shape of a
           * SQL injection, so the field name never reaches the query as data
           * — it selects a fixed statement.
           */
          const COLUMNS: Record<string, string> = {
            phone: 'phone', alt_phone: 'alt_phone', email: 'email',
            address_line: 'address_line', city: 'city',
            preferred_contact: 'preferred_contact',
            emergency_name: 'emergency_name', emergency_phone: 'emergency_phone',
            scheme_member_no: 'scheme_member_no',
          };
          const column = COLUMNS[proposal.field];
          if (!column) throw new Unauthorized(`${proposal.field} cannot be updated this way`);

          await client.query(
            `UPDATE luminary.patient SET ${column} = $2, updated_at = now() WHERE id = $1`,
            [proposal.patient_id, proposal.proposed_value],
          );
          await client.query(
            `SELECT luminary.write_audit('Accepted an assistant proposal', 'patient', $1, $2, $3, 'notice')`,
            [proposal.patient_id, proposal.field, `${proposal.current_value ?? 'empty'} to ${proposal.proposed_value}`],
          );
        }

        return proposal;
      });
    },
  });
}
