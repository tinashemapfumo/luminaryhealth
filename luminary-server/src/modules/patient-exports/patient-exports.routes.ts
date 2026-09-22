import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { Unauthorized } from '../../platform/errors.js';
import type { Actor } from '../billing/billing.service.js';
import { EXPORT_SECTIONS, patientExportsService } from './patient-exports.service.js';

const idParams = z.object({ id: z.string().uuid() }).strict();
const requestBody = z.object({
  purpose: z.string().trim().min(3).max(240),
  sections: z.array(z.enum(EXPORT_SECTIONS)).min(1).max(EXPORT_SECTIONS.length)
    .default(['summary', 'clinical', 'appointments']),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
}).strict().refine((value) => !value.dateFrom || !value.dateTo || value.dateTo >= value.dateFrom, {
  message: 'dateTo must be on or after dateFrom', path: ['dateTo'],
});

export async function patientExportRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    return request.session;
  };
  const run = <T>(actor: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: actor.practiceId, userId: actor.userId }, work);

  app.post('/patients/:id/exports', {
    preHandler: requirePermission('exportPatientRecord'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = requestBody.parse(request.body);
      const actor = actorOf(request);
      const job = await run(actor, (client) => patientExportsService.request(client, actor, id, body));
      return reply.code(202).send(job);
    },
  });

  app.get('/patients/:id/exports', {
    preHandler: requirePermission('exportPatientRecord'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => patientExportsService.list(client, actor, id));
    },
  });

  app.get('/patient-exports/:id', {
    preHandler: requirePermission('exportPatientRecord'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => patientExportsService.status(client, actor, id));
    },
  });

  app.get('/patient-exports/:id/download', {
    preHandler: requirePermission('exportPatientRecord'),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      const result = await run(actor, (client) => patientExportsService.takeForDownload(client, actor, id));
      result.stream.on('error', (error: Error) => {
        request.log.error({ err: error, exportId: id }, 'patient export stream failed');
        if (!reply.sent) void reply.code(409).send({ error: 'conflict', message: 'Export bytes are unavailable' });
        else reply.raw.destroy(error);
      });
      return reply
        .type('application/zip')
        .header('Cache-Control', 'private, no-store, max-age=0')
        .header('Pragma', 'no-cache')
        .header('Content-Length', String(result.job.size_bytes))
        .header('Content-Disposition', `attachment; filename="patient-file-${result.job.patient_id}.zip"`)
        .send(result.stream);
    },
  });

  app.post('/patient-exports/:id/revoke', {
    preHandler: requirePermission('exportPatientRecord'),
    handler: async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => patientExportsService.revoke(client, actor, id));
    },
  });
}
