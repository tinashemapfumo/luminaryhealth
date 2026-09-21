import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from './platform/config.js';
import { registerHttp } from './platform/http.js';
import { pool } from './platform/db.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { patientRoutes } from './modules/patients/patients.routes.js';
import { billingRoutes } from './modules/billing/billing.routes.js';
import { catalogueRoutes } from './modules/catalogue/catalogue.routes.js';
import { schedulingRoutes } from './modules/scheduling/scheduling.routes.js';
import { clinicalRoutes } from './modules/clinical/clinical.routes.js';
import { organisationRoutes } from './modules/organisation/organisation.routes.js';
import { accessRoutes } from './modules/access/access.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { syncRoutes } from './modules/sync/sync.routes.js';
import { messagingRoutes } from './modules/messaging/messaging.routes.js';
import { integrationsRoutes } from './modules/integrations/integrations.routes.js';
import { agentRoutes } from './modules/agent/agent.routes.js';
import { claimsRoutes } from './modules/claims/claims.routes.js';
import { executiveInsightRoutes } from './modules/executive-insight/executive-insight.routes.js';

/**
 * Application assembly.
 *
 * Modules are registered here and nowhere else, so the dependency direction is
 * one-way: the app knows about modules, modules never know about the app. That
 * is what lets a module be exercised by a test or the sync worker without an
 * HTTP server existing at all.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: config.env === 'production'
      ? true
      : { transport: undefined, level: 'info' },
    bodyLimit: 30 * 1024 * 1024,
    // A clinic behind a local server sits behind a proxy; trust it for client IP,
    // which is recorded against every session.
    trustProxy: true,
  });

  // The browser client is a separate origin, so it needs saying explicitly which
  // ones may call this API. An allowlist rather than a wildcard: the API is
  // credentialed, and a node that talks only to its peer should allow none.
  if (config.webOrigins.length > 0) {
    void app.register(cors, {
      origin: config.webOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
  }

  registerHttp(app);

  app.get('/health', async () => {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return {
      status: rows[0]?.ok === 1 ? 'ok' : 'degraded',
      node: config.nodeId,
      // A local node reports whether it can currently reach its peer, because
      // "are we synced?" is the first question during an outage.
      role: config.isLocalNode ? 'local' : 'cloud',
      time: new Date().toISOString(),
    };
  });

  void app.register(authRoutes);
  void app.register(patientRoutes);
  void app.register(billingRoutes);
  void app.register(catalogueRoutes);
  void app.register(schedulingRoutes);
  void app.register(clinicalRoutes);
  void app.register(organisationRoutes);
  void app.register(accessRoutes);
  void app.register(settingsRoutes);
  void app.register(auditRoutes);
  void app.register(messagingRoutes);
  void app.register(integrationsRoutes);
  void app.register(agentRoutes);
  void app.register(claimsRoutes);
  void app.register(executiveInsightRoutes);
  void app.register(syncRoutes);

  return app;
}
