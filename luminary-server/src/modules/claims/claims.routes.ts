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
const attachmentType = z.enum([
  'preauthorization', 'prescription', 'laboratory_request', 'laboratory_result',
  'radiology_request', 'radiology_report', 'pathology_report', 'referral',
  'clinical_motivation', 'operation_note', 'anaesthetic_record', 'implant_device',
  'hospital_breakdown', 'discharge_document', 'accident_report', 'consent',
  'proof_of_payment', 'clinical_support', 'other',
]);
const emailDraftBody = z.object({
  destinationId: z.string().uuid().nullable().optional(),
  memberEmail: z.string().trim().email().or(z.literal('')),
  providerEmail: z.string().trim().email().or(z.literal('')),
  claimForm: z.string().trim().max(240),
  followUpDays: z.coerce.number().int().min(1).max(30),
  memberSubject: z.string().trim().max(240),
  memberBody: z.string().trim().max(10000),
  insurerSubject: z.string().trim().max(240),
  insurerBody: z.string().trim().max(10000),
  requiredDocuments: z.array(z.string().trim().min(1).max(160)).max(30),
  attachments: z.array(z.union([
    z.string().trim().min(1).max(240),
    z.object({
      id: z.string().optional(), documentId: z.string().optional(),
      name: z.string().optional(), filename: z.string().optional(),
      attachmentType: z.string().optional(),
    }).passthrough(),
  ])).max(50),
});

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

  app.get('/claims/:id/preparation-context', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.preparationContext(client, actor, id));
    },
  });

  app.put('/claims/:id/preparation', {
    preHandler: requirePermission('editClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      const body = z.object({
        encounterId: z.string().uuid().nullable().optional(),
        membershipNumber: z.string().trim().max(120),
        memberSuffix: z.string().trim().max(40).nullable().optional(),
        relationshipToMember: z.string().trim().max(80).nullable().optional(),
        serviceFromDate: date.nullable().optional(),
        serviceToDate: date.nullable().optional(),
        notes: z.string().max(1000).nullable().optional(),
        supportingInfo: z.object({
          preAuthorization: z.object({
            number: z.string().trim().max(120), type: z.string().trim().max(120),
            validFrom: date.or(z.literal('')), validTo: date.or(z.literal('')),
            approvedService: z.string().trim().max(500),
          }),
          referral: z.object({
            provider: z.string().trim().max(180), registrationNumber: z.string().trim().max(120),
            date: date.or(z.literal('')), reason: z.string().trim().max(1000),
          }),
          clinicalMotivation: z.string().trim().max(4000),
          event: z.object({
            kind: z.enum(['none', 'accident', 'work_related', 'third_party']),
            date: date.or(z.literal('')), location: z.string().trim().max(240),
            reference: z.string().trim().max(160), description: z.string().trim().max(1000),
          }),
          admission: z.object({
            facility: z.string().trim().max(240), admittedOn: date.or(z.literal('')),
            dischargedOn: date.or(z.literal('')),
          }),
          otherCover: z.object({
            payer: z.string().trim().max(180), memberNumber: z.string().trim().max(120),
            policyNumber: z.string().trim().max(120),
          }),
          consent: z.object({
            releaseInformation: z.boolean(), assignmentOfBenefits: z.boolean(),
            patientSignature: z.boolean(), signedOn: date.or(z.literal('')),
          }),
          procedures: z.array(z.object({
            code: z.string().trim().max(80), description: z.string().trim().max(500),
            date: date.or(z.literal('')), deviceIdentifier: z.string().trim().max(180),
          })).max(30),
        }),
        diagnoses: z.array(z.object({
          code: z.string().trim().min(1).max(30),
          description: z.string().trim().max(240).optional(),
          kind: z.enum(['primary', 'secondary']),
        })).max(30),
        lines: z.array(z.object({
          id: z.string().uuid(),
          tariffCode: z.string().trim().max(80),
          tariffDescription: z.string().trim().max(240).optional(),
          practitionerId: z.string().uuid().nullable().optional(),
          serviceDate: date.nullable().optional(),
        })).min(1),
        attachments: z.array(z.object({
          documentId: z.string().uuid(),
          attachmentType,
          reason: z.string().trim().min(5).max(500),
        })).max(50),
      }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.savePreparation(client, actor, id, body));
    },
  });

  app.post('/claims/:id/email-draft/start', {
    preHandler: requirePermission('editClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.startEmailDraft(client, actor, id));
    },
  });

  app.get('/claims/:id/email-destinations', {
    preHandler: requirePermission('readClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.emailDestinations(client, actor, id));
    },
  });

  app.put('/claims/:id/email-draft', {
    preHandler: requirePermission('editClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = emailDraftBody.parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.saveEmailDraft(client, actor, id, body));
    },
  });

  app.post('/claims/:id/email-draft/prepare', {
    preHandler: requirePermission('editClaims'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => claimsService.prepareEmailDraft(client, actor, id));
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
        attachmentType,
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
