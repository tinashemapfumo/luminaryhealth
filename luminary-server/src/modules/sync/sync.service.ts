import type { PoolClient } from 'pg';
import { config } from '../../platform/config.js';

/**
 * Replication between a practice's local server and the cloud.
 *
 * The shape of the problem is unusual in one helpful way: **tenancy makes sync
 * easy**. A local node holds exactly one practice, so there is never a
 * cross-tenant merge and never a question of which rows belong where. Each
 * node drains its own outbox for one `practice_id` and applies what comes back.
 *
 * Three rules govern how a change is applied.
 *
 * 1. **Append-only tables never conflict.** Audit entries, payments, and
 *    addenda are inserts. If the row is absent, insert it; if present, it is
 *    already ours. There is nothing to reconcile because nothing was overwritten.
 *
 * 2. **Newer wins, but losing a write is never silent.** For mutable rows the
 *    later `updated_at` is applied — but if *both* nodes changed the row since
 *    they last spoke, the discarded version is written to `sync_conflict` for a
 *    human to settle. Quietly dropping a clinical edit is the one outcome worse
 *    than a conflict.
 *
 * 3. **Tombstones replicate; deletions do not.** A row that simply vanished is
 *    indistinguishable from one that never arrived, which is why the schema
 *    refuses hard deletes outright.
 */

/** Tables where a row is only ever inserted, so two nodes cannot disagree. */
const APPEND_ONLY = new Set([
  'audit_event',
  'payment',
  'encounter_addendum',
  'invoice_line',
  'message_receipt',
  'appointment_status_history',
  'patient_consent_event',
]);

/**
 * Columns the receiving node must not copy.
 *
 * `origin_node` IS copied, so provenance survives the hop — the log records
 * where a change was authored rather than where it last landed. The echo is
 * prevented by suppressing logging during replication instead (migration 009).
 * `period` is a generated column — PostgreSQL refuses any non-DEFAULT value for
 * one, so replicating it fails the whole batch. It is derived from `starts_at`
 * and `ends_at`, both of which do replicate, so nothing is lost by omitting it.
 */
const NEVER_COPY = new Set(['period']);

/**
 * The column an upsert conflicts on. Almost every table is keyed on `id`, but
 * `practice_settings` is one row per practice and keyed on `practice_id` — an
 * `ON CONFLICT (id)` there matches no constraint and fails outright.
 */
const CONFLICT_KEY: Record<string, string> = { practice_settings: 'practice_id' };

export interface Change {
  seq: number;
  practice_id: string;
  table_name: string;
  row_id: string;
  operation: 'insert' | 'update' | 'delete';
  payload: Record<string, unknown>;
  origin_node: string;
  occurred_at: string;
}

