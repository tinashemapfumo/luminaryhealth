import type { PoolClient } from 'pg';
import type { CanonicalClaim, ClaimStatus, SubmissionChannel } from './claims.types.js';

export const claimsRepository = {
  async nextClaimNumber(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ next: string }>(
      `SELECT 'CLM-' || to_char(now(), 'YYYY') || '-' ||
              lpad((COALESCE(max(NULLIF(regexp_replace(claim_number, '\\D', '', 'g'), '')::bigint), 0) % 10000 + 1)::text, 4, '0') AS next
         FROM luminary.claim
        WHERE claim_number LIKE 'CLM-' || to_char(now(), 'YYYY') || '-%'`,
    );
    return rows[0]!.next;
  },

  async list(client: PoolClient, opts: {
    patientId?: string; payerId?: string; status?: string; invoiceId?: string; query?: string; limit?: number;
  }) {
    const params: unknown[] = [];
    const where = ['c.deleted_at IS NULL'];
    if (opts.patientId) { params.push(opts.patientId); where.push(`c.patient_id = $${params.length}`); }
    if (opts.payerId) { params.push(opts.payerId); where.push(`c.payer_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); where.push(`c.status = $${params.length}`); }
    if (opts.invoiceId) { params.push(opts.invoiceId); where.push(`c.invoice_id = $${params.length}`); }
    if (opts.query) {
      params.push(`%${opts.query}%`);
      where.push(`(c.claim_number ILIKE $${params.length} OR c.external_reference ILIKE $${params.length} OR p.full_name ILIKE $${params.length})`);
    }
    params.push(opts.limit ?? 200);

    const { rows } = await client.query(
      `SELECT c.*, i.reference AS invoice_reference, p.full_name AS patient_name,
              p.reference AS patient_reference, s.name AS scheme_name, pay.name AS payer_name,
              u.display_name AS provider_name
         FROM luminary.claim c
         LEFT JOIN luminary.invoice i ON i.id = c.invoice_id
         JOIN luminary.patient p ON p.id = c.patient_id
         LEFT JOIN luminary.scheme s ON s.id = c.scheme_id
         LEFT JOIN luminary.payer pay ON pay.id = c.payer_id
         LEFT JOIN luminary.app_user u ON u.id = c.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY c.created_at DESC, c.claim_number DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  async find(client: PoolClient, id: string): Promise<CanonicalClaim | null> {
    const { rows } = await client.query(
      `SELECT c.*, i.reference AS invoice_reference, p.full_name AS patient_name,
              p.reference AS patient_reference, p.date_of_birth, p.sex, p.national_id,
              p.principal_member, p.dependant_code, p.member_suffix AS patient_member_suffix,
              p.relationship_to_member AS patient_relationship_to_member,
              s.name AS scheme_name, pay.name AS payer_name
         FROM luminary.claim c
         LEFT JOIN luminary.invoice i ON i.id = c.invoice_id
         JOIN luminary.patient p ON p.id = c.patient_id
         LEFT JOIN luminary.scheme s ON s.id = c.scheme_id
         LEFT JOIN luminary.payer pay ON pay.id = c.payer_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id],
    );
    const claim = rows[0] as CanonicalClaim | undefined;
    if (!claim) return null;
    const [lines, diagnoses, attachments] = await Promise.all([
      client.query(`SELECT * FROM luminary.claim_line WHERE claim_id = $1 AND deleted_at IS NULL ORDER BY line_number`, [id]),
      client.query(`SELECT * FROM luminary.claim_diagnosis WHERE claim_id = $1 AND deleted_at IS NULL ORDER BY kind, sequence`, [id]),
      client.query(
        `SELECT ca.*, d.filename, d.content_type, d.byte_size
           FROM luminary.claim_attachment ca
           JOIN luminary.patient_document d ON d.id = ca.document_id
          WHERE ca.claim_id = $1 AND ca.deleted_at IS NULL
          ORDER BY ca.created_at`,
        [id],
      ),
    ]);
    return { ...claim, lines: lines.rows, diagnoses: diagnoses.rows, attachments: attachments.rows };
  },

  async createFromInvoice(client: PoolClient, input: {
    invoiceId: string; encounterId?: string | null; channel: SubmissionChannel; createdBy: string;
  }) {
    const { rows: existing } = await client.query(
      `SELECT id FROM luminary.claim WHERE invoice_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [input.invoiceId],
    );
    if (existing[0]) return this.find(client, existing[0].id);

    const { rows } = await client.query(
      `SELECT i.id, i.patient_id, i.issued_on, i.currency, i.total, i.scheme_portion,
              s.id AS scheme_id,
              CASE WHEN s.id IS NULL THEN NULL ELSE p.member_number END AS member_number,
              p.dependant_code, p.member_suffix,
              p.principal_member, p.relationship_to_member, s.payer_id
         FROM luminary.invoice i
         JOIN luminary.patient p ON p.id = i.patient_id
         LEFT JOIN luminary.scheme s ON s.id = p.scheme_id
          AND s.active
          AND s.deleted_at IS NULL
          AND (p.cover_effective_from IS NULL OR p.cover_effective_from <= i.issued_on)
          AND (p.cover_valid_until IS NULL OR p.cover_valid_until >= i.issued_on)
          AND COALESCE(p.cover_status, '') NOT ILIKE 'Suspended%'
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [input.invoiceId],
    );
    const invoice = rows[0];
    if (!invoice) return null;

    const claimNumber = await this.nextClaimNumber(client);
    const { rows: created } = await client.query(
      `INSERT INTO luminary.claim
         (practice_id, claim_number, patient_id, encounter_id, invoice_id, payer_id, scheme_id,
          membership_number, member_suffix, member_name, relationship_to_member,
          service_from_date, service_to_date, currency, total_claimed_amount,
          member_liability, insurer_liability, submission_channel, created_by, status)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $11, $12, $13::numeric,
               GREATEST($13::numeric - COALESCE($14::numeric, 0), 0::numeric),
               COALESCE($14::numeric, 0), $15, $16, 'DRAFT')
       RETURNING *`,
      [
        claimNumber, invoice.patient_id, input.encounterId ?? null, invoice.id, invoice.payer_id ?? null,
        invoice.scheme_id ?? null, invoice.member_number ?? null, invoice.member_suffix ?? invoice.dependant_code ?? null,
        invoice.principal_member ?? null, invoice.relationship_to_member ?? null, invoice.issued_on,
        invoice.currency, invoice.total, invoice.scheme_portion, input.channel, input.createdBy,
      ],
    );
    await this.copyInvoiceLines(client, created[0].id, input.createdBy);
    return this.find(client, created[0].id);
  },

  async copyInvoiceLines(client: PoolClient, claimId: string, actorId?: string) {
    const { rows: exists } = await client.query(`SELECT 1 FROM luminary.claim_line WHERE claim_id = $1 AND deleted_at IS NULL LIMIT 1`, [claimId]);
    if (exists.length > 0) return;

    await client.query(
      `INSERT INTO luminary.claim_line
         (practice_id, claim_id, invoice_line_id, service_id, line_number, tariff_code,
          tariff_description, quantity, unit_price, claimed_amount, insurer_liability,
          member_liability, service_date, practitioner_id, status)
       SELECT luminary.current_practice_id(), c.id, il.id, il.service_id,
              row_number() over (ORDER BY il.created_at, il.id)::int,
              il.tariff_code, il.description, il.quantity, il.unit_price,
              il.quantity * il.unit_price,
              COALESCE(il.actual_funder_approved, il.estimated_funder, il.scheme_pays, 0),
              GREATEST((il.quantity * il.unit_price) - COALESCE(il.actual_funder_approved, il.estimated_funder, il.scheme_pays, 0), 0),
              COALESCE(c.service_from_date, i.issued_on),
              COALESCE(e.author_id, p.primary_provider_id, $2::uuid),
              'DRAFT'
         FROM luminary.claim c
         JOIN luminary.invoice i ON i.id = c.invoice_id
         JOIN luminary.patient p ON p.id = c.patient_id
         LEFT JOIN luminary.encounter e ON e.id = c.encounter_id
         JOIN luminary.invoice_line il ON il.invoice_id = i.id AND il.deleted_at IS NULL
        WHERE c.id = $1`,
      [claimId, actorId ?? null],
    );
    await this.recomputeTotals(client, claimId);
  },

  async copyEncounterDiagnoses(client: PoolClient, claimId: string) {
    const { rows: claimRows } = await client.query(`SELECT encounter_id FROM luminary.claim WHERE id = $1`, [claimId]);
    const encounterId = claimRows[0]?.encounter_id;
    if (!encounterId) return;
    const { rows: exists } = await client.query(`SELECT 1 FROM luminary.claim_diagnosis WHERE claim_id = $1 AND deleted_at IS NULL LIMIT 1`, [claimId]);
    if (exists.length > 0) return;

    const { rows } = await client.query(`SELECT diagnoses FROM luminary.encounter WHERE id = $1 AND deleted_at IS NULL`, [encounterId]);
    const diagnoses = Array.isArray(rows[0]?.diagnoses) ? rows[0].diagnoses : [];
    let sequence = 1;
    for (const entry of diagnoses) {
      const code = String(entry?.code ?? '').trim();
      if (!code) continue;
      await client.query(
        `INSERT INTO luminary.claim_diagnosis
           (practice_id, claim_id, code, description, kind, sequence, source)
         VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, 'encounter')`,
        [claimId, code, String(entry?.label ?? ''), sequence === 1 ? 'primary' : 'secondary', sequence],
      );
      sequence += 1;
    }
  },

  async addEvent(client: PoolClient, input: {
    claimId: string; type: string; actorId?: string | null; actorKind?: 'user' | 'system' | 'integration';
    previousStatus?: string | null; newStatus?: string | null; externalReference?: string | null; metadata?: unknown;
  }) {
    await client.query(
      `INSERT INTO luminary.claim_event
         (practice_id, claim_id, event_type, actor_id, actor_kind, previous_status,
          new_status, external_reference, metadata)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.claimId, input.type, input.actorId ?? null, input.actorKind ?? 'user',
        input.previousStatus ?? null, input.newStatus ?? null, input.externalReference ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  },

  async setStatus(client: PoolClient, claimId: string, status: ClaimStatus, fields: Record<string, unknown> = {}) {
    const allowed = new Map(Object.entries({
      external_reference: fields.external_reference,
      switch_reference: fields.switch_reference,
      submission_channel: fields.submission_channel,
      external_status: fields.external_status,
      funder_status: fields.funder_status,
      submitted_by: fields.submitted_by,
      submitted_at: fields.submitted_at,
      last_checked_at: fields.last_checked_at,
      completed_at: fields.completed_at,
      submission_snapshot: fields.submission_snapshot,
      validation_result: fields.validation_result,
      total_approved_amount: fields.total_approved_amount,
      total_rejected_amount: fields.total_rejected_amount,
      member_liability: fields.member_liability,
      insurer_liability: fields.insurer_liability,
    }).filter(([, value]) => value !== undefined));
    const values: unknown[] = [claimId, status];
    const assignments = ['status = $2', 'updated_at = now()'];
    for (const [column, value] of allowed) {
      values.push(column.endsWith('_snapshot') || column === 'validation_result' ? JSON.stringify(value) : value);
      assignments.push(`${column} = $${values.length}`);
    }
    const { rows } = await client.query(
      `UPDATE luminary.claim SET ${assignments.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  },

  async latestOutboundTransmission(client: PoolClient, claimId: string) {
    const { rows } = await client.query(
      `SELECT *
         FROM luminary.claim_transmission
        WHERE claim_id = $1
          AND direction = 'outbound'
          AND deleted_at IS NULL
        ORDER BY
          CASE status
            WHEN 'succeeded' THEN 0
            WHEN 'sent' THEN 1
            WHEN 'received' THEN 2
            WHEN 'pending' THEN 3
            ELSE 4
          END,
          created_at DESC,
          attempt_number DESC
        LIMIT 1`,
      [claimId],
    );
    return rows[0] ?? null;
  },

  async recordTransmission(client: PoolClient, input: {
    claimId: string; adapter: string; direction: 'outbound' | 'inbound'; status: string;
    requestReference?: string | null; externalReference?: string | null; normalizedResult?: unknown;
    errorCode?: string | null; errorMessage?: string | null;
  }) {
    const { rows } = await client.query<{ attempt: number }>(
      `SELECT COALESCE(max(attempt_number), 0) + 1 AS attempt
         FROM luminary.claim_transmission
        WHERE claim_id = $1 AND adapter = $2 AND direction = $3`,
      [input.claimId, input.adapter, input.direction],
    );
    await client.query(
      `INSERT INTO luminary.claim_transmission
         (practice_id, claim_id, adapter, direction, attempt_number, request_reference,
          external_reference, sent_at, received_at, status, normalized_result, error_code, error_message)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6,
               CASE WHEN $3 = 'outbound' THEN now() ELSE NULL END,
               CASE WHEN $3 = 'inbound' THEN now() ELSE NULL END,
               $7, $8, $9, $10)`,
      [
        input.claimId, input.adapter, input.direction, rows[0]!.attempt,
        input.requestReference ?? null, input.externalReference ?? null, input.status,
        JSON.stringify(input.normalizedResult ?? {}), input.errorCode ?? null, input.errorMessage ?? null,
      ],
    );
  },

  async recomputeTotals(client: PoolClient, claimId: string) {
    const { rows } = await client.query(
      `WITH totals AS (
         SELECT COALESCE(sum(claimed_amount), 0) AS claimed,
                COALESCE(sum(approved_amount), 0) AS approved,
                COALESCE(sum(rejected_amount), 0) AS rejected,
                COALESCE(sum(member_liability), 0) AS member,
                COALESCE(sum(insurer_liability), 0) AS insurer
           FROM luminary.claim_line
          WHERE claim_id = $1 AND deleted_at IS NULL
       )
       UPDATE luminary.claim c
          SET total_claimed_amount = totals.claimed,
              total_approved_amount = totals.approved,
              total_rejected_amount = totals.rejected,
              member_liability = totals.member,
              insurer_liability = totals.insurer,
              updated_at = now()
         FROM totals
        WHERE c.id = $1
        RETURNING c.*`,
      [claimId],
    );
    return rows[0] ?? null;
  },
};
