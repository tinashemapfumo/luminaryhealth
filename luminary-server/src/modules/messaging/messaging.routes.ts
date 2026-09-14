import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { Unauthorized } from '../../platform/errors.js';
import { messagingService, type Actor } from './messaging.service.js';
import { dispatcherStatus } from './messaging.dispatcher.js';

const channel = z.string().transform((value) => value.toLowerCase()).pipe(z.enum(['sms', 'whatsapp', 'email']));

const listQuery = z.object({
  patientId: z.string().uuid().optional(),
  status: z.string().optional(),
});

const queueBody = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  channel,
  body: z.string().min(1),
  template: z.string().optional(),
});

export async function messagingRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role, practiceId } = request.session;
    return { userId, role, practiceId };
  };
  const run = <T>(actor: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: actor.practiceId, userId: actor.userId }, work);

  app.get('/messages', {
    preHandler: requirePermission('sendMessages'),
    handler: async (request) => {
      const query = listQuery.parse(request.query);
      const actor = actorOf(request);
      return run(actor, (client) => messagingService.list(client, actor, query));
    },
  });

  app.post('/messages', {
    preHandler: requirePermission('sendMessages'),
    handler: async (request, reply) => {
      const body = queueBody.parse(request.body);
      const actor = actorOf(request);
      const message = await run(actor, (client) => messagingService.queue(client, actor, body));
      return reply.code(201).send(message);
    },
  });

  app.get('/messages/status', {
    preHandler: requirePermission('sendMessages'),
    handler: async (request) => {
      const actor = actorOf(request);
      const database = await run(actor, (client) => messagingService.operationalStatus(client));
      return {
        dispatcher: dispatcherStatus(),
        ...database,
      };
    },
  });

  app.delete('/messages/:id', {
    preHandler: requirePermission('sendMessages'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => messagingService.cancel(client, actor, id));
    },
  });
}