export const syncService = {
  /** Changes this node has not yet handed to the given peer. */
  async collect(client: PoolClient, peer: string, limit = 500): Promise<{ changes: Change[]; upTo: number }> {
    const { rows: mark } = await client.query<{ last_sent_seq: string }>(
      `SELECT last_sent_seq FROM luminary.sync_peer
        WHERE practice_id = luminary.current_practice_id() AND peer_node = $1`,
      [peer],
    );
    const since = Number(mark[0]?.last_sent_seq ?? 0);

    const { rows } = await client.query<Change>(
      `SELECT seq, practice_id, table_name, row_id, operation, payload, origin_node, occurred_at
         FROM luminary.sync_change
        WHERE practice_id = luminary.current_practice_id()
          AND seq > $1
          -- Never bounce a change back to the node it came from.
          AND origin_node <> $2
        ORDER BY seq
        LIMIT $3`,
      [since, peer, limit],
    );

    return { changes: rows, upTo: rows.length ? Number(rows[rows.length - 1]!.seq) : since };
  },

  /**
   * A page of the practice's *current* rows, for seeding a node that was not
   * present when they were written.
   *
   * The watermark is the whole point. It is taken from the change log at the
   * moment of the request, and the receiver streams forward from it once the
   * copy lands. A row edited mid-copy is therefore covered twice — the page may
   * carry the old version, but its change sits above the watermark and arrives
   * again through the ordinary loop, where newer-wins settles it. The reverse
   * ordering would lose the edit, which is why the watermark is read before the
   * rows and never per page.
   *
   * Paged by `id` rather than by offset: rows are being inserted while the copy
   * runs, and an offset would shift under it, silently skipping rows.
   */
  async snapshot(client: PoolClient, table: string, after: string | null, limit = 500) {
    if (!isKnownTable(table)) throw new Error(`unknown table: ${table}`);

    const { rows: mark } = await client.query<{ watermark: string | null }>(
      `SELECT max(seq)::text AS watermark FROM luminary.sync_change
        WHERE practice_id = luminary.current_practice_id()`,
    );

    const { rows } = await client.query(
      `SELECT * FROM luminary.${table}
        WHERE ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT $2`,
      [after, limit],
    );

    return {
      table,
      rows,
      // Absent rather than null, so the caller pages until it is told to stop
      // instead of guessing from a short page.
      nextAfter: rows.length === limit ? (rows[rows.length - 1] as { id: string }).id : null,
      watermark: Number(mark[0]?.watermark ?? 0),
    };
  },

  /**
   * Write a page of seed rows.
   *
   * Deliberately not `apply()`: these are not changes, they are the peer's
   * settled state, and there is nothing here to conflict with — a node being
   * seeded has no competing version of a row it has never seen. Anything it
   * *does* already hold came from this same peer, so the peer's copy wins
   * without argument.
   */
  async applySnapshot(client: PoolClient, table: string, rows: Record<string, unknown>[]) {
    if (!isKnownTable(table)) throw new Error(`unknown table: ${table}`);

    await client.query('SET CONSTRAINTS ALL DEFERRED');
    // Same reason as apply(): a seeded row did not originate here, and logging
    // it would queue the peer's entire database straight back at the peer.
    await client.query("SELECT set_config('luminary.replicating', 'on', true)");

    const practiceId = await currentPractice(client);
    let written = 0;
    for (const row of rows) {
      if (row.practice_id !== practiceId) continue;
      await writeRow(client, table, row);
      written += 1;
    }
    return written;
  },

  /**
   * Has this node ever been seeded from the peer?
   *
   * A missing `sync_peer` row and a row with a NULL `backfilled_at` mean the
   * same thing, and both must answer yes — otherwise the first successful push
   * would create the row and make the node look seeded.
   */
  async needsBackfill(client: PoolClient, peer: string): Promise<boolean> {
    const { rows } = await client.query<{ backfilled_at: Date | null }>(
      `SELECT backfilled_at FROM luminary.sync_peer
        WHERE practice_id = luminary.current_practice_id() AND peer_node = $1`,
      [peer],
    );
    return rows.length === 0 || rows[0]!.backfilled_at === null;
  },

  /**
   * Seeding is complete as of `watermark`.
   *
   * `last_recv_seq` moves to the watermark in the same statement: the snapshot
   * already contains everything at or below it, so replaying those changes
   * would be wasted work. GREATEST guards the case where ordinary streaming
   * overtook the copy.
   */
  async markBackfilled(client: PoolClient, peer: string, watermark: number): Promise<void> {
    await client.query(
      `INSERT INTO luminary.sync_peer (practice_id, peer_node, last_recv_seq, backfilled_at, last_contact)
       VALUES (luminary.current_practice_id(), $1, $2, now(), now())
       ON CONFLICT (practice_id, peer_node)
       DO UPDATE SET last_recv_seq = GREATEST(luminary.sync_peer.last_recv_seq, EXCLUDED.last_recv_seq),
                     backfilled_at = now(),
                     last_contact  = now()`,
      [peer, watermark],
    );
  },

  /**
   * Apply a batch from a peer. Returns what happened to each change so the
   * sender can distinguish "accepted" from "you and I disagree".
   */
  async apply(client: PoolClient, peer: string, changes: Change[]) {
    const result = { applied: 0, skipped: 0, conflicts: 0, rejected: [] as string[] };

    // Check references once at COMMIT rather than per statement. A batch cannot
    // always be ordered to satisfy foreign keys — an appointment and its patient
    // may arrive in different batches — and with immediate checks the first
    // unsatisfied reference aborts the transaction, rolling back everything that
    // had already succeeded and guaranteeing the same failure next cycle.
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    // Suppress the change log for the duration of this batch. These rows did
    // not originate here, so queueing them to be sent back would loop forever
    // and make every round trip look like a concurrent edit.
    await client.query("SELECT set_config('luminary.replicating', 'on', true)");

    for (const change of changes) {
      // A peer must never write into another practice, whatever it claims.
      if (change.practice_id !== (await currentPractice(client))) {
        result.rejected.push(`${change.table_name}/${change.row_id}: wrong practice`);
        continue;
      }
      if (!isKnownTable(change.table_name)) {
        result.rejected.push(`${change.table_name}: unknown table`);
        continue;
      }

      const outcome = await applyOne(client, change);
      if (outcome === 'applied') result.applied += 1;
      else if (outcome === 'conflict') { result.conflicts += 1; result.applied += 1; }
      else result.skipped += 1;
    }

    await client.query(
      `INSERT INTO luminary.sync_peer (practice_id, peer_node, last_recv_seq, last_contact)
       VALUES (luminary.current_practice_id(), $1, $2, now())
       ON CONFLICT (practice_id, peer_node)
       DO UPDATE SET last_recv_seq = GREATEST(luminary.sync_peer.last_recv_seq, EXCLUDED.last_recv_seq),
                     last_contact = now()`,
      [peer, changes.length ? changes[changes.length - 1]!.seq : 0],
    );

    return result;
  },

  async markSent(client: PoolClient, peer: string, upTo: number): Promise<void> {
    await client.query(
      `INSERT INTO luminary.sync_peer (practice_id, peer_node, last_sent_seq, last_contact)
       VALUES (luminary.current_practice_id(), $1, $2, now())
       ON CONFLICT (practice_id, peer_node)
       DO UPDATE SET last_sent_seq = GREATEST(luminary.sync_peer.last_sent_seq, EXCLUDED.last_sent_seq),
                     last_contact = now()`,
      [peer, upTo],
    );
    await client.query(
      `UPDATE luminary.sync_change SET replicated_at = now()
        WHERE practice_id = luminary.current_practice_id()
          AND seq <= $1 AND replicated_at IS NULL`,
      [upTo],
    );
  },

  async recordCycleResult(client: PoolClient, peer: string, error?: string): Promise<void> {
    await client.query(
      `INSERT INTO luminary.sync_peer
         (practice_id, peer_node, last_contact, last_error, last_failure_at, consecutive_failures)
       VALUES (
         luminary.current_practice_id(),
         $1,
         CASE WHEN $2::text IS NULL THEN now() ELSE NULL END,
         $2,
         CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
         CASE WHEN $2::text IS NULL THEN 0 ELSE 1 END
       )
       ON CONFLICT (practice_id, peer_node)
       DO UPDATE SET
         last_contact = CASE
           WHEN EXCLUDED.last_error IS NULL THEN now()
           ELSE luminary.sync_peer.last_contact
         END,
         last_error = EXCLUDED.last_error,
         last_failure_at = CASE
           WHEN EXCLUDED.last_error IS NULL THEN NULL
           ELSE now()
         END,
         consecutive_failures = CASE
           WHEN EXCLUDED.last_error IS NULL THEN 0
           ELSE luminary.sync_peer.consecutive_failures + 1
         END`,
      [peer, error ?? null],
    );
  },

  /**
   * What a clinic actually wants to know during an outage: am I up to date, and
   * if not, how far behind.
   */
  async status(client: PoolClient) {
    const { rows } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM luminary.sync_change
           WHERE practice_id = luminary.current_practice_id() AND replicated_at IS NULL) AS pending,
         (SELECT count(*)::int FROM luminary.sync_conflict
           WHERE practice_id = luminary.current_practice_id() AND resolved_at IS NULL) AS open_conflicts,
         (SELECT max(last_contact) FROM luminary.sync_peer
           WHERE practice_id = luminary.current_practice_id()) AS last_contact,
         (SELECT last_error FROM luminary.sync_peer
           WHERE practice_id = luminary.current_practice_id()
           ORDER BY COALESCE(last_failure_at, last_contact) DESC NULLS LAST LIMIT 1) AS last_error,
         (SELECT last_failure_at FROM luminary.sync_peer
           WHERE practice_id = luminary.current_practice_id()
           ORDER BY COALESCE(last_failure_at, last_contact) DESC NULLS LAST LIMIT 1) AS last_failure_at,
         (SELECT max(consecutive_failures)::int FROM luminary.sync_peer
           WHERE practice_id = luminary.current_practice_id()) AS consecutive_failures`,
    );
    const row = rows[0];
    const lastContact = row.last_contact ? new Date(row.last_contact) : null;
    return {
      node: config.nodeId,
      role: config.isLocalNode ? 'local' : 'cloud',
      pendingChanges: row.pending,
      openConflicts: row.open_conflicts,
      lastContact,
      lastError: row.last_error,
      lastFailureAt: row.last_failure_at ? new Date(row.last_failure_at) : null,
      consecutiveFailures: row.consecutive_failures,
      // Stated plainly rather than as a boolean: "in sync" is a claim that
      // deserves qualifying when the last contact was hours ago.
      state: row.consecutive_failures >= 3 ? 'stuck'
        : row.pending === 0 && lastContact ? 'up to date'
        : !lastContact ? 'never synchronised'
        : 'behind',
    };
  },

  async listConflicts(client: PoolClient) {
    const { rows } = await client.query(
      `SELECT id, table_name, row_id, local_payload, peer_payload, detected_at
         FROM luminary.sync_conflict
        WHERE resolved_at IS NULL
        ORDER BY detected_at DESC
        LIMIT 100`,
    );
    return rows;
  },

  async resolveConflict(client: PoolClient, id: string, keep: 'local' | 'peer', userId: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.sync_conflict WHERE id = $1 AND resolved_at IS NULL`, [id],
    );
    const conflict = rows[0];
    if (!conflict) return null;

    if (keep === 'peer') {
      await writeRow(client, conflict.table_name, conflict.peer_payload);
    }
    await client.query(
      `UPDATE luminary.sync_conflict
          SET resolved_at = now(), resolved_by = $2, resolution = $3
        WHERE id = $1`,
      [id, userId, keep],
    );
    return { id, kept: keep };
  },
};

