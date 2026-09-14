import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requireIntegration } from '../../platform/integration.js';
import { requirePermission } from '../../platform/permissions.js';
import { Unauthorized } from '../../platform/errors.js';
import { claimsService, type Actor } from './claims.service.js';

const channel = z.enum(['NH263', 'EMAIL_PDF', 'MANUAL']);
const idParams = z.object({ id: z.string().uuid() });
const remittanceParams = z.object({ id: z.string().uuid(), remittanceId: z.string().uuid() });

export async function claimsRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(actor: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: actor.practiceId, userId: actor.userId }, work);

  app.get('/claims', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const query = z.object({
        patientId: z.string().uuid().optional(),
        payerId: z.string().uuid().optional(),
        invoiceId: z.string().uuid().optional(),
        status: z.string().optional(),
        query: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }).parse(request.query);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.list(client, actor, query));
    },
  });

  app.post('/claims', {
    preHandler: requirePermission('createClaims'),
    handler: async (request, reply) => {
      const body = z.object({
        invoiceId: z.string().uuid(),
        encounterId: z.string().uuid().nullable().optional(),
        submissionChannel: channel.default('MANUAL'),
        notes: z.string().max(1000).optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const claim = await run(actor, (client) => claimsService.create(client, actor, body));
      return reply.code(201).send(claim);
    },
  });

  app.get('/claims/configuration', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.configuration(client, actor));
    },
  });

  app.get('/claims/:id', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.get(client, actor, id));
    },
  });

  app.patch('/claims/:id', {
    preHandler: requirePermission('editClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        submissionChannel: channel.optional(),
        notes: z.string().max(1000).nullable().optional(),
        membershipNumber: z.string().min(1).optional(),
        memberSuffix: z.string().nullable().optional(),
        relationshipToMember: z.string().nullable().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.update(client, actor, id, body));
    },
  });

  app.post('/claims/:id/validate', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const { submissionChannel } = z.object({ submissionChannel: channel.optional() }).parse(request.body ?? {});
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.validate(client, actor, id, submissionChannel));
    },
  });

  app.post('/claims/:id/submit', {
    preHandler: requirePermission('submitClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        submissionChannel: channel.optional(),
        idempotencyKey: z.string().min(8).max(200).optional(),
      }).parse(request.body ?? {});
      const actor = actorOf(request);
      return run(actor, (client) =>
        claimsService.submit(client, actor, id, {
          channel: body.submissionChannel,
          idempotencyKey: body.idempotencyKey,
        }),
      );
    },
  });

  app.post('/claims/:id/refresh-status', {
    preHandler: requirePermission('refreshClaimStatus'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.refreshStatus(client, actor, id));
    },
  });

  app.get('/claims/:id/events', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.events(client, actor, id));
    },
  });

  app.get('/claims/:id/transmissions', {
    preHandler: requirePermission('viewClaimTransmissions'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.transmissions(client, actor, id));
    },
  });

  app.get('/claims/:id/adjudication', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.adjudication(client, actor, id));
    },
  });

  app.post('/claims/:id/adjudication', {
    preHandler: requirePermission('submitClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        result: z.enum(['APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'QUERY']),
        payerReference: z.string().optional(),
        notes: z.string().max(1000).optional(),
        lines: z.array(z.object({
          lineId: z.string().uuid(),
          approvedAmount: z.number().finite().nonnegative().optional(),
          rejectedAmount: z.number().finite().nonnegative().optional(),
          memberLiability: z.number().finite().nonnegative().optional(),
          insurerLiability: z.number().finite().nonnegative().optional(),
          reasonCode: z.string().optional(),
          reasonDescription: z.string().optional(),
        })).optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.recordAdjudication(client, actor, id, body));
    },
  });

  app.get('/claims/:id/remittances', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.listRemittances(client, actor, id));
    },
  });

  app.post('/claims/:id/remittances', {
    preHandler: requirePermission('submitClaims'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        payerId: z.string().uuid().nullable().optional(),
        remittanceReference: z.string().trim().min(3).max(160),
        paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        paymentAmount: z.number().finite().nonnegative(),
        currency: z.string().length(3),
        reconciliationStatus: z.enum(['unmatched','matched','partially_matched','reconciled','exception']).optional(),
        details: z.unknown().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const remittance = await run(actor, (client) => claimsService.createRemittance(client, actor, id, body));
      return reply.code(201).send(remittance);
    },
  });

  app.get('/claims/:id/remittances/:remittanceId', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id, remittanceId } = remittanceParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.getRemittance(client, actor, id, remittanceId));
    },
  });

  app.post('/claims/:id/denial-dispositions', {
    preHandler: requirePermission('adjustBalance'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        disposition: z.enum(['PATIENT_RESPONSIBILITY', 'WRITE_OFF', 'APPEAL', 'RESUBMIT']),
        amount: z.number().finite().positive(),
        reason: z.string().trim().min(10),
        claimLineId: z.string().uuid().nullable().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const disposition = await run(actor, (client) => claimsService.recordDenialDisposition(client, actor, id, body));
      return reply.code(201).send(disposition);
    },
  });

  app.post('/claims/:id/attachments', {
    preHandler: requirePermission('manageClaimAttachments'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        documentId: z.string().uuid(),
        attachmentType: z.enum([
          'prescription', 'laboratory_request', 'radiology_request', 'referral',
          'hospital_breakdown', 'discharge_document', 'clinical_support', 'other',
        ]),
        reason: z.string().min(5).max(500),
      }).parse(request.body);
      const actor = actorOf(request);
      const attachment = await run(actor, (client) => claimsService.addAttachment(client, actor, id, body));
      return reply.code(201).send(attachment);
    },
  });

  // Compatibility for the current frontend buttons while the richer UI moves
  // to /submit and /refresh-status.
  app.post('/claims/:id/biometric', {
    preHandler: requirePermission('captureBiometric'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const { biometricRef } = z.object({ biometricRef: z.string().optional() }).parse(request.body ?? {});
      const actor = actorOf(request);
      return run(actor, async (client) => {
        const claim = await claimsService.get(client, actor, id);
        await client.query(
          `UPDATE luminary.claim
              SET status = 'READY_FOR_SUBMISSION',
                  validation_result = jsonb_set(validation_result, '{warnings}', validation_result->'warnings' || jsonb_build_array(jsonb_build_object('code','BIOMETRIC_CAPTURED','message','Biometric captured at desk','ref',$2::text)),
                  updated_at = now()
            WHERE id = $1`,
          [id, biometricRef ?? null],
        );
        return { ...claim, status: 'READY_FOR_SUBMISSION', biometric_ref: biometricRef ?? null };
      });
    },
  });

  app.post('/claims/:id/submission', {
    preHandler: requirePermission('submitClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const { switchRef } = z.object({ switchRef: z.string().optional() }).parse(request.body ?? {});
      const actor = actorOf(request);
      return run(actor, (client) =>
        claimsService.submit(client, actor, id, { channel: switchRef ? 'NH263' : undefined, switchRef }),
      );
    },
  });

  app.post('/integrations/nh263/webhook', {
    preHandler: requireIntegration('claims:status'),
    handler: async (_request) => ({
      accepted: false,
      message: 'NH263 webhook shape and signature verification are pending official documentation.',
    }),
  });
}
