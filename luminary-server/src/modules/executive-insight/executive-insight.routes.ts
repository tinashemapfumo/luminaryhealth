import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../../platform/db.js';
import { Unauthorized } from '../../platform/errors.js';
import { requireIntegration } from '../../platform/integration.js';
import type { IntegrationScope } from '../../platform/integration.js';
import { requirePermission } from '../../platform/permissions.js';
import { executiveInsightService } from './executive-insight.service.js';
import { askLuminaryService } from './ask-luminary.service.js';
import { reportingRequestSchema } from './reporting-request.js';

type Domain = 'executive-summary' | 'revenue' | 'claims' | 'patients' | 'appointments' | 'operations';

const handlers = {
  'executive-summary': executiveInsightService.executiveSummary.bind(executiveInsightService),
  revenue: executiveInsightService.revenue.bind(executiveInsightService),
  claims: executiveInsightService.claims.bind(executiveInsightService),
  patients: executiveInsightService.patients.bind(executiveInsightService),
  appointments: executiveInsightService.appointments.bind(executiveInsightService),
  operations: executiveInsightService.operations.bind(executiveInsightService),
};

export async function executiveInsightRoutes(app: FastifyInstance): Promise<void> {
  const register = (prefix: '/agent/reports' | '/agent/insight', scope: IntegrationScope, domain: Domain) => {
    app.post(`${prefix}/${domain}`, {
      preHandler: requireIntegration(scope),
      handler: async (request: FastifyRequest) => {
        const caller = request.integration;
        if (!caller) throw new Unauthorized();
        const body = reportingRequestSchema.parse(request.body ?? {});
        let data;
        try {
          data = await withTenant({ practiceId: caller.practiceId, userId: null }, async (client) => {
            const report = await handlers[domain](client, body);
            const period = report.reportingPeriod;
            await client.query(
              `SELECT luminary.write_audit(
                 'Accessed Executive Insight report', 'integration', $1, $2, $3, 'info'
               )`,
              [caller.credentialId, caller.name, JSON.stringify({
                scope, domain, requestedPeriod: body.period,
                from: period.from, to: period.to, compare: body.compare,
                comparisonFrom: period.comparisonFrom, comparisonTo: period.comparisonTo,
                requestId: request.id, outcome: 'success',
              })],
            );
            return report;
          });
        } catch (error) {
          request.log.warn({
            err: error, requestId: request.id, credentialId: caller.credentialId,
            practiceId: caller.practiceId, scope, domain,
            period: body.period, compare: body.compare, outcome: 'failure',
          }, 'Executive Insight report failed');
          throw error;
        }

        return {
          success: true,
          data,
          meta: { source: 'luminary', generatedAt: new Date().toISOString(), requestId: request.id },
        };
      },
    });
  };

  for (const domain of Object.keys(handlers) as Domain[]) {
    register('/agent/reports', 'agent:report', domain);
    register('/agent/insight', 'agent:insight', domain);
  }

  app.post('/ai/ask-luminary', {
    preHandler: requirePermission('exportReports'),
    handler: async (request) => {
      const session = request.session;
      if (!session) throw new Unauthorized();
      const body = z.object({
        question: z.string().trim().min(2).max(2000),
        conversationId: z.string().trim().min(1).max(200).optional(),
      }).strict().parse(request.body);

      const webhook = await withTenant(
        { practiceId: session.practiceId, userId: session.userId },
        (client) => askLuminaryService.configuration(client),
      );

      let result;
      try {
        result = await askLuminaryService.ask(webhook, { ...body, requestId: request.id });
      } catch (error) {
        request.log.warn({
          err: error, requestId: request.id, userId: session.userId,
          practiceId: session.practiceId, outcome: 'failure',
        }, 'Ask Luminary request failed');
        throw error;
      }

      await withTenant({ practiceId: session.practiceId, userId: session.userId }, (client) =>
        client.query(
          `SELECT luminary.write_audit(
             'Asked Luminary Executive Insight', 'practice', NULL, NULL, $1, 'info'
           )`,
          [JSON.stringify({ requestId: request.id, outcome: 'success' })],
        ),
      );

      return { ...result, requestId: request.id };
    },
  });
}