async function currentPractice(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`SELECT luminary.current_practice_id() AS id`);
  return rows[0]!.id;
}

/** Whitelist, so a peer cannot name an arbitrary relation. */
const SYNCED_TABLES = new Set([
  'app_user', 'user_invitation', 'session', 'room', 'payer', 'scheme',
  'service', 'service_price', 'service_alias', 'service_visit_type',
  'service_tariff', 'tariff', 'practice_settings',
  'integration_credential', 'patient', 'patient_identity_alias', 'access_grant',
  'appointment', 'appointment_status_history', 'encounter', 'encounter_contributor',
  'encounter_addendum', 'encounter_dictation', 'care_plan', 'referral', 'prescription',
  'lab_result', 'patient_document', 'invoice', 'invoice_adjustment', 'clinical_order',
  'invoice_line', 'payment', 'claim', 'message', 'message_receipt', 'audit_event',
  'claim_line', 'claim_diagnosis', 'claim_event', 'claim_transmission', 'claim_adjudication',
  'claim_attachment', 'claim_remittance', 'claim_eligibility_result', 'claim_authorisation',
  'claim_denial_disposition', 'collection_case', 'collection_action',
  'agent_conversation', 'agent_action', 'intake_proposal',
  'patient_consent_event', 'patient_followup',
  'import_batch', 'import_row', 'mapping_profile',
]);
const isKnownTable = (name: string) => SYNCED_TABLES.has(name);

