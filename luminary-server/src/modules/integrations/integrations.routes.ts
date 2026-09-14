import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { requireIntegration } from '../../platform/integration.js';
import { integrationsService } from './integrations.service.js';
import { messagingService } from '../messaging/messaging.service.js';
import { Unauthorized } from '../../platform/errors.js';
import type { Actor } from '../billing/billing.service.js';

/**
 * Endpoints an n8n WhatsApp workflow talks to.
 *
 * The shape of the integration, end to end:
 *
 *   outbound   Luminary → n8n     the dispatcher POSTs queued messages to the
 *                                 practice's webhook, signed (already existed)
 *   status     n8n → Luminary     POST /integrations/messages/status
 *   inbound    n8n → Luminary     POST /integrations/messages/inbound
 *   send       n8n → Luminary     POST /integrations/messages  (queue one)
 *
 * The three inbound routes authenticate with a signed integration credential
 * rather than a session, and each requires its own scope — so a workflow that
 * only reports delivery cannot also queue messages, and neither can read a
 * chart. Nothing here is reachable with a user's bearer token, and nothing a
 * user can reach is available with a workflow key.
 */

const isoish = z.string().datetime({ offset: true }).optional();

const inboundBody = z.object({
  channel: z.enum(['whatsapp', 'sms', 'email']).default('whatsapp'),
  from: z.string().min(5),
  body: z.string().min(1),
  // The carrier's own id. Required, because it is the idempotency key — without
  // it a redelivery becomes a second copy of the patient's message.
  providerRef: z.string().min(1),
  mediaUrl: z.string().url().optional(),
  receivedAt: isoish,
  raw: z.unknown().optional(),
});

const statusBody = z.object({
  messageId: z.string().uuid().optional(),
  providerRef: z.string().min(1).optional(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  detail: z.string().max(500).optional(),
  occurredAt: isoish,
}).refine((v) => v.messageId || v.providerRef, {
  message: 'Give either messageId or providerRef so the message can be found',
});

const sendBody = z.object({
  patientId: z.string().uuid().optional(),
  appointmentId: z.string().uuid().optional(),
  to: z.string().min(5),
  channel: z.enum(['whatsapp', 'sms', 'email']).default('whatsapp'),
  body: z.string().min(1).max(4096),
  template: z.string().optional(),
});

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(actor: { practiceId: string; userId: string | null }, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: actor.practiceId, userId: actor.userId }, work);

  /*
   * Machine routes run in the practice the *credential* belongs to, never one
   * named in the payload. A webhook body is attacker-controlled; the credential
   * is not, so tenancy is derived from the thing that was actually verified.
   */
  const asIntegration = <T>(request: FastifyRequest, work: Parameters<typeof withTenant<T>>[1]) => {
    const caller = request.integration;
    if (!caller) throw new Unauthorized();
    return withTenant<T>({ practiceId: caller.practiceId, userId: null }, work);
  };

  // --- machine endpoints ---------------------------------------------------

  app.post('/integrations/messages/inbound', {
    preHandler: requireIntegration('messaging:inbound'),
    handler: async (request, reply) => {
      const body = inboundBody.parse(request.body);
      const result = await asIntegration(request, (client) =>
        integrationsService.recordInbound(client, body));

      // 200 rather than 201 on a redelivery, and never an error: a workflow
      // that gets a 4xx will retry for ever or alert a human about something
      // that is working correctly.
      return reply.code(result.duplicate ? 200 : 201).send({
        id: result.message.id,
        duplicate: result.duplicate,
        matchedPatient: result.matchedPatient
          ? { id: result.matchedPatient.id, name: result.matchedPatient.full_name }
          : null,
        // Told plainly, so a workflow can route unmatched messages to a human
        // queue instead of assuming everything landed in a chart.
        needsTriage: !result.message.patient_id,
      });
    },
  });

  app.post('/integrations/messages/status', {
    preHandler: requireIntegration('messaging:status'),
    handler: async (request) => {
      const body = statusBody.parse(request.body);
      const result = await asIntegration(request, (client) =>
        integrationsService.recordReceipt(client, body));
      return {
        messageId: result.message.id,
        status: result.message.status,
        // False when a late callback arrived after a later status. Not an
        // error — carriers deliver out of order — but worth reporting.
        applied: result.applied,
      };
    },
  });

  app.post('/integrations/messages', {
    preHandler: requireIntegration('messaging:send'),
    handler: async (request, reply) => {
      const body = sendBody.parse(request.body);
      const caller = request.integration!;
      const message = await asIntegration(request, (client) =>
        messagingService.queueFromIntegration(client, {
          ...body, credentialId: caller.credentialId,
        }));
      return reply.code(201).send({ id: message.id, status: message.status });
    },
  });

  // --- credential management, for people ----------------------------------

  app.get('/integrations/credentials', {
    preHandler: requirePermission('manageIntegrations'),
    handler: async (request) => {
      const actor = actorOf(request);
      return run(actor, (client) => integrationsService.listCredentials(client, actor));
    },
  });

  app.post('/integrations/credentials', {
    preHandler: requirePermission('manageIntegrations'),
    handler: async (request, reply) => {
      const body = z.object({
        name: z.string().min(1),
        scopes: z.array(z.string()).min(1),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const created = await run(actor, (client) =>
        integrationsService.createCredential(client, actor, body));
      return reply.code(201).send(created);
    },
  });

  app.delete('/integrations/credentials/:id', {
    preHandler: requirePermission('manageIntegrations'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => integrationsService.revokeCredential(client, actor, id));
    },
  });

  // --- the inbox, for staff ------------------------------------------------

  app.get('/messages/inbound', async (request) => {
    const query = z.object({
      unhandledOnly: z.coerce.boolean().default(false),
      patientId: z.string().uuid().optional(),
    }).parse(request.query);
    const actor = actorOf(request);
    return run(actor, (client) => integrationsService.listInbound(client, actor, query));
  });

  app.post('/messages/inbound/:id/handled', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { patientId } = z.object({ patientId: z.string().uuid().optional() }).parse(request.body ?? {});
    const actor = actorOf(request);
    return run(actor, (client) => integrationsService.markHandled(client, actor, id, patientId));
  });
}
