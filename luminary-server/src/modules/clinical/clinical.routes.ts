import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { clinicalService, type Actor } from './clinical.service.js';
import { dictationService } from './dictation.js';
import { Unauthorized } from '../../platform/errors.js';

const diagnosis = z.object({ code: z.string().min(1), label: z.string().min(1) });
const documentBody = z.object({
  encounterId: z.string().uuid().nullable().optional(),
  kind: z.string().min(1).max(60).optional(),
  filename: z.string().min(1).max(180),
  contentType: z.string().min(1).max(120),
  byteSize: z.number().int().positive().max(25 * 1024 * 1024),
  dataBase64: z.string().min(1),
  notes: z.string().max(500).optional(),
});
const archiveDocumentBody = z.object({
  reason: z.string().max(240).optional(),
});
const patientParams = z.object({ id: z.string().uuid() });
const idParams = z.object({ id: z.string().uuid() });
const labBody = z.object({
  encounterId: z.string().uuid().nullable().optional(),
  orderId: z.string().uuid().nullable().optional(),
  testName: z.string().min(1),
  value: z.string().optional(),
  unit: z.string().optional(),
  normalRange: z.string().optional(),
  abnormal: z.boolean().optional(),
  resultedOn: z.string().optional(),
});
const carePlanBody = z.object({
  encounterId: z.string().uuid().nullable().optional(),
  name: z.string().min(1),
  goals: z.array(z.string().min(1)).optional(),
  interventions: z.array(z.string().min(1)).optional(),
  nextReview: z.string().optional(),
});
const carePlanPatch = z.object({
  status: z.enum(['active', 'completed', 'paused', 'cancelled']).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  goals: z.array(z.string().min(1)).optional(),
  interventions: z.array(z.string().min(1)).optional(),
  nextReview: z.string().nullable().optional(),
});
const referralBody = z.object({
  encounterId: z.string().uuid().nullable().optional(),
  referredTo: z.string().min(1),
  specialty: z.string().optional(),
  reason: z.string().min(1),
  urgency: z.enum(['routine', 'urgent', 'emergency']).default('routine'),
  notes: z.string().max(1000).optional(),
});
const referralPatch = z.object({
  status: z.enum(['draft', 'sent', 'accepted', 'completed', 'cancelled']),
});
const dictationDraft = z.object({
  subjective: z.string().nullable().default(null),
  objective: z.string().nullable().default(null),
  assessment: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  followUp: z.string().nullable().default(null),
  diagnosesMentioned: z.array(z.object({
    code: z.string().min(1),
    label: z.string().min(1),
    sourceText: z.string().optional(),
  })).default([]),
  medicationsMentioned: z.array(z.object({
    drug: z.string().min(1),
    strength: z.string().nullable().optional(),
    route: z.string().nullable().optional(),
    frequency: z.string().nullable().optional(),
    durationDays: z.number().nullable().optional(),
    sourceText: z.string().optional(),
  })).default([]),
  uncertainties: z.array(z.object({
    text: z.string().min(1),
    reason: z.string().min(1),
  })).default([]),
});

