import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, translatePostgresError } from './errors.js';
import { withoutTenant } from './db.js';
import { authService } from '../modules/auth/auth.service.js';
import { bearer } from '../modules/auth/auth.routes.js';

/**
 * Cross-cutting HTTP concerns, registered once.
 *
 * Authentication runs as a hook rather than per-route so a new endpoint is
 * authenticated by default. Authorisation is the opposite — explicit per route —
 * because a route with no permission decision should be conspicuous, not
 * silently permitted.
 */
export function registerHttp(app: FastifyInstance): void {
    // Node-to-node replication authenticates with a shared secret instead of a
  // session, so it is exempt from the session hook — not from authentication.
  const PUBLIC = new Set([
    '/auth/session', '/practices', '/health', '/users/invitations/accept',
    '/sync/push', '/sync/pull', '/sync/ack',
    // Signed machine callers. Exempt from the *session* hook, not from
    // authentication: each carries its own guard and its own scope.
    '/integrations/messages/inbound', '/integrations/messages/status',
    '/integrations/messages',
    '/agent/conversations', '/agent/verify/start', '/agent/verify/confirm',
    '/agent/availability', '/agent/appointments', '/agent/appointments/reschedule',
    '/agent/appointments/upcoming', '/agent/intake', '/agent/status',
    '/agent/intake/match', '/agent/intake/patients', '/agent/intake/proposals',
    '/agent/followups', '/agent/followups/:id', '/agent/followups/:id/responses',
    '/agent/followups/:id/escalations', '/agent/followups/:id/complete',
    '/agent/insight/executive-summary', '/agent/insight/revenue',
    '/agent/insight/claims', '/agent/insight/patients',
    '/agent/insight/appointments', '/agent/insight/operations',
    '/agent/reports/executive-summary', '/agent/reports/revenue',
    '/agent/reports/claims', '/agent/reports/patients',
    '/agent/reports/appointments', '/agent/reports/operations',
    '/integrations/nh263/webhook',
  ]);

  /*
   * Keep the raw body for signed machine callers.
   *
   * An HMAC is over exact bytes. Re-serialising the parsed object would change
   * whitespace and key order and every signature would fail — so the original
   * text is kept alongside the parsed value, and only for requests that carry
   * an integration signature, because holding raw bodies for everything is a
   * memory cost and a log hazard for no benefit.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body: string, done) => {
      if (request.headers['x-luminary-signature']) request.rawBody = body;
      try {
        done(null, body.length === 0 ? {} : JSON.parse(body));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.addHook('onRequest', async (request) => {
    if (PUBLIC.has(request.routeOptions?.url ?? request.url)) return;
    const token = bearer(request.headers.authorization);
    if (!token) return;                        // route guards decide if that matters
    const session = await withoutTenant((client) => authService.resolve(client, token));
    if (session) request.session = session;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: 'Some fields need attention',
        details: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }

    const frameworkError = error as { code?: string; statusCode?: number };
    if (frameworkError.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || frameworkError.statusCode === 413) {
      return reply.code(413).send({
        error: 'payload_too_large',
        message: 'The uploaded document exceeds the maximum allowed size.',
      });
    }

    const translated = translatePostgresError(error);
    if (translated) {
      return reply.code(translated.status).send({ error: translated.code, message: translated.message });
    }

    // Never leak an internal message to a client; log it in full instead.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });
}
