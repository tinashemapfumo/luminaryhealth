import { withTenant, withoutTenant } from '../../platform/db.js';
import { messagingService, signPayload } from './messaging.service.js';

/**
 * The outbound dispatcher.
 *
 * Deliberately a poller rather than an in-request send. A clinician clicking
 * "remind" should not wait on a carrier, and — more importantly — a message
 * whose send fails must still exist. Recording the intent and performing the
 * delivery are separate steps precisely so an outage costs a delay rather than
 * a lost message.
 *
 * This runs on both nodes. That is safe because each node dispatches only what
 * is in its own database and `claimBatch` takes a row lock; but it is worth
 * saying plainly that a message queued locally and replicated up could be sent
 * twice if both nodes are online and both dispatch. The local node is therefore
 * the one that should run it — see `MESSAGING_DISPATCH` in config.
 */

export interface DispatchResult {
  practices: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

const TIMEOUT_MS = 15_000;

const dispatcherState = {
  configured: false,
  running: false,
  active: false,
  startedAt: null as string | null,
  stoppedAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastErrorAt: null as string | null,
  lastError: null as string | null,
  lastResult: null as DispatchResult | null,
};

export function configureDispatcher(enabled: boolean): void {
  dispatcherState.configured = enabled;
}

export function dispatcherStatus() {
  return { ...dispatcherState };
}

export async function dispatchOnce(): Promise<DispatchResult> {
  const result: DispatchResult = { practices: 0, attempted: 0, sent: 0, failed: 0, skipped: 0 };

  const pending = await withoutTenant(async (client) => {
    const { rows } = await client.query(`SELECT * FROM luminary.practices_with_queued_messages()`);
    return rows as { practice_id: string; queued: string }[];
  });

  for (const row of pending) {
    result.practices += 1;
    await withTenant({ practiceId: row.practice_id, userId: null }, async (client) => {
      const config = await messagingService.webhookConfig(client);

      // No webhook configured is not a failure — it is an unfinished setup.
      // Burning attempts on it would quietly discard the practice's messages
      // by the time someone got round to configuring it.
      if (!config?.url) {
        result.skipped += Number(row.queued);
        return;
      }

      const batch = await messagingService.claimBatch(client);
      for (const message of batch) {
        result.attempted += 1;
        if (await messagingService.cancelIfConsentWithdrawn(client, message.id)) {
          result.skipped += 1;
          continue;
        }
        const payload = JSON.stringify({
          messageId: message.id,
          channel: message.channel,
          to: message.recipient,
          body: message.body,
          template: message.template,
          senderId: config.sender ?? null,
          queuedAt: message.queued_at,
        });

        try {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          // Lets the workflow confirm the call is ours before it spends money.
          if (config.secret) headers['x-luminary-signature'] = signPayload(config.secret, payload);

          const response = await fetch(config.url, {
            method: 'POST',
            headers,
            body: payload,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });

          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`n8n returned ${response.status}: ${text.slice(0, 200)}`);
          }

          // n8n may return a carrier reference; it may equally return nothing.
          const ref = await response
            .json()
            .then((body: unknown) =>
              body && typeof body === 'object' && 'providerRef' in body
                ? String((body as { providerRef: unknown }).providerRef)
                : null,
            )
            .catch(() => null);

          await messagingService.markSent(client, message.id, ref);
          result.sent += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const outcome = await messagingService.markFailed(client, message.id, reason);
          // Only count a terminal failure; a requeue is still in flight.
          if (outcome?.status === 'failed') result.failed += 1;
        }
      }
    });
  }

  return result;
}

/** Started from `main.ts` when MESSAGING_DISPATCH is on. */
export function startDispatcher(intervalMs: number, log: (r: DispatchResult) => void): () => void {
  let running = false;
  dispatcherState.configured = true;
  dispatcherState.running = true;
  dispatcherState.startedAt = new Date().toISOString();
  dispatcherState.stoppedAt = null;
  dispatcherState.lastError = null;
  const timer = setInterval(() => {
    // A slow carrier must not stack overlapping runs.
    if (running) return;
    running = true;
    dispatcherState.active = true;
    dispatchOnce()
      .then((r) => {
        dispatcherState.lastSuccessAt = new Date().toISOString();
        dispatcherState.lastResult = r;
        if (r.attempted > 0 || r.failed > 0 || r.skipped > 0) log(r);
      })
      .catch((error) => {
        dispatcherState.lastErrorAt = new Date().toISOString();
        dispatcherState.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        running = false;
        dispatcherState.active = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    dispatcherState.running = false;
    dispatcherState.active = false;
    dispatcherState.stoppedAt = new Date().toISOString();
  };
}
