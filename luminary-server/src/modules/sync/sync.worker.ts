import { withTenant, withoutTenant } from '../../platform/db.js';
import { config } from '../../platform/config.js';
import { syncService, SNAPSHOT_ORDER } from './sync.service.js';

/**
 * The replication loop, run only on a local node.
 *
 * Push first, then pull. That order matters during a bad connection: getting the
 * clinic's own work off the box is more urgent than learning what cloud knows,
 * because the local copy is the one that a power cut can take with it.
 *
 * Failure is expected rather than exceptional here — the line drops several
 * times a day. Nothing throws out of the loop; a failed cycle simply leaves the
 * outbox intact and tries again, which is why changes are only marked replicated
 * after the peer acknowledges them.
 */

let running = false;
let timer: NodeJS.Timeout | null = null;

export interface SyncOutcome {
  /** Rows copied by the one-off seed. Absent on every cycle after the first. */
  seeded?: number;
  pushed: number;
  pulled: number;
  applied: number;
  conflicts: number;
  error?: string;
}

async function practicesOnThisNode(): Promise<string[]> {
  // A local node holds exactly one practice; cloud holds many but does not
  // initiate, so in practice this returns a single row.
  const known = await withoutTenant(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM luminary.practice WHERE home_node = $1 AND deleted_at IS NULL`,
      [config.nodeId],
    );
    return rows.map((r) => r.id);
  });
  if (known.length > 0) return known;

  // Nothing here yet. On a freshly installed node that is the expected state,
  // not an error: the practice row is the one row that cannot arrive through
  // tenant-scoped replication, because it *is* the tenant. Fetch it once from
  // the peer, and every subsequent tick takes the branch above.
  const bootstrapped = await bootstrapPractice();
  return bootstrapped ? [bootstrapped] : [];
}

/**
 * Copy the practice row down, so this node knows who it serves.
 *
 * Returns null rather than throwing when it cannot: a node that comes up before
 * its link does should retry quietly on the next tick, not crash the worker.
 */
async function bootstrapPractice(): Promise<string | null> {
  const practiceId = config.syncPracticeId;
  if (!practiceId || !config.syncPeerUrl) return null;

  try {
    const response = await fetch(`${config.syncPeerUrl}/sync/identity`, {
      headers: peerHeaders(practiceId),
    });
    if (!response.ok) return null;
    const practice = (await response.json()) as Record<string, unknown>;

    // `home_node` is copied as cloud recorded it, not overwritten with this
    // node's id. Cloud is the register of which practice has a local server;
    // a node that could name itself the home of any practice it was pointed at
    // would make that register meaningless.
    await withoutTenant(async (client) => {
      const columns = Object.keys(practice);
      await client.query(
        `INSERT INTO luminary.practice (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (id) DO NOTHING`,
        columns.map((c) => practice[c]),
      );
    });
    return practiceId;
  } catch {
    return null;
  }
}

const peerHeaders = (practiceId: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.syncSecret}`,
  'X-Luminary-Node': config.nodeId,
  'X-Luminary-Practice': practiceId,
});

/**
 * Seed this node from the peer before the first ordinary cycle.
 *
 * Runs once per pair and is safe to interrupt: nothing is marked complete until
 * every table has landed, so a connection lost halfway simply repeats the copy
 * next tick. Repeating is cheap in the sense that matters — the writes are
 * upserts of the peer's settled rows, so a second pass changes nothing.
 *
 * The watermark comes from the *first* page and is held for the whole run.
 * Re-reading it per table would advance past changes made during the copy and
 * skip them permanently.
 */
async function backfill(practiceId: string): Promise<{ rows: number; watermark: number }> {
  const peer = config.syncPeerUrl!;
  let watermark: number | null = null;
  let total = 0;

  for (const table of SNAPSHOT_ORDER) {
    let after: string | null = null;

    // Paged rather than fetched whole: a practice's audit log alone can outgrow
    // the memory of the small box this typically runs on.
    for (;;) {
      const url = new URL(`${peer}/sync/snapshot`);
      url.searchParams.set('table', table);
      url.searchParams.set('limit', '500');
      if (after) url.searchParams.set('after', after);

      const response = await fetch(url, { headers: peerHeaders(practiceId) });
      if (!response.ok) throw new Error(`snapshot ${table} failed: ${response.status}`);
      const page = (await response.json()) as {
        rows: Record<string, unknown>[];
        nextAfter: string | null;
        watermark: number;
      };

      watermark ??= page.watermark;

      if (page.rows.length > 0) {
        total += await withTenant({ practiceId, userId: null }, (client) =>
          syncService.applySnapshot(client, table, page.rows),
        );
      }

      after = page.nextAfter;
      if (!after) break;
    }
  }

  const mark = watermark ?? 0;
  await withTenant({ practiceId, userId: null }, (client) =>
    syncService.markBackfilled(client, 'cloud', mark),
  );

  // Tell the peer it need not resend what the snapshot already contained. This
  // is the one place a push-side ack is correct: the watermark is the peer's
  // own sequence number, read from the peer's log, so advancing its mark with
  // it is not the sequence-space confusion that ordinary pushes must avoid.
  await fetch(`${peer}/sync/ack`, {
    method: 'POST',
    headers: peerHeaders(practiceId),
    body: JSON.stringify({ upTo: mark }),
  });

  return { rows: total, watermark: mark };
}

export async function runOnce(practiceId: string): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { pushed: 0, pulled: 0, applied: 0, conflicts: 0 };
  const peer = config.syncPeerUrl;
  if (!peer) return { ...outcome, error: 'no peer configured' };

  try {
    // --- seed, once ---
    //
    // Before the first cycle, not after: pushing first would hand cloud the
    // node's empty state, and pulling first would advance the receive mark past
    // rows the snapshot is about to supply.
    const unseeded = await withTenant({ practiceId, userId: null }, (client) =>
      syncService.needsBackfill(client, 'cloud'),
    );
    if (unseeded) {
      const seed = await backfill(practiceId);
      outcome.seeded = seed.rows;
    }

    // --- push ---
    const batch = await withTenant({ practiceId, userId: null }, (client) =>
      syncService.collect(client, 'cloud'),
    );

    if (batch.changes.length > 0) {
      const response = await fetch(`${peer}/sync/push`, {
        method: 'POST',
        headers: peerHeaders(practiceId),
        body: JSON.stringify({ changes: batch.changes }),
      });
      if (!response.ok) throw new Error(`push failed: ${response.status}`);

      // Mark our OWN outbox replicated. Deliberately no ack to the peer here:
      // the two nodes keep independent sequence counters, and acking a push
      // would advance the peer's "already sent you" mark using our numbers —
      // causing it to skip its own unsent changes. That failure is silent:
      // both sides report success while the clinic quietly stops receiving
      // updates. The peer already recorded what it received when it applied
      // the batch.
      await withTenant({ practiceId, userId: null }, (client) =>
        syncService.markSent(client, 'cloud', batch.upTo),
      );
      outcome.pushed = batch.changes.length;
    }

    // --- pull ---
    const pullResponse = await fetch(`${peer}/sync/pull?limit=500`, { headers: peerHeaders(practiceId) });
    if (!pullResponse.ok) throw new Error(`pull failed: ${pullResponse.status}`);
    const incoming = (await pullResponse.json()) as { changes: unknown[]; upTo: number };

    if (incoming.changes.length > 0) {
      const applied = await withTenant({ practiceId, userId: null }, (client) =>
        syncService.apply(client, 'cloud', incoming.changes as never),
      );
      outcome.pulled = incoming.changes.length;
      outcome.applied = applied.applied;
      outcome.conflicts = applied.conflicts;

      await fetch(`${peer}/sync/ack`, {
        method: 'POST',
        headers: peerHeaders(practiceId),
        body: JSON.stringify({ upTo: incoming.upTo }),
      });
    }

    return outcome;
  } catch (error) {
    // Expected during an outage. The outbox is untouched, so nothing is lost.
    return { ...outcome, error: (error as Error).message };
  }
}

export function startSyncWorker(log: { info: (o: unknown, m?: string) => void }): void {
  if (!config.isLocalNode || !config.syncPeerUrl) return;
  if (running) return;
  running = true;

  const tick = async () => {
    for (const practiceId of await practicesOnThisNode()) {
      const outcome = await runOnce(practiceId);
      try {
        await withTenant({ practiceId, userId: null }, (client) =>
          syncService.recordCycleResult(client, 'cloud', outcome.error),
        );
      } catch (error) {
        log.info({ practiceId, error: (error as Error).message }, 'sync status update failed');
      }
      if (outcome.seeded || outcome.pushed || outcome.pulled || outcome.error) {
        log.info({ practiceId, ...outcome }, 'sync cycle');
      }
    }
    timer = setTimeout(tick, config.syncIntervalSeconds * 1000);
  };

  timer = setTimeout(tick, 2000);
}

export function stopSyncWorker(): void {
  running = false;
  if (timer) clearTimeout(timer);
}
