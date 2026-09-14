import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { patientsService, type Actor } from './patients.service.js';

/**
 * HTTP surface for patients.
 *
 * Routes do three things and nothing else: validate input, resolve the actor
 * from the session, and delegate. No business rule and no SQL lives here, so a
 * second transport later — the sync worker, a scheduled job — reuses the
 * service without inheriting anything HTTP-shaped.
 */

const todayDate = () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const dateOnly = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => value <= todayDate(), 'Date of birth cannot be in the future');

const createBody = z.object({
  reference: z.string().min(1),
  fullName: z.string().min(1).refine((v) => v.trim().includes(' '), 'Enter both first and last name'),
  dateOfBirth: dateOnly,
  sex: z.string().min(1),
  nationalId: z.string().optional().nullable(),
  phone: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
  addressCity: z.string().min(1),
  emergencyName: z.string().min(1),
  emergencyRelation: z.string().optional(),
  emergencyPhone: z.string().min(1),
  schemeId: z.string().uuid().nullable().optional(),
  memberNumber: z.string().optional(),
  principalMember: z.string().optional(),
  dependantCode: z.string().optional(),
  coverEffectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  coverValidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  coverStatus: z.string().optional(),
  primaryProviderId: z.string().uuid().nullable().optional(),
  consentTreatment: z.literal(true, {
    errorMap: () => ({ message: 'Consent to treatment must be recorded before registration' }),
  }),
  consentComms: z.boolean().default(false),
  duplicateAcknowledged: z.boolean().default(false),
}).refine((v) => v.emergencyPhone !== v.phone, {
  message: 'Emergency contact must differ from the patient’s own number',
  path: ['emergencyPhone'],
});

const listQuery = z.object({
  search: z.string().optional(),
  scope: z.enum(['mine', 'practice']).optional(),
});

const openQuery = z.object({
  // Supplied on the retry after a 428.
  reason: z.string().optional(),
});

const identityCorrectionBody = z.object({
  nationalId: z.string().optional().nullable(),
  dateOfBirth: dateOnly.optional().nullable(),
  reason: z.string().min(5).max(240),
}).refine((v) => Object.prototype.hasOwnProperty.call(v, 'nationalId')
  || Object.prototype.hasOwnProperty.call(v, 'dateOfBirth'), {
  message: 'Supply nationalId or dateOfBirth',
});

const mergeBody = z.object({
  sourcePatientId: z.string().uuid(),
  survivorPatientId: z.string().uuid(),
  reason: z.string().min(5).max(240),
});

export async function patientRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: { session: NonNullable<unknown> }): Actor => {
    const s = request.session as { userId: string; role: Actor['role']; practiceId: string };
    return { userId: s.userId, role: s.role, practiceId: s.practiceId };
  };

  app.get('/patients', {
    preHandler: requirePermission('viewPatientDirectory'),
    handler: async (request) => {
      const query = listQuery.parse(request.query);
      const actor = actorOf(request as never);
      return withTenant({ practiceId: actor.practiceId, userId: actor.userId }, (client) =>
        patientsService.list(client, actor, query),
      );
    },
  });

  // Opening a chart is an auditable event, so it is a route of its own rather
  // than a side effect of a list query.
  app.get('/patients/:id', {
    preHandler: requirePermission('viewPatientDirectory'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason } = openQuery.parse(request.query);
      const actor = actorOf(request as never);
      return withTenant({ practiceId: actor.practiceId, userId: actor.userId }, (client) =>
        patientsService.open(client, actor, id, reason),
      );
    },
  });

  app.post('/patients', {
    preHandler: requirePermission('addPatient'),
    handler: async (request, reply) => {
      const body = createBody.parse(request.body);
      const actor = actorOf(request as never);
      const patient = await withTenant(
        { practiceId: actor.practiceId, userId: actor.userId },
        (client) => patientsService.create(client, actor, body),
      );
      return reply.code(201).send(patient);
    },
  });

  app.post('/patients/:id/identity-corrections', {
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = identityCorrectionBody.parse(request.body);
      const actor = actorOf(request as never);
      return withTenant({ practiceId: actor.practiceId, userId: actor.userId }, (client) =>
        patientsService.correctIdentity(client, actor, id, body),
      );
    },
  });

  app.post('/patients/merge', {
    handler: async (request) => {
      const body = mergeBody.parse(request.body);
      const actor = actorOf(request as never);
      return withTenant({ practiceId: actor.practiceId, userId: actor.userId }, (client) =>
        patientsService.merge(client, actor, body),
      );
    },
  });

  // No blanket permission: the service decides field group by field group, so a
  // clinician updating allergies cannot also change medical aid cover.
  app.patch('/patients/:id', {
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request as never);
      return withTenant({ practiceId: actor.practiceId, userId: actor.userId }, (client) =>
        patientsService.update(client, actor, id, request.body as Record<string, unknown>),
      );
    },
  });
}