export async function clinicalRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId, registrationLapsed } = request.session;
    return { userId, role, practiceId, registrationLapsed };
  };
  const run = <T>(a: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: a.practiceId, userId: a.userId }, work);

  app.get('/patients/:id/encounters', {
    preHandler: requirePermission('viewClinicalNotes'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.listForPatient(client, actor, id));
    },
  });

  app.get('/patients/:id/clinical-summary', {
    preHandler: requirePermission('viewClinicalNotes'),
    handler: async (request) => {
      const { id } = patientParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.listClinicalSummary(client, actor, id));
    },
  });

  app.post('/patients/:id/lab-results', {
    preHandler: requirePermission('writeNote'),
    handler: async (request, reply) => {
      const { id } = patientParams.parse(request.params);
      const body = labBody.parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) =>
        clinicalService.createLabResult(client, actor, { patientId: id, ...body }),
      );
      return reply.code(201).send(result);
    },
  });

  app.post('/lab-results/:id/review', {
    preHandler: requirePermission('writeNote'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.reviewLabResult(client, actor, id));
    },
  });

  app.post('/patients/:id/care-plans', {
    preHandler: requirePermission('writeNote'),
    handler: async (request, reply) => {
      const { id } = patientParams.parse(request.params);
      const body = carePlanBody.parse(request.body);
      const actor = actorOf(request);
      const plan = await run(actor, (client) =>
        clinicalService.createCarePlan(client, actor, { patientId: id, ...body }),
      );
      return reply.code(201).send(plan);
    },
  });

  app.patch('/care-plans/:id', {
    preHandler: requirePermission('writeNote'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = carePlanPatch.parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.updateCarePlan(client, actor, id, body));
    },
  });

  app.post('/patients/:id/referrals', {
    preHandler: requirePermission('writeNote'),
    handler: async (request, reply) => {
      const { id } = patientParams.parse(request.params);
      const body = referralBody.parse(request.body);
      const actor = actorOf(request);
      const referral = await run(actor, (client) =>
        clinicalService.createReferral(client, actor, { patientId: id, ...body }),
      );
      return reply.code(201).send(referral);
    },
  });

  app.patch('/referrals/:id', {
    preHandler: requirePermission('writeNote'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const { status } = referralPatch.parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.updateReferral(client, actor, id, status));
    },
  });

  app.get('/encounters/:id', {
    preHandler: requirePermission('viewClinicalNotes'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.get(client, actor, id));
    },
  });

  app.get('/patients/:id/documents', {
    preHandler: requirePermission('viewClinicalNotes'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.listDocuments(client, actor, id));
    },
  });

  app.post('/patients/:id/documents', {
    preHandler: requirePermission('writeNote'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = documentBody.parse(request.body);
      const actor = actorOf(request);
      const doc = await run(actor, (client) =>
        clinicalService.uploadDocument(client, actor, { patientId: id, ...body }),
      );
      return reply.code(201).send(doc);
    },
  });

  app.get('/documents/:id/download', {
    preHandler: requirePermission('viewClinicalNotes'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      const doc = await run(actor, (client) => clinicalService.documentForDownload(client, actor, id));
      doc.stream.on('error', (error: Error) => {
        request.log.error({ err: error, documentId: id }, 'document stream failed');
        if (!reply.sent) {
          void reply.code(409).send({
            error: 'conflict',
            message: 'Document bytes are not available on this node',
          });
        } else {
          reply.raw.destroy(error);
        }
      });
      return reply
        .type(doc.content_type)
        .header('Content-Length', String(doc.byte_size))
        .header('Content-Disposition', `attachment; filename="${String(doc.filename).replace(/"/g, '')}"`)
        .send(doc.stream);
    },
  });

  app.post('/documents/:id/archive', {
    preHandler: requirePermission('writeNote'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = archiveDocumentBody.parse(request.body ?? {});
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.archiveDocument(client, actor, id, body.reason));
    },
  });

  app.post('/encounters', {
    preHandler: requirePermission('writeNote'),
    handler: async (request, reply) => {
      const body = z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().nullable().optional(),
        noteType: z.string().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const note = await run(actor, (client) => clinicalService.createDraft(client, actor, body));
      return reply.code(201).send(note);
    },
  });

  app.put('/encounters/:id', {
    preHandler: requirePermission('writeNote'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        note_type: z.string().optional(),
        subjective: z.string().optional(),
        objective: z.string().optional(),
        assessment: z.string().optional(),
        plan: z.string().optional(),
        follow_up: z.string().optional(),
        follow_up_required: z.boolean().optional(),
        follow_up_scheduled_for: z.string().datetime({ offset: true }).nullable().optional(),
        diagnoses: z.array(diagnosis).optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.saveDraft(client, actor, id, body));
    },
  });

  app.put('/encounters/:id/vitals', {
    preHandler: requirePermission('recordVitals'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const vitals = z.record(z.union([z.string(), z.number()])).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.recordVitals(client, actor, id, vitals));
    },
  });

  app.post('/encounters/:id/triage-complete', {
    preHandler: requirePermission('writeNote'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => clinicalService.completeTriage(client, actor, id));
    },
  });

  // A signature is its own resource: it is an act, not a field being edited.
  app.post('/encounters/:id/signature', {
    preHandler: requirePermission('signNote'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      const signed = await run(actor, (client) => clinicalService.sign(client, actor, id));
      return reply.code(201).send(signed);
    },
  });

  app.post('/encounters/:id/addenda', {
    preHandler: requirePermission('amendNote'),
    handler: async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { body } = z.object({ body: z.string().min(10) }).parse(request.body);
      const actor = actorOf(request);
      const addendum = await run(actor, (client) => clinicalService.addAddendum(client, actor, id, body));
      return reply.code(201).send(addendum);
    },
  });

  app.post('/encounters/:id/dictations', {
    preHandler: requirePermission('prescribe'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ transcript: z.string().min(12).max(12000) }).parse(request.body);
      const actor = actorOf(request);
      const dictation = await run(actor, (client) =>
        dictationService.createFromTranscript(client, actor, id, body.transcript),
      );
      return reply.code(201).send(dictation);
    },
  });

  app.post('/encounters/:id/dictations/audio', {
    preHandler: requirePermission('prescribe'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        audioBase64: z.string().min(1).max(36 * 1024 * 1024),
        contentType: z.string().min(1).max(120),
      }).parse(request.body);
      const actor = actorOf(request);
      const dictation = await run(actor, (client) =>
        dictationService.createFromAudio(client, actor, id, body.audioBase64, body.contentType),
      );
      return reply.code(201).send(dictation);
    },
  });

  app.get('/dictations/:id', {
    preHandler: requirePermission('prescribe'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => dictationService.get(client, actor, id));
    },
  });

  app.post('/dictations/:id/structure', {
    preHandler: requirePermission('prescribe'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => dictationService.structure(client, actor, id));
    },
  });

  app.patch('/dictations/:id/draft', {
    preHandler: requirePermission('prescribe'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = dictationDraft.parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => dictationService.updateDraft(client, actor, id, body));
    },
  });

  app.post('/dictations/:id/approve-note', {
    preHandler: requirePermission('prescribe'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        subjective: z.string().nullable().optional(),
        objective: z.string().nullable().optional(),
        assessment: z.string().nullable().optional(),
        plan: z.string().nullable().optional(),
        followUp: z.string().nullable().optional(),
        diagnoses: z.array(diagnosis).optional(),
      }).parse(request.body ?? {});
      const actor = actorOf(request);
      return run(actor, (client) => dictationService.approveNote(client, actor, id, body));
    },
  });

  app.post('/dictations/:id/approve-prescription', {
    preHandler: requirePermission('prescribe'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({
        drug: z.string().min(1),
        strength: z.string().nullable().optional(),
        route: z.string().nullable().optional(),
        frequency: z.string().nullable().optional(),
        durationDays: z.number().int().positive().nullable().optional(),
        allergiesReviewed: z.boolean().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) =>
        dictationService.approvePrescription(client, actor, id, body),
      );
      return reply.code(201).send(result);
    },
  });

  app.post('/prescriptions', {
    preHandler: requirePermission('prescribe'),
    handler: async (request, reply) => {
      const body = z.object({
        patientId: z.string().uuid(),
        encounterId: z.string().uuid().nullable().optional(),
        drug: z.string().min(1),
        strength: z.string().optional(),
        route: z.string().optional(),
        frequency: z.string().optional(),
        durationDays: z.number().int().positive().optional(),
        refills: z.number().int().min(0).max(12).optional(),
        pharmacy: z.string().optional(),
        allergiesReviewed: z.boolean().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const rx = await run(actor, (client) => clinicalService.prescribe(client, actor, body));
      return reply.code(201).send(rx);
    },
  });
}
