import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../../platform/errors.js';
import { z } from 'zod';

interface WebhookConfig { url: string | null; secret: string | null }
interface AskInput { question: string; conversationId?: string; requestId: string }
const agentResponseSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
  sources: z.union([z.string(), z.array(z.string())]).optional(),
  conversationId: z.string().max(200).nullable().optional(),
  reportingPeriod: z.object({
    label: z.string().max(120).optional(),
    from: z.string().max(30).optional(),
    to: z.string().max(30).optional(),
    comparisonLabel: z.string().max(120).optional(),
  }).optional(),
  metrics: z.array(z.object({
    label: z.string().max(120),
    value: z.union([z.string().max(120), z.number()]),
    previous: z.union([z.string().max(120), z.number(), z.null()]).optional(),
    changePercent: z.number().finite().nullable().optional(),
    sentiment: z.enum(['positive', 'negative', 'neutral']).optional(),
  })).max(12).optional(),
  sections: z.array(z.object({
    title: z.string().max(160),
    body: z.string().max(5000).optional(),
    items: z.array(z.string().max(1000)).max(12).optional(),
  })).max(8).optional(),
  followUps: z.array(z.string().trim().min(2).max(300)).max(6).optional(),
});

interface AgentResponse extends z.infer<typeof agentResponseSchema> {
  sources: string[];
  conversationId: string | null;
  metrics: NonNullable<z.infer<typeof agentResponseSchema>['metrics']>;
  sections: NonNullable<z.infer<typeof agentResponseSchema>['sections']>;
  followUps: string[];
}

const TIMEOUT_MS = 45_000;

const signature = (secret: string, timestamp: string, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

export const askLuminaryService = {
  async configuration(client: PoolClient): Promise<WebhookConfig> {
    const { rows } = await client.query<WebhookConfig>(
      `SELECT executive_insight_webhook_url AS url,
              executive_insight_webhook_secret AS secret
         FROM luminary.practice_settings
        WHERE practice_id = luminary.current_practice_id()`,
    );
    return rows[0] ?? { url: null, secret: null };
  },

  async ask(config: WebhookConfig, input: AskInput): Promise<AgentResponse> {
    if (!config.url || !config.secret) {
      throw new AppError(
        'Ask Luminary is not configured for this practice.', 503, 'agent_not_configured',
      );
    }

    const payload = JSON.stringify({
      question: input.question,
      conversationId: input.conversationId ?? null,
      requestId: input.requestId,
    });
    const timestamp = String(Date.now());

    let response: Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-luminary-timestamp': timestamp,
          'x-luminary-signature': signature(config.secret, timestamp, payload),
          'x-luminary-request-id': input.requestId,
        },
        body: payload,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AppError('Ask Luminary could not reach the analyst workflow.', 503, 'agent_unavailable');
    }

    if (!response.ok) {
      throw new AppError('The analyst workflow could not answer this request.', 502, 'agent_upstream_error');
    }

    const parsed = agentResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError('The analyst workflow returned an invalid response.', 502, 'agent_invalid_response');
    }
    const body = parsed.data;
    const rawSources = body.sources;
    const sources = Array.isArray(rawSources)
      ? rawSources
      : typeof rawSources === 'string' ? [rawSources] : [];

    return {
      ...body,
      sources,
      conversationId: body.conversationId ?? null,
      metrics: body.metrics ?? [],
      sections: body.sections ?? [],
      followUps: body.followUps ?? [],
    };
  },
};
