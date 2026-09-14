import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withoutTenant } from '../../platform/db.js';
import { requirePermission } from '../../platform/permissions.js';
import { organisationService, type Actor } from './organisation.service.js';
import { Unauthorized } from '../../platform/errors.js';

const role = z.enum(['admin', 'doctor', 'nurse', 'manager', 'receptionist']);

export async function organisationRoutes(app: FastifyInstance): Promise<void> {
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.session) throw new Unauthorized();
    const { userId, role: r, practiceId } = request.session;
    return { userId, role: r, practiceId };
  };
  const run = <T>(a: Actor, work: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ practiceId: a.practiceId, userId: a.userId }, work);

  app.get('/users', {
    preHandler: requirePermission('manageUsers'),
    handler: async (request) => {
      const actor = actorOf(request);
      return run(actor, (client) => organisationService.listUsers(client, actor));
    },
  });

  app.post('/users/invitations', {
    preHandler: requirePermission('manageUsers'),
    handler: async (request, reply) => {
      const body = z.object({
        email: z.string().email(),
        role,
        fullName: z.string().min(1),
        jobTitle: z.string().optional(),
      }).parse(request.body);
      const actor = actorOf(request);
      const result = await run(actor, (client) => organisationService.invite(client, actor, body));
      // The token is returned once so the caller can send it; it is stored hashed.
      return reply.code(201).send(result);
    },
  });

  /**
   * Unauthenticated by design: the invitation token *is* the credential, and
   * the account does not exist until this succeeds. Runs without tenant context
   * because the practice comes from the invitation, not from a session.
   */
  app.post('/users/invitations/accept', async (request, reply) => {
    const body = z.object({
      token: z.string().min(20),
      fullName: z.string().min(1),
      displayName: z.string().min(1),
      // The real minimum is the practice's own policy, which is only knowable
      // once the token resolves; this is a floor, not the rule.
      password: z.string().min(1),
    }).parse(request.body);

    // Two steps: resolve the token across tenants, then create the account
    // inside a transaction scoped to the practice it named.
    const invitation = await withoutTenant((client) =>
      organisationService.resolveInvitation(client, body.token),
    );

    const user = await withTenant(
      { practiceId: invitation.practice_id, userId: null },
      (client) => organisationService.acceptInvitation(client, invitation, body),
    );
    return reply.code(201).send(user);
  });

  app.put('/users/:id/role', {
    preHandler: requirePermission('assignRoles'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { role: next } = z.object({ role }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => organisationService.setRole(client, actor, id, next));
    },
  });

  app.put('/users/:id/active', {
    preHandler: requirePermission('manageUsers'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { active } = z.object({ active: z.boolean() }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => organisationService.setActive(client, actor, id, active));
    },
  });

  // Deliberately its own endpoint: offboarding is a workflow with prerequisites,
  // not a flag someone flips on the way out of the building.
  app.get('/users/:id/offboarding', {
    preHandler: requirePermission('manageUsers'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => organisationService.offboardingReport(client, actor, id));
    },
  });

  app.post('/users/:id/reassign-patients', {
    preHandler: requirePermission('manageUsers'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { toUserId } = z.object({ toUserId: z.string().uuid() }).parse(request.body);
      const actor = actorOf(request);
      return run(actor, (client) => organisationService.reassignPatients(client, actor, id, toUserId));
    },
  });

  app.post('/users/:id/revoke-sessions', {
    preHandler: requirePermission('manageUsers'),
    handler: async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      return run(actor, (client) => organisationService.revokeSessions(client, actor, id));
    },
  });

  app.get('/users/registrations/expiring', {
    preHandler: requirePermission('manageUsers'),
    handler: async (request) => {
      const { withinDays } = z.object({
        withinDays: z.coerce.number().int().min(1).max(365).default(60),
      }).parse(request.query);
      const actor = actorOf(request);
      return run(actor, (client) => organisationService.expiringRegistrations(client, actor, withinDays));
    },
  });
}