/**
 * Seeding order, parents before children.
 *
 * Constraints are deferred while a page is applied, but that only holds within
 * one transaction — an appointment seeded before any patient exists would fail
 * at its own COMMIT. Ordering the copy costs nothing and removes the need for
 * the receiver to retry pages.
 *
 * `session` is absent on purpose: sessions are live state belonging to the node
 * that issued them, they expire within hours, and a node cannot usefully adopt
 * ones it never handed out. They still replicate forward so a revocation is
 * honoured everywhere.
 */
export const SNAPSHOT_ORDER = [
  "practice_settings", "app_user", "user_invitation", "room", "payer", "scheme",
  "service", "service_price", "service_alias", "service_visit_type", "service_tariff", "tariff",
  "integration_credential", "patient", "patient_identity_alias", "access_grant",
  "appointment", "appointment_status_history", "encounter", "encounter_contributor", "encounter_addendum",
  "encounter_dictation", "care_plan", "referral", "prescription", "lab_result", "patient_document",
  "invoice", "invoice_adjustment", "clinical_order", "invoice_line", "payment", "claim",
  "message", "message_receipt", "audit_event", "claim_line", "claim_diagnosis", "claim_event", "claim_transmission",
  "claim_adjudication", "claim_attachment", "claim_remittance", "claim_eligibility_result",
  "claim_authorisation", "claim_denial_disposition", "collection_case", "collection_action",
  "agent_conversation", "agent_action", "intake_proposal", "patient_consent_event", "patient_followup",
  "import_batch", "import_row", "mapping_profile",
] as const;

async function applyOne(client: PoolClient, change: Change): Promise<'applied' | 'skipped' | 'conflict'> {
  const { table_name: table, row_id: id, payload } = change;

  const key = CONFLICT_KEY[table] ?? 'id';

  if (APPEND_ONLY.has(table)) {
    const { rows } = await client.query(`SELECT 1 FROM luminary.${table} WHERE ${key} = $1`, [id]);
    if (rows.length > 0) return 'skipped';
    await writeRow(client, table, payload);
    return 'applied';
  }

  const { rows: existing } = await client.query(
    `SELECT * FROM luminary.${table} WHERE ${key} = $1`,
    [CONFLICT_KEY[table] ? (payload[key] as string) : id],
  );

  if (existing.length === 0) {
    await writeRow(client, table, payload);
    return 'applied';
  }

  const local = existing[0]!;
  const localAt = new Date(local.updated_at).getTime();
  const peerAt = new Date(payload.updated_at as string).getTime();
  if (wouldRewriteSignedEncounter(table, local, payload)) {
    await recordConflict(client, change, local);
    return 'conflict';
  }

  if (peerAt <= localAt) {
    // Ours is newer or identical. If ours has not yet reached the peer this is
    // simply an old echo; if it has, the peer edited an older version.
    const { rows: unsent } = await client.query(
      `SELECT 1 FROM luminary.sync_change
        WHERE table_name = $1 AND row_id = $2 AND replicated_at IS NULL LIMIT 1`,
      [table, id],
    );
    if (unsent.length > 0 && peerAt !== localAt) {
      await recordConflict(client, change, local);
      return 'conflict';
    }
    return 'skipped';
  }

  // Peer is newer. Apply it — but if we also changed the row since we last
  // spoke, our version is being displaced and must be preserved for review.
  const { rows: ourUnsent } = await client.query(
    `SELECT 1 FROM luminary.sync_change
      WHERE table_name = $1 AND row_id = $2 AND replicated_at IS NULL LIMIT 1`,
    [table, id],
  );
  await writeRow(client, table, payload);

  if (ourUnsent.length > 0) {
    await recordConflict(client, change, local);
    return 'conflict';
  }
  return 'applied';
}

function wouldRewriteSignedEncounter(
  table: string,
  local: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  if (table !== 'encounter' || local.status !== 'signed') return false;
  const protectedColumns = [
    'status',
    'vitals',
    'subjective',
    'objective',
    'assessment',
    'plan',
    'diagnoses',
    'follow_up',
    'signed_by',
    'signed_at',
  ];
  return protectedColumns.some((column) =>
    JSON.stringify(local[column] ?? null) !== JSON.stringify(payload[column] ?? null),
  );
}

async function recordConflict(client: PoolClient, change: Change, local: Record<string, unknown>) {
  await client.query(
    `INSERT INTO luminary.sync_conflict
       (practice_id, table_name, row_id, local_payload, peer_payload)
     VALUES (luminary.current_practice_id(), $1, $2, $3, $4)`,
    [change.table_name, change.row_id, JSON.stringify(local), JSON.stringify(change.payload)],
  );
}

/**
 * Which columns of a table are `json`/`jsonb`, cached for the process.
 *
 * Needed because node-postgres decides how to encode a JavaScript value from
 * the value alone, and an array is encoded as a PostgreSQL *array literal*.
 * That is right for `patient.allergies` (`text[]`) and wrong for
 * `encounter.diagnoses` (`jsonb`), which then fails with "invalid input syntax
 * for type json" — and, since a batch is one transaction, takes every other
 * change in it down too. The column's declared type is the only thing that
 * distinguishes the two cases, so it has to be asked for.
 *
 * The schema does not change under a running process, so one lookup per table
 * is enough.
 */
const jsonColumnCache = new Map<string, Set<string>>();

async function jsonColumns(client: PoolClient, table: string): Promise<Set<string>> {
  const cached = jsonColumnCache.get(table);
  if (cached) return cached;

  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'luminary' AND table_name = $1
        AND data_type IN ('json', 'jsonb')`,
    [table],
  );
  const set = new Set(rows.map((r) => r.column_name));
  jsonColumnCache.set(table, set);
  return set;
}

/**
 * Upsert a replicated row.
 *
 * `origin_node` is deliberately left to the receiving node's trigger rather than
 * copied, so the change log records where a row was written, not where it was
 * first authored — which is what stops a change ping-ponging between peers.
 */
async function writeRow(client: PoolClient, table: string, payload: Record<string, unknown>) {
  const key = CONFLICT_KEY[table] ?? 'id';
  const json = await jsonColumns(client, table);
  const columns = Object.keys(payload).filter((c) => !NEVER_COPY.has(c));

  // JSON columns are serialised here and cast explicitly, so the driver is never
  // left to guess from the value's shape.
  const values = columns.map((c) =>
    json.has(c) && payload[c] !== null && payload[c] !== undefined
      ? JSON.stringify(payload[c])
      : payload[c],
  );
  const placeholders = columns.map((c, i) => (json.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const updates = columns.filter((c) => c !== key).map((c) => `${c} = EXCLUDED.${c}`);

  await client.query(
    `INSERT INTO luminary.${table} (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (${key}) DO UPDATE SET ${updates.join(', ')}`,
    values,
  );
}
