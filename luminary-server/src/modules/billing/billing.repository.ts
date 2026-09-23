import type { PoolClient } from 'pg';

/**
 * Billing data access.
 *
 * Money is the part of a clinical system people audit hardest, so two rules
 * shape everything here:
 *
 *   * A payment is never edited. Correcting one means writing a reversal that
 *     points at the original, so the history shows what happened rather than
 *     what someone later wished had happened.
 *   * `amount_paid` is derived from the payment rows, never incremented in
 *     place. A running total that can drift from its own ledger is a
 *     reconciliation problem waiting to happen.
 */

export const billingRepository = {
  async listInvoices(client: PoolClient, opts: { patientId?: string; status?: string; limit?: number }) {
    const params: unknown[] = [];
    const where = ['i.deleted_at IS NULL'];

    if (opts.patientId) { params.push(opts.patientId); where.push(`i.patient_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); where.push(`i.status = $${params.length}`); }
    params.push(opts.limit ?? 200);

    const { rows } = await client.query(
      `SELECT i.id, i.reference, i.issued_on, i.due_on, i.currency,
              i.total, i.scheme_portion, i.patient_portion, i.amount_paid, i.status,
              i.idempotency_key,
              p.full_name AS patient_name, p.reference AS patient_reference,
              CASE WHEN i.due_on < current_date AND i.status <> 'paid'
                   THEN current_date - i.due_on ELSE 0 END AS days_overdue
         FROM luminary.invoice i
         JOIN luminary.patient p ON p.id = i.patient_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.issued_on DESC, i.reference DESC
        LIMIT $${params.length}`,
      params,
    );
    return Promise.all(rows.map((row) => this.attachReceivableSummary(client, row)));
  },

  async findInvoice(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT i.*, p.full_name AS patient_name, s.name AS scheme_name, s.reimburse_percent
         FROM luminary.invoice i
         JOIN luminary.patient p ON p.id = i.patient_id
         LEFT JOIN luminary.scheme s ON s.id = p.scheme_id
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [id],
    );
    if (!rows[0]) return null;

    const [lines, payments] = await Promise.all([
      client.query(
        `SELECT il.id, il.origin, il.service_id, il.order_id, il.encounter_id,
                il.tariff_id, il.tariff_via, il.billing_key,
                il.tariff_code, il.description, il.quantity, il.unit_price,
                il.scheme_pays, il.estimated_funder,
                il.service_event_id, il.service_display_name_snapshot, il.line_source,
                il.exclusion_status, il.exclusion_reason, il.excluded_by, il.excluded_at,
                il.display_order, il.bespoke_price_agreement_id,
                svc.display_name AS service_name,
                o.status AS order_status,
                e.appointment_id
           FROM luminary.invoice_line il
           LEFT JOIN luminary.service svc ON svc.id = il.service_id
           LEFT JOIN luminary.clinical_order o ON o.id = il.order_id
           LEFT JOIN luminary.encounter e ON e.id = COALESCE(il.encounter_id, o.encounter_id)
          WHERE il.invoice_id = $1 AND il.deleted_at IS NULL
          ORDER BY il.display_order, il.created_at`,
        [id],
      ),
      client.query(
        `SELECT pay.id, pay.amount, pay.currency, pay.fx_rate, pay.method,
                pay.received_at, pay.reverses_id, pay.responsibility_bucket,
                pay.claim_id, pay.remittance_id, pay.payer_id, pay.payment_reference,
                c.claim_number, r.remittance_reference, payer.name AS payer_name,
                u.display_name AS received_by
           FROM luminary.payment pay
           JOIN luminary.app_user u ON u.id = pay.received_by
           LEFT JOIN luminary.claim c ON c.id = pay.claim_id
           LEFT JOIN luminary.claim_remittance r ON r.id = pay.remittance_id
           LEFT JOIN luminary.payer payer ON payer.id = pay.payer_id
          WHERE pay.invoice_id = $1 AND pay.deleted_at IS NULL
          ORDER BY pay.received_at`,
        [id],
      ),
    ]);

    return this.attachReceivableSummary(client, { ...rows[0], lines: lines.rows, payments: payments.rows });
  },

  /** The practice's reimbursement rate for this patient's scheme, as a fraction. */
  async schemeRateFor(client: PoolClient, patientId: string, on = new Date().toISOString().slice(0, 10)): Promise<number> {
    const { rows } = await client.query<{ rate: string | null }>(
      `SELECT s.reimburse_percent AS rate
         FROM luminary.patient p
         LEFT JOIN luminary.scheme s ON s.id = p.scheme_id AND s.active
        WHERE p.id = $1
          AND p.deleted_at IS NULL
          AND (p.cover_effective_from IS NULL OR p.cover_effective_from <= $2::date)
          AND (p.cover_valid_until IS NULL OR p.cover_valid_until >= $2::date)
          AND COALESCE(p.cover_status, '') NOT ILIKE 'Suspended%'`,
      [patientId, on],
    );
    return rows[0]?.rate ? Number(rows[0].rate) / 100 : 0;
  },

  async findPatientForBilling(client: PoolClient, patientId: string) {
    const { rows } = await client.query(
      `SELECT id, practice_id, full_name FROM luminary.patient
        WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    return rows[0] ?? null;
  },

  async nextInvoiceReference(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ next: string }>(
      `SELECT 'INV-' || to_char(now(), 'YYYY') || '-' ||
              lpad((COALESCE(max(NULLIF(regexp_replace(reference, '\\D', '', 'g'), '')::bigint), 0) % 10000 + 1)::text, 4, '0') AS next
         FROM luminary.invoice
        WHERE reference LIKE 'INV-' || to_char(now(), 'YYYY') || '-%'`,
    );
    return rows[0]!.next;
  },

  async createInvoice(
    client: PoolClient,
    input: {
      patientId: string;
      currency: string;
      dueInDays: number;
      idempotencyKey?: string | null;
      lines: Array<{
        origin: string;
        serviceId: string | null;
        orderId: string | null;
        encounterId: string | null;
        tariffId: string | null;
        tariffVia: string | null;
        code: string;
        description: string;
        quantity: number;
        unitPrice: number;
        schemePays: number;
        billingKey: string | null;
      }>;
    },
  ) {
    const reference = await this.nextInvoiceReference(client);

    const total = input.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
    const schemePortion = Math.round(input.lines.reduce((sum, l) => sum + l.schemePays, 0) * 100) / 100;
    const patientPortion = Math.round((total - schemePortion) * 100) / 100;

    const { rows } = await client.query(
      `INSERT INTO luminary.invoice
         (practice_id, patient_id, reference, due_on, currency, total, scheme_portion, patient_portion, status, idempotency_key)
       VALUES (luminary.current_practice_id(), $1, $2, current_date + $3::int, $4, $5, $6, $7, 'pending', $8)
       RETURNING *`,
      [input.patientId, reference, input.dueInDays, input.currency, total, schemePortion, patientPortion, input.idempotencyKey ?? null],
    );
    const invoice = rows[0];

    for (const line of input.lines) {
      await client.query(
        `INSERT INTO luminary.invoice_line
           (practice_id, invoice_id, origin, service_id, order_id, encounter_id,
            tariff_id, tariff_via, billing_key, tariff_code, description,
            quantity, unit_price, scheme_pays, estimated_funder)
         VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7,
                 $8, $9, $10, $11, $12, $13, $13)`,
        [
          invoice.id, line.origin, line.serviceId, line.orderId, line.encounterId,
          line.tariffId, line.tariffVia, line.billingKey, line.code, line.description,
          line.quantity, line.unitPrice, line.schemePays,
        ],
      );
    }

    await this.recomputePatientBalance(client, input.patientId);
    return invoice;
  },

  async nextClaimReference(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ next: string }>(
      `SELECT 'CLM-' || to_char(now(), 'YYYY') || '-' ||
              lpad((COALESCE(max(NULLIF(regexp_replace(claim_number, '\\D', '', 'g'), '')::bigint), 0) % 10000 + 1)::text, 4, '0') AS next
         FROM luminary.claim
        WHERE claim_number LIKE 'CLM-' || to_char(now(), 'YYYY') || '-%'`,
    );
    return rows[0]!.next;
  },

  async createClaimForInvoice(client: PoolClient, invoiceId: string) {
    const { rows: existing } = await client.query(
      `SELECT * FROM luminary.claim WHERE invoice_id = $1 AND deleted_at IS NULL`,
      [invoiceId],
    );
    if (existing[0]) return existing[0];

    const { rows: invoiceRows } = await client.query(
      `SELECT i.id, i.patient_id, i.scheme_portion, p.scheme_id, p.member_number, s.payer_id
         FROM luminary.invoice i
         JOIN luminary.patient p ON p.id = i.patient_id
         LEFT JOIN luminary.scheme s ON s.id = p.scheme_id AND s.deleted_at IS NULL
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [invoiceId],
    );
    const invoice = invoiceRows[0];
    if (!invoice || !invoice.scheme_id || Number(invoice.scheme_portion) <= 0) return null;

    const reference = await this.nextClaimReference(client);
    const { rows } = await client.query(
      `INSERT INTO luminary.claim
         (practice_id, invoice_id, patient_id, claim_number, payer_id, scheme_id, member_number,
          membership_number, currency, total_claimed_amount, insurer_liability, member_liability, status)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $6,
               COALESCE((SELECT currency FROM luminary.invoice WHERE id = $1), 'USD'),
               COALESCE((SELECT total FROM luminary.invoice WHERE id = $1), 0),
               COALESCE((SELECT scheme_portion FROM luminary.invoice WHERE id = $1), 0),
               GREATEST(COALESCE((SELECT total FROM luminary.invoice WHERE id = $1), 0) - COALESCE((SELECT scheme_portion FROM luminary.invoice WHERE id = $1), 0), 0),
               'DRAFT')
       RETURNING *`,
      [invoice.id, invoice.patient_id, reference, invoice.payer_id ?? null, invoice.scheme_id, invoice.member_number ?? null],
    );
    return rows[0];
  },

  async listClaims(client: PoolClient, opts: { patientId?: string; status?: string; limit?: number }) {
    const params: unknown[] = [];
    const where = ['c.deleted_at IS NULL'];
    if (opts.patientId) { params.push(opts.patientId); where.push(`c.patient_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); where.push(`c.status = $${params.length}`); }
    params.push(opts.limit ?? 200);

    const { rows } = await client.query(
      `SELECT c.*, c.claim_number AS reference, i.reference AS invoice_reference, i.total, i.currency,
              p.full_name AS patient_name, s.name AS scheme_name
         FROM luminary.claim c
         JOIN luminary.invoice i ON i.id = c.invoice_id
         JOIN luminary.patient p ON p.id = c.patient_id
         LEFT JOIN luminary.scheme s ON s.id = c.scheme_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.created_at DESC, c.claim_number DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  async findClaim(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT c.*, c.claim_number AS reference, i.reference AS invoice_reference, i.total, i.currency,
              p.full_name AS patient_name, s.name AS scheme_name
         FROM luminary.claim c
         JOIN luminary.invoice i ON i.id = c.invoice_id
         JOIN luminary.patient p ON p.id = c.patient_id
         LEFT JOIN luminary.scheme s ON s.id = c.scheme_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  async markClaimBiometric(client: PoolClient, id: string, biometricRef: string | null) {
    const { rows } = await client.query(
      `UPDATE luminary.claim
          SET status = 'READY_FOR_SUBMISSION',
              biometric_at = now(),
              biometric_ref = COALESCE($2, biometric_ref),
              responses = responses || jsonb_build_array(jsonb_build_object(
                'label', 'Biometric verified',
                'time', now(),
                'tone', 'success',
                'ref', $2
              ))
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, biometricRef],
    );
    return rows[0] ?? null;
  },

  async submitClaim(client: PoolClient, id: string, switchRef: string | null) {
    const { rows } = await client.query(
      `UPDATE luminary.claim
          SET status = 'SUBMITTED',
              submitted_at = now(),
              switch_ref = COALESCE($2, switch_ref),
              responses = responses || jsonb_build_array(jsonb_build_object(
                'label', 'Submitted to NH263 queue',
                'time', now(),
                'tone', 'warm',
                'ref', $2
              ))
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, switchRef],
    );
    return rows[0] ?? null;
  },

  async adjudicateClaim(
    client: PoolClient,
    id: string,
    input: { status: 'adjudicated' | 'remitted' | 'rejected'; response?: string; rejectionCode?: string },
  ) {
    const status = input.status === 'rejected' ? 'REJECTED' : 'APPROVED';
    const { rows } = await client.query(
      `UPDATE luminary.claim
          SET status = $2,
              rejection_code = CASE WHEN $2 = 'REJECTED' THEN $4 ELSE NULL END,
              responses = responses || jsonb_build_array(jsonb_build_object(
                'label', $3,
                'time', now(),
                'tone', CASE WHEN $2 = 'REJECTED' THEN 'alert' ELSE 'success' END,
                'code', $4
              ))
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id, status, input.response ?? claimStatusLabel(input.status), input.rejectionCode ?? null],
    );
    return rows[0] ?? null;
  },

  async recordPayment(
    client: PoolClient,
    input: {
      invoiceId: string; amount: number; currency: string; fxRate: number | null;
      method: string; receivedBy: string; reversesId?: string | null; idempotencyKey?: string | null;
      responsibilityBucket?: 'patient' | 'insurer'; claimId?: string | null; remittanceId?: string | null;
      payerId?: string | null; paymentReference?: string | null;
    },
  ) {
    const { rows } = await client.query(
      `INSERT INTO luminary.payment
         (practice_id, invoice_id, amount, currency, fx_rate, method, received_by,
          reverses_id, idempotency_key, responsibility_bucket, claim_id, remittance_id,
          payer_id, payment_reference)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8,
               $9, $10, $11, $12, $13)
       ON CONFLICT (practice_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [
        input.invoiceId, input.amount, input.currency, input.fxRate,
        input.method, input.receivedBy, input.reversesId ?? null, input.idempotencyKey ?? null,
        input.responsibilityBucket ?? 'patient', input.claimId ?? null, input.remittanceId ?? null,
        input.payerId ?? null, input.paymentReference ?? null,
      ],
    );
    return rows[0];
  },

  async invoiceForIdempotencyKey(client: PoolClient, key: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.invoice
        WHERE idempotency_key = $1 AND deleted_at IS NULL`,
      [key],
    );
    return rows[0] ?? null;
  },

  async paymentForIdempotencyKey(client: PoolClient, key: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.payment
        WHERE idempotency_key = $1 AND deleted_at IS NULL`,
      [key],
    );
    return rows[0] ?? null;
  },

  /**
   * Recomputes the invoice from its payment ledger. A reversal is a negative
   * amount, so summing handles corrections without special-casing them.
   */
  async settleInvoice(client: PoolClient, invoiceId: string) {
    const summary = await this.receivableSummary(client, invoiceId);
    const { rows } = await client.query(
      `WITH settled AS (
         SELECT COALESCE(sum(amount * COALESCE(fx_rate, 1)), 0) AS paid
           FROM luminary.payment
          WHERE invoice_id = $1 AND deleted_at IS NULL
       )
       , written AS (
         SELECT COALESCE(sum(amount), 0) AS adjusted
           FROM luminary.invoice_adjustment
          WHERE invoice_id = $1 AND deleted_at IS NULL
       )
       UPDATE luminary.invoice i
          SET amount_paid = settled.paid,
              amount_adjusted = written.adjusted,
              status = CASE
                WHEN $2::numeric <= 0 THEN
                  CASE WHEN written.adjusted > 0 AND settled.paid < i.total
                       THEN 'written_off' ELSE 'paid' END
                WHEN i.due_on < current_date           THEN 'overdue'
                WHEN settled.paid > 0                  THEN 'part_paid'
                ELSE 'pending'
              END
         FROM settled, written
        WHERE i.id = $1
        RETURNING i.*`,
      [invoiceId, summary.total_practice_outstanding],
    );
    const invoice = rows[0];
    if (invoice) await this.recomputePatientBalance(client, invoice.patient_id);
    return invoice ? this.attachReceivableSummary(client, invoice) : invoice;
  },

  /**
   * The registry balance is what reception quotes at the desk, so it is always
   * derived from outstanding invoices rather than adjusted incrementally.
   */
  async recomputePatientBalance(client: PoolClient, patientId: string): Promise<void> {
    await client.query(
      `UPDATE luminary.patient p
          SET balance = COALESCE((
                SELECT sum(GREATEST((CASE WHEN COALESCE(c.has_adjudication, false)
                         THEN COALESCE(c.member_liability, 0) ELSE i.patient_portion END)
                         + COALESCE(transfer.patient_transferred, 0)
                         - COALESCE(pay.patient_paid, 0)
                         - COALESCE(adj.patient_adjusted, 0), 0))
                  FROM luminary.invoice i
                  LEFT JOIN LATERAL (
                    SELECT bool_or(claim.total_approved_amount > 0 OR claim.total_rejected_amount > 0
                               OR claim.status IN ('APPROVED','PARTIALLY_APPROVED','REJECTED')
                               OR latest_adjudication.id IS NOT NULL) AS has_adjudication,
                           sum(COALESCE(latest_adjudication.member_liability, claim.member_liability, 0)) AS member_liability
                      FROM luminary.claim
                      LEFT JOIN LATERAL (
                        SELECT id, member_liability
                          FROM luminary.claim_adjudication
                         WHERE claim_id = claim.id AND deleted_at IS NULL
                         ORDER BY adjudicated_at DESC NULLS LAST, created_at DESC
                         LIMIT 1
                      ) latest_adjudication ON true
                     WHERE claim.invoice_id = i.id AND claim.deleted_at IS NULL
                  ) c ON true
                  LEFT JOIN LATERAL (
                    SELECT sum(amount * COALESCE(fx_rate, 1)) AS patient_paid
                      FROM luminary.payment
                     WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL
                  ) pay ON true
                  LEFT JOIN LATERAL (
                    SELECT sum(amount) AS patient_adjusted
                      FROM luminary.invoice_adjustment
                     WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL
                  ) adj ON true
                  LEFT JOIN LATERAL (
                    SELECT sum(amount) AS patient_transferred
                      FROM luminary.claim_denial_disposition
                     WHERE invoice_id = i.id AND disposition = 'PATIENT_RESPONSIBILITY' AND deleted_at IS NULL
                  ) transfer ON true
                 WHERE i.patient_id = p.id
                   AND i.deleted_at IS NULL
              ), 0)
        WHERE p.id = $1`,
      [patientId],
    );
  },

  async findPayment(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.payment WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  async practiceTimezone(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ timezone: string }>(
      `SELECT COALESCE(
                (SELECT timezone
                   FROM luminary.practice_settings
                  WHERE practice_id = luminary.current_practice_id()
                    AND deleted_at IS NULL),
                'Africa/Harare'
              ) AS timezone`,
    );
    return rows[0]?.timezone ?? 'Africa/Harare';
  },

  async currentBusinessDate(client: PoolClient, timezone: string): Promise<string> {
    const { rows } = await client.query<{ business_date: string }>(
      `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS business_date`,
      [timezone],
    );
    return rows[0]!.business_date;
  },

  async reportingPeriod(client: PoolClient, opts: { from?: string; to?: string }) {
    const { rows } = await client.query(
      `WITH tz AS (
         SELECT COALESCE(
                  (SELECT timezone FROM luminary.practice_settings
                    WHERE practice_id = luminary.current_practice_id()
                      AND deleted_at IS NULL),
                  'Africa/Harare'
                ) AS timezone
       ),
       bounds AS (
         SELECT COALESCE($1::date, $2::date, (now() AT TIME ZONE tz.timezone)::date) AS from_date,
                COALESCE($2::date, $1::date, (now() AT TIME ZONE tz.timezone)::date) AS to_date,
                tz.timezone
           FROM tz
       )
       SELECT to_char(from_date, 'YYYY-MM-DD') AS from,
              to_char(to_date, 'YYYY-MM-DD') AS to,
              timezone,
              (from_date::timestamp AT TIME ZONE timezone) AS start_at,
              ((to_date + 1)::timestamp AT TIME ZONE timezone) AS end_at
         FROM bounds`,
      [opts.from ?? null, opts.to ?? null],
    );
    return rows[0];
  },

  async listPayments(client: PoolClient, opts: {
    from?: string; to?: string; patientId?: string; invoiceId?: string; actorId?: string;
    method?: string; responsibilityBucket?: 'patient' | 'insurer'; claimId?: string; payerId?: string;
    reversalStatus?: 'original' | 'reversal' | 'reversed' | 'unreversed'; limit?: number;
  }) {
    const params: unknown[] = [opts.from ?? opts.to ?? null, opts.to ?? opts.from ?? null];
    const where = [
      'pay.practice_id = luminary.current_practice_id()',
      'pay.deleted_at IS NULL',
      '($1::date IS NULL OR pay.received_at >= (($1::date)::timestamp AT TIME ZONE tz.timezone))',
      '($2::date IS NULL OR pay.received_at < ((($2::date + 1)::timestamp) AT TIME ZONE tz.timezone))',
    ];

    const add = (value: unknown, clause: string) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (opts.patientId) add(opts.patientId, 'i.patient_id = ?');
    if (opts.invoiceId) add(opts.invoiceId, 'pay.invoice_id = ?');
    if (opts.actorId) add(opts.actorId, 'pay.received_by = ?');
    if (opts.method) add(opts.method, 'pay.method = ?');
    if (opts.responsibilityBucket) add(opts.responsibilityBucket, 'pay.responsibility_bucket = ?');
    if (opts.claimId) add(opts.claimId, 'pay.claim_id = ?');
    if (opts.payerId) add(opts.payerId, 'pay.payer_id = ?');
    if (opts.reversalStatus === 'original') where.push('pay.reverses_id IS NULL');
    if (opts.reversalStatus === 'reversal') where.push('pay.reverses_id IS NOT NULL');
    if (opts.reversalStatus === 'reversed') {
      where.push(`EXISTS (
        SELECT 1 FROM luminary.payment rev
         WHERE rev.reverses_id = pay.id
           AND rev.practice_id = luminary.current_practice_id()
           AND rev.deleted_at IS NULL
      )`);
    }
    if (opts.reversalStatus === 'unreversed') {
      where.push(`pay.reverses_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM luminary.payment rev
         WHERE rev.reverses_id = pay.id
           AND rev.practice_id = luminary.current_practice_id()
           AND rev.deleted_at IS NULL
      )`);
    }
    params.push(opts.limit ?? 500);

    const { rows } = await client.query(
      `WITH tz AS (
         SELECT COALESCE(
                  (SELECT timezone FROM luminary.practice_settings
                    WHERE practice_id = luminary.current_practice_id()
                      AND deleted_at IS NULL),
                  'Africa/Harare'
                ) AS timezone
       )
       SELECT pay.id AS payment_id,
              pay.invoice_id,
              i.reference AS invoice_reference,
              i.patient_id,
              p.reference AS patient_reference,
              p.full_name AS patient_name,
              pay.amount,
              pay.currency,
              pay.fx_rate,
              round(pay.amount * COALESCE(pay.fx_rate, 1), 2) AS applied_amount,
              i.currency AS invoice_currency,
              pay.responsibility_bucket,
              pay.method,
              pay.received_at,
              pay.received_by,
              u.display_name AS received_by_name,
              pay.payment_reference,
              pay.claim_id,
              c.claim_number,
              pay.remittance_id,
              r.remittance_reference,
              pay.payer_id,
              payer.name AS payer_name,
              pay.reverses_id,
              EXISTS (
                SELECT 1 FROM luminary.payment rev
                 WHERE rev.reverses_id = pay.id
                   AND rev.practice_id = luminary.current_practice_id()
                   AND rev.deleted_at IS NULL
              ) AS has_reversal,
              CASE
                WHEN pay.reverses_id IS NOT NULL THEN 'reversal'
                WHEN EXISTS (
                  SELECT 1 FROM luminary.payment rev
                   WHERE rev.reverses_id = pay.id
                     AND rev.practice_id = luminary.current_practice_id()
                     AND rev.deleted_at IS NULL
                ) THEN 'reversed'
                ELSE 'original'
              END AS reversal_status
         FROM luminary.payment pay
         JOIN tz ON true
         JOIN luminary.invoice i ON i.id = pay.invoice_id AND i.deleted_at IS NULL
         JOIN luminary.patient p ON p.id = i.patient_id AND p.deleted_at IS NULL
         JOIN luminary.app_user u ON u.id = pay.received_by AND u.deleted_at IS NULL
         LEFT JOIN luminary.claim c ON c.id = pay.claim_id AND c.deleted_at IS NULL
         LEFT JOIN luminary.claim_remittance r ON r.id = pay.remittance_id AND r.deleted_at IS NULL
         LEFT JOIN luminary.payer payer ON payer.id = pay.payer_id AND payer.deleted_at IS NULL
        WHERE ${where.join(' AND ')}
        ORDER BY pay.received_at, pay.id
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  async collectionsSummary(client: PoolClient, opts: { from?: string; to?: string }) {
    const period = await this.reportingPeriod(client, opts);
    const params = [period.start_at, period.end_at];
    const baseWhere = `
      pay.practice_id = luminary.current_practice_id()
      AND pay.deleted_at IS NULL
      AND pay.received_at >= $1::timestamptz
      AND pay.received_at < $2::timestamptz`;

    const totals = await client.query(
      `SELECT pay.currency,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount > 0 AND pay.responsibility_bucket = 'patient'), 0) AS gross_patient_payments,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount > 0 AND pay.responsibility_bucket = 'insurer'), 0) AS gross_insurer_payments,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount > 0), 0) AS total_gross_collections,
                COALESCE(abs(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount < 0)), 0) AS reversals,
                0::numeric AS refunds,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)), 0) AS net_collections,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.responsibility_bucket = 'patient'), 0) AS patient_collections,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.responsibility_bucket = 'insurer'), 0) AS insurer_collections,
                count(*)::int AS transaction_count,
                count(*) FILTER (WHERE pay.reverses_id IS NOT NULL)::int AS reversal_count
           FROM luminary.payment pay
          WHERE ${baseWhere}
          GROUP BY pay.currency
          ORDER BY pay.currency`,
      params,
    );
    const buckets = await client.query(
      `SELECT pay.currency,
                pay.responsibility_bucket,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount > 0), 0) AS gross,
                COALESCE(abs(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount < 0)), 0) AS reversals,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)), 0) AS net,
                count(*)::int AS transaction_count
          FROM luminary.payment pay
         WHERE ${baseWhere}
         GROUP BY pay.currency, pay.responsibility_bucket
         ORDER BY pay.currency, pay.responsibility_bucket`,
      params,
    );
    const methods = await client.query(
      `SELECT pay.currency,
                pay.method,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount > 0), 0) AS gross,
                COALESCE(abs(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount < 0)), 0) AS reversals,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)), 0) AS net,
                count(*)::int AS transaction_count
          FROM luminary.payment pay
         WHERE ${baseWhere}
         GROUP BY pay.currency, pay.method
         ORDER BY pay.currency, pay.method`,
      params,
    );
    const currencies = totals.rows.map((row) => ({
      currency: row.currency,
      grossPatientPayments: Number(row.gross_patient_payments),
      grossInsurerPayments: Number(row.gross_insurer_payments),
      totalGrossCollections: Number(row.total_gross_collections),
      reversals: Number(row.reversals),
      refunds: Number(row.refunds),
      netCollections: Number(row.net_collections),
      patientCollections: Number(row.patient_collections),
      insurerCollections: Number(row.insurer_collections),
      transactionCount: Number(row.transaction_count),
      reversalCount: Number(row.reversal_count),
      byResponsibilityBucket: buckets.rows.filter((item) => item.currency === row.currency).map(numberMoney),
      byMethod: methods.rows.filter((item) => item.currency === row.currency).map(numberMoney),
    }));

    return {
      period: {
        from: period.from,
        to: period.to,
        startAt: period.start_at,
        endAt: period.end_at,
      },
      timezone: period.timezone,
      currencyMode: currencies.length > 1 ? 'grouped' : 'single',
      currencies,
    };
  },

  async collectionsReport(client: PoolClient, opts: { from?: string; to?: string }) {
    const summary = await this.collectionsSummary(client, opts);
    const params = [summary.period.startAt, summary.period.endAt];
    const actors = await client.query(
      `SELECT pay.currency,
                pay.received_by AS actor_id,
                u.display_name AS actor_name,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount > 0), 0) AS gross,
                COALESCE(abs(sum(pay.amount * COALESCE(pay.fx_rate, 1)) FILTER (WHERE pay.amount < 0)), 0) AS reversals,
                COALESCE(sum(pay.amount * COALESCE(pay.fx_rate, 1)), 0) AS net,
                count(*)::int AS transaction_count
           FROM luminary.payment pay
           JOIN luminary.app_user u ON u.id = pay.received_by AND u.deleted_at IS NULL
          WHERE pay.practice_id = luminary.current_practice_id()
            AND pay.deleted_at IS NULL
            AND pay.received_at >= $1::timestamptz
            AND pay.received_at < $2::timestamptz
          GROUP BY pay.currency, pay.received_by, u.display_name
          ORDER BY pay.currency, u.display_name`,
      params,
    );
    const transactions = await this.listPayments(client, { from: summary.period.from, to: summary.period.to, limit: 1000 });

    return {
      ...summary,
      currencies: summary.currencies.map((currency) => ({
        ...currency,
        byActor: actors.rows.filter((item) => item.currency === currency.currency).map(numberMoney),
        transactions: transactions.filter((item) => item.currency === currency.currency),
      })),
    };
  },

  async agingSummary(client: PoolClient, asOf: string, timezone: string) {
    const { rows } = await client.query(
      `${collectionReceivableCte('$1::date')}
       SELECT currency,
              aging_bucket,
              lower(debtor_type) AS responsibility_bucket,
              count(*)::int AS invoices,
              round(sum(amount_outstanding), 2)::float8 AS outstanding
         FROM expanded
        WHERE amount_outstanding > 0
        GROUP BY currency, aging_bucket, debtor_type
        ORDER BY currency, aging_bucket, debtor_type`,
      [asOf],
    );
    return {
      asOf,
      timezone,
      historicalAsOfSupported: false,
      summary: rows.map((row) => ({
        currency: row.currency,
        agingBucket: row.aging_bucket,
        responsibilityBucket: row.responsibility_bucket,
        invoices: Number(row.invoices),
        outstanding: Number(row.outstanding),
      })),
    };
  },

  /** Accounts receivable, bucketed the way a practice manager chases it. */
  async agingReport(client: PoolClient, asOf: string, timezone: string) {
    const { rows } = await client.query(
      `WITH receivables AS (
         SELECT i.id AS invoice_id,
                i.reference AS invoice_reference,
                i.patient_id,
                p.reference AS patient_reference,
                p.full_name AS patient_name,
                first_claim.claim_id,
                first_claim.claim_number,
                i.currency,
                i.issued_on,
                i.due_on,
                COALESCE(i.due_on, i.issued_on) AS aging_date,
                GREATEST((CASE WHEN COALESCE(c.has_adjudication, false)
                          THEN COALESCE(c.member_liability, 0) ELSE i.patient_portion END)
                  + COALESCE(transfer.patient_transferred, 0)
                  - COALESCE(pay.patient_paid, 0) - COALESCE(adj.patient_adjusted, 0), 0) AS patient_receivable,
                GREATEST(CASE WHEN COALESCE(c.has_adjudication, false)
                          THEN COALESCE(c.insurer_liability, 0) ELSE i.scheme_portion END
                  - COALESCE(ipay.insurer_paid, 0) - COALESCE(iadj.insurer_adjusted, 0), 0) AS insurer_receivable,
                GREATEST(COALESCE(c.total_rejected_amount, 0)
                  - COALESCE(transfer.patient_transferred, 0) - COALESCE(dadj.denied_adjusted, 0), 0) AS unresolved_receivable
           FROM luminary.invoice i
           JOIN luminary.patient p ON p.id = i.patient_id AND p.deleted_at IS NULL
           LEFT JOIN LATERAL (
             SELECT id AS claim_id, claim_number
               FROM luminary.claim
              WHERE invoice_id = i.id AND deleted_at IS NULL
              ORDER BY created_at DESC LIMIT 1
           ) first_claim ON true
           LEFT JOIN LATERAL (
             SELECT bool_or(c.total_approved_amount > 0 OR c.total_rejected_amount > 0
                        OR c.status IN ('APPROVED','PARTIALLY_APPROVED','REJECTED')
                        OR latest_adjudication.id IS NOT NULL) AS has_adjudication,
                    sum(COALESCE(latest_adjudication.insurer_liability, c.insurer_liability, 0)) AS insurer_liability,
                    sum(COALESCE(latest_adjudication.member_liability, c.member_liability, 0)) AS member_liability,
                    sum(COALESCE(latest_adjudication.rejected_amount, c.total_rejected_amount, 0)) AS total_rejected_amount
               FROM luminary.claim c
               LEFT JOIN LATERAL (
                 SELECT id, insurer_liability, member_liability, rejected_amount
                   FROM luminary.claim_adjudication
                  WHERE claim_id = c.id AND deleted_at IS NULL
                  ORDER BY adjudicated_at DESC NULLS LAST, created_at DESC
                  LIMIT 1
               ) latest_adjudication ON true
              WHERE c.invoice_id = i.id AND c.deleted_at IS NULL
           ) c ON true
           LEFT JOIN LATERAL (SELECT sum(amount * COALESCE(fx_rate, 1)) AS patient_paid FROM luminary.payment WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL) pay ON true
           LEFT JOIN LATERAL (SELECT sum(amount * COALESCE(fx_rate, 1)) AS insurer_paid FROM luminary.payment WHERE invoice_id = i.id AND responsibility_bucket = 'insurer' AND deleted_at IS NULL) ipay ON true
           LEFT JOIN LATERAL (SELECT sum(amount) AS patient_adjusted FROM luminary.invoice_adjustment WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL) adj ON true
           LEFT JOIN LATERAL (SELECT sum(amount) AS insurer_adjusted FROM luminary.invoice_adjustment WHERE invoice_id = i.id AND responsibility_bucket = 'insurer' AND deleted_at IS NULL) iadj ON true
           LEFT JOIN LATERAL (SELECT sum(amount) AS denied_adjusted FROM luminary.invoice_adjustment WHERE invoice_id = i.id AND responsibility_bucket = 'denied' AND deleted_at IS NULL) dadj ON true
           LEFT JOIN LATERAL (SELECT sum(amount) AS patient_transferred FROM luminary.claim_denial_disposition WHERE invoice_id = i.id AND disposition = 'PATIENT_RESPONSIBILITY' AND deleted_at IS NULL) transfer ON true
          WHERE i.practice_id = luminary.current_practice_id()
            AND i.deleted_at IS NULL
       ),
       expanded AS (
         SELECT r.*, v.responsibility_bucket, v.amount_outstanding
           FROM receivables r
           CROSS JOIN LATERAL (VALUES
             ('patient'::text, r.patient_receivable),
             ('insurer'::text, r.insurer_receivable),
             ('unresolved'::text, r.unresolved_receivable)
           ) v(responsibility_bucket, amount_outstanding)
          WHERE v.amount_outstanding > 0
       )
       SELECT invoice_id,
              invoice_reference,
              patient_id,
              patient_reference,
              patient_name,
              claim_id,
              claim_number,
              currency,
              issued_on,
              due_on,
              aging_date,
              responsibility_bucket,
              amount_outstanding,
              GREATEST($1::date - aging_date, 0)::int AS age_days,
              CASE
                WHEN $1::date - aging_date <= 0  THEN 'current'
                WHEN $1::date - aging_date <= 30 THEN '1-30'
                WHEN $1::date - aging_date <= 60 THEN '31-60'
                WHEN $1::date - aging_date <= 90 THEN '61-90'
                ELSE '90+'
              END AS aging_bucket
         FROM expanded
        ORDER BY currency, aging_bucket, responsibility_bucket, aging_date, invoice_reference`,
      [asOf],
    );

    const summaryMap = new Map<string, {
      currency: string; agingBucket: string; responsibilityBucket: string; invoices: number; outstanding: number;
    }>();
    for (const row of rows) {
      const key = `${row.currency}:${row.aging_bucket}:${row.responsibility_bucket}`;
      const existing = summaryMap.get(key) ?? {
        currency: row.currency,
        agingBucket: row.aging_bucket,
        responsibilityBucket: row.responsibility_bucket,
        invoices: 0,
        outstanding: 0,
      };
      existing.invoices += 1;
      existing.outstanding += Number(row.amount_outstanding);
      summaryMap.set(key, existing);
    }

    return {
      asOf,
      timezone,
      historicalAsOfSupported: false,
      summary: Array.from(summaryMap.values()).map((row) => ({ ...row, outstanding: Math.round(row.outstanding * 100) / 100 })),
      rows: rows.map((row) => ({ ...row, amount_outstanding: Number(row.amount_outstanding) })),
    };
  },

  async createCollectionCase(client: PoolClient, input: {
    invoiceId: string; claimId?: string | null; debtorType: 'PATIENT' | 'INSURER' | 'UNRESOLVED_DENIAL';
    assignedTo?: string | null; nextActionAt?: string | null; status?: 'OPEN' | 'FOLLOW_UP' | 'DISPUTED' | 'RESOLVED';
  }) {
    const { rows: invoiceRows } = await client.query(
      `SELECT id, patient_id
         FROM luminary.invoice
        WHERE id = $1 AND deleted_at IS NULL`,
      [input.invoiceId],
    );
    const invoice = invoiceRows[0];
    if (!invoice) return null;

    const { rows: existing } = await client.query(
      `SELECT *
         FROM luminary.collection_case
        WHERE invoice_id = $1
          AND debtor_type = $2
          AND (($3::uuid IS NULL AND claim_id IS NULL) OR claim_id = $3::uuid)
          AND deleted_at IS NULL
        LIMIT 1`,
      [input.invoiceId, input.debtorType, input.claimId ?? null],
    );
    if (existing[0]) {
      const { rows } = await client.query(
        `UPDATE luminary.collection_case
            SET assigned_to = COALESCE($2, assigned_to),
                next_action_at = COALESCE($3::timestamptz, next_action_at),
                status = CASE WHEN status = 'RESOLVED' THEN 'OPEN' ELSE COALESCE($4, status) END,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [existing[0].id, input.assignedTo ?? null, input.nextActionAt ?? null, input.status ?? null],
      );
      return rows[0];
    }

    const { rows } = await client.query(
      `INSERT INTO luminary.collection_case
         (practice_id, invoice_id, claim_id, patient_id, debtor_type, status, assigned_to, next_action_at)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7::timestamptz)
       RETURNING *`,
      [
        input.invoiceId, input.claimId ?? null, invoice.patient_id, input.debtorType,
        input.status ?? 'OPEN', input.assignedTo ?? null, input.nextActionAt ?? null,
      ],
    );
    return rows[0];
  },

  async listCollectionCases(client: PoolClient, opts: {
    caseId?: string; debtorType?: 'PATIENT' | 'INSURER' | 'UNRESOLVED_DENIAL'; status?: string;
    assignedTo?: string; assignedToMe?: string; nextAction?: 'due' | 'overdue'; includeResolved?: boolean;
  } = {}) {
    const params: unknown[] = [];
    const where = opts.includeResolved || opts.caseId ? [] : ['e.amount_outstanding > 0'];
    if (opts.caseId) { params.push(opts.caseId); where.push(`cc.id = $${params.length}`); }
    if (opts.debtorType) { params.push(opts.debtorType); where.push(`e.debtor_type = $${params.length}`); }
    const assigned = opts.assignedToMe ?? opts.assignedTo;
    if (assigned) { params.push(assigned); where.push(`cc.assigned_to = $${params.length}`); }
    if (opts.status) {
      params.push(opts.status);
      where.push(`COALESCE(cc.status, 'OPEN') = $${params.length}`);
    } else if (!opts.includeResolved) {
      where.push(`COALESCE(cc.status, 'OPEN') <> 'RESOLVED'`);
    }
    if (opts.nextAction === 'due') where.push(`cc.next_action_at IS NOT NULL AND cc.next_action_at <= now()`);
    if (opts.nextAction === 'overdue') where.push(`cc.next_action_at IS NOT NULL AND cc.next_action_at < now()`);

    const { rows } = await client.query(
      `${collectionReceivableCte()}
       SELECT cc.id AS case_id,
              e.invoice_id,
              e.invoice_reference,
              e.claim_id,
              e.claim_number,
              e.patient_id,
              e.patient_reference,
              e.patient_name,
              e.payer_id,
              e.payer_name,
              e.debtor_type,
              COALESCE(cc.status, 'OPEN') AS status,
              cc.assigned_to,
              assignee.display_name AS assigned_to_name,
              cc.assigned_at,
              cc.next_action_at,
              cc.created_at AS case_created_at,
              cc.updated_at AS case_updated_at,
              cc.resolved_at,
              e.currency,
              e.amount_outstanding,
              e.aging_date,
              e.age_days,
              e.aging_bucket,
              latest_action.action_type AS latest_action_type,
              latest_action.note AS latest_action_note,
              latest_action.created_at AS latest_action_at,
              COALESCE(action_counts.actions, 0)::int AS action_count
         FROM expanded e
         LEFT JOIN luminary.collection_case cc
           ON cc.invoice_id = e.invoice_id
          AND cc.debtor_type = e.debtor_type
          AND ((cc.claim_id IS NULL AND e.claim_id IS NULL) OR cc.claim_id = e.claim_id)
          AND cc.deleted_at IS NULL
         LEFT JOIN luminary.app_user assignee ON assignee.id = cc.assigned_to AND assignee.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT action_type, note, created_at
             FROM luminary.collection_action
            WHERE collection_case_id = cc.id AND deleted_at IS NULL
            ORDER BY created_at DESC, id DESC
            LIMIT 1
         ) latest_action ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS actions
             FROM luminary.collection_action
            WHERE collection_case_id = cc.id AND deleted_at IS NULL
         ) action_counts ON true
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(cc.next_action_at, e.aging_date::timestamptz), e.aging_date, e.invoice_reference`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      amount_outstanding: Number(row.amount_outstanding),
      age_days: Number(row.age_days),
      action_count: Number(row.action_count),
    }));
  },

  async getCollectionCase(client: PoolClient, id: string) {
    const cases = await this.listCollectionCases(client, { caseId: id, includeResolved: true });
    const collectionCase = cases[0] ?? null;
    if (!collectionCase) return null;
    const { rows: actions } = await client.query(
      `SELECT a.id, a.collection_case_id, a.actor_id, u.display_name AS actor_name,
              a.action_type, a.note, a.next_action_at, a.reference, a.created_at
         FROM luminary.collection_action a
         JOIN luminary.app_user u ON u.id = a.actor_id
        WHERE a.collection_case_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.created_at, a.id`,
      [id],
    );
    return { ...collectionCase, actions };
  },

  async updateCollectionCase(client: PoolClient, id: string, input: {
    status?: 'OPEN' | 'FOLLOW_UP' | 'DISPUTED' | 'RESOLVED'; assignedTo?: string | null; nextActionAt?: string | null;
  }) {
    const values: unknown[] = [id];
    const set: string[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); set.push(sql.replace('?', `$${values.length}`)); };
    if (input.status !== undefined) add('status = ?', input.status);
    if (input.assignedTo !== undefined) add('assigned_to = ?', input.assignedTo);
    if (input.nextActionAt !== undefined) add('next_action_at = ?::timestamptz', input.nextActionAt);
    if (set.length === 0) return this.getCollectionCase(client, id);
    const { rows } = await client.query(
      `UPDATE luminary.collection_case
          SET ${set.join(', ')}, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      values,
    );
    return rows[0] ? this.getCollectionCase(client, id) : null;
  },

  async recordCollectionAction(client: PoolClient, input: {
    caseId: string; actorId: string; actionType: string; note: string; nextActionAt?: string | null; reference?: string | null;
  }) {
    const { rows } = await client.query(
      `INSERT INTO luminary.collection_action
         (practice_id, collection_case_id, actor_id, action_type, note, next_action_at, reference)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5::timestamptz, $6)
       RETURNING *`,
      [
        input.caseId, input.actorId, input.actionType, input.note.trim(),
        input.nextActionAt ?? null, input.reference ?? null,
      ],
    );
    if (input.nextActionAt) {
      await client.query(
        `UPDATE luminary.collection_case
            SET next_action_at = $2::timestamptz,
                status = CASE WHEN status = 'OPEN' THEN 'FOLLOW_UP' ELSE status END,
                updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [input.caseId, input.nextActionAt],
      );
    }
    return rows[0];
  },

  async recordAdjustment(
    client: PoolClient,
    input: {
      invoiceId: string; kind: 'write_off' | 'credit_note'; amount: number;
      currency: string; reason: string; decidedBy: string;
      responsibilityBucket?: 'patient' | 'insurer' | 'denied'; claimId?: string | null; claimLineId?: string | null;
    },
  ) {
    const { rows } = await client.query(
      `INSERT INTO luminary.invoice_adjustment
         (practice_id, invoice_id, kind, amount, currency, reason, decided_by,
          responsibility_bucket, claim_id, claim_line_id)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.invoiceId, input.kind, input.amount, input.currency, input.reason.trim(), input.decidedBy,
        input.responsibilityBucket ?? 'patient', input.claimId ?? null, input.claimLineId ?? null,
      ],
    );
    return rows[0];
  },

  async listWorkItems(client: PoolClient, opts: { status?: string } = {}) {
    const conditions = ['w.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (opts.status) {
      params.push(opts.status);
      conditions.push(`w.status = $${params.length}`);
    }
    const { rows } = await client.query(
      `SELECT w.*, p.full_name AS patient_name, p.id AS patient_reference,
              e.status AS encounter_status, e.signed_at, e.note_type,
              i.total AS draft_total, i.currency AS draft_currency,
              i.patient_portion, i.scheme_portion,
              (SELECT string_agg(DISTINCT COALESCE(il.service_display_name_snapshot, il.description), ', ')
                 FROM luminary.invoice_line il
                WHERE il.invoice_id = w.draft_invoice_id AND il.deleted_at IS NULL AND il.exclusion_status IS NULL
              ) AS service_summary,
              (SELECT count(*)::int FROM luminary.billing_clarification c
                WHERE c.work_item_id = w.id AND c.status = 'open' AND c.deleted_at IS NULL) AS open_clarifications
         FROM luminary.billing_work_item w
         JOIN luminary.patient p ON p.id = w.patient_id
         LEFT JOIN luminary.encounter e ON e.id = w.encounter_id
         LEFT JOIN luminary.invoice i ON i.id = w.draft_invoice_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY w.created_at DESC`,
      params,
    );
    return rows;
  },

  async findWorkItem(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT w.*, p.full_name AS patient_name
         FROM luminary.billing_work_item w
         JOIN luminary.patient p ON p.id = w.patient_id
        WHERE w.id = $1 AND w.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  async listBespokePriceAgreements(client: PoolClient, patientId: string) {
    const { rows } = await client.query(
      `SELECT a.*, s.display_name AS service_name, cb.display_name AS created_by_name, ab.display_name AS approved_by_name
         FROM luminary.bespoke_price_agreement a
         JOIN luminary.service s ON s.id = a.service_id
         JOIN luminary.app_user cb ON cb.id = a.created_by
         LEFT JOIN luminary.app_user ab ON ab.id = a.approved_by
        WHERE a.patient_id = $1 AND a.deleted_at IS NULL AND a.status IN ('pending', 'approved')
        ORDER BY a.created_at DESC`,
      [patientId],
    );
    return rows;
  },

  async listClarifications(client: PoolClient, workItemId: string) {
    const { rows } = await client.query(
      `SELECT c.*, req.display_name AS requested_by_name, resp.display_name AS responded_by_name
         FROM luminary.billing_clarification c
         JOIN luminary.app_user req ON req.id = c.requested_by
         LEFT JOIN luminary.app_user resp ON resp.id = c.responded_by
        WHERE c.work_item_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.requested_at`,
      [workItemId],
    );
    return rows;
  },

  async listAdjustments(client: PoolClient, invoiceId: string) {
    const { rows } = await client.query(
      `SELECT a.*, u.full_name AS decided_by_name
         FROM luminary.invoice_adjustment a
         JOIN luminary.app_user u ON u.id = a.decided_by
        WHERE a.invoice_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.decided_at`,
      [invoiceId],
    );
    return rows;
  },

  /**
   * A patient's whole account, oldest debt first.
   *
   * The invoice is the unit everywhere else, but it is not the unit the person
   * at the desk is thinking in: they ask what they owe, and mean all of it.
   * Ordered by due date because that is the order a tender is applied in, so
   * the list on the screen is the order money will actually land.
   */
  async statement(client: PoolClient, patientId: string) {
    const { rows } = await client.query(
      `SELECT i.id, i.reference, i.issued_on, i.due_on, i.currency,
              i.total, i.patient_portion, i.amount_paid, i.amount_adjusted, i.status,
              GREATEST((CASE WHEN COALESCE(c.has_adjudication, false)
                        THEN COALESCE(c.member_liability, 0) ELSE i.patient_portion END)
                + COALESCE(transfer.patient_transferred, 0)
                - COALESCE(pay.patient_paid, 0) - COALESCE(adj.patient_adjusted, 0), 0) AS outstanding,
              GREATEST(current_date - i.due_on, 0) AS days_overdue
         FROM luminary.invoice i
         LEFT JOIN LATERAL (
           SELECT bool_or(claim.total_approved_amount > 0 OR claim.total_rejected_amount > 0
                      OR claim.status IN ('APPROVED','PARTIALLY_APPROVED','REJECTED')
                      OR latest_adjudication.id IS NOT NULL) AS has_adjudication,
                  sum(COALESCE(latest_adjudication.member_liability, claim.member_liability, 0)) AS member_liability
             FROM luminary.claim
             LEFT JOIN LATERAL (
               SELECT id, member_liability
                 FROM luminary.claim_adjudication
                WHERE claim_id = claim.id AND deleted_at IS NULL
                ORDER BY adjudicated_at DESC NULLS LAST, created_at DESC
                LIMIT 1
             ) latest_adjudication ON true
            WHERE claim.invoice_id = i.id AND claim.deleted_at IS NULL
         ) c ON true
         LEFT JOIN LATERAL (
           SELECT sum(amount * COALESCE(fx_rate, 1)) AS patient_paid
             FROM luminary.payment
            WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL
         ) pay ON true
         LEFT JOIN LATERAL (
           SELECT sum(amount) AS patient_adjusted
             FROM luminary.invoice_adjustment
            WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL
         ) adj ON true
         LEFT JOIN LATERAL (
           SELECT sum(amount) AS patient_transferred
             FROM luminary.claim_denial_disposition
            WHERE invoice_id = i.id AND disposition = 'PATIENT_RESPONSIBILITY' AND deleted_at IS NULL
         ) transfer ON true
        WHERE i.patient_id = $1
          AND i.deleted_at IS NULL
          AND GREATEST((CASE WHEN COALESCE(c.has_adjudication, false)
                        THEN COALESCE(c.member_liability, 0) ELSE i.patient_portion END)
                + COALESCE(transfer.patient_transferred, 0)
                - COALESCE(pay.patient_paid, 0) - COALESCE(adj.patient_adjusted, 0), 0) > 0
        ORDER BY i.due_on NULLS LAST, i.issued_on`,
      [patientId],
    );

    const { rows: totals } = await client.query(
      `SELECT COALESCE(sum((CASE WHEN COALESCE(c.has_adjudication, false)
                    THEN COALESCE(c.member_liability, 0) ELSE i.patient_portion END)
                    + COALESCE(transfer.patient_transferred, 0)), 0) AS billed,
              COALESCE(sum(pay.patient_paid), 0) AS collected,
              COALESCE(sum(adj.patient_adjusted), 0) AS adjusted
         FROM luminary.invoice i
         LEFT JOIN LATERAL (
           SELECT bool_or(claim.total_approved_amount > 0 OR claim.total_rejected_amount > 0
                      OR claim.status IN ('APPROVED','PARTIALLY_APPROVED','REJECTED')
                      OR latest_adjudication.id IS NOT NULL) AS has_adjudication,
                  sum(COALESCE(latest_adjudication.member_liability, claim.member_liability, 0)) AS member_liability
             FROM luminary.claim
             LEFT JOIN LATERAL (
               SELECT id, member_liability
                 FROM luminary.claim_adjudication
                WHERE claim_id = claim.id AND deleted_at IS NULL
                ORDER BY adjudicated_at DESC NULLS LAST, created_at DESC
                LIMIT 1
             ) latest_adjudication ON true
            WHERE claim.invoice_id = i.id AND claim.deleted_at IS NULL
         ) c ON true
         LEFT JOIN LATERAL (SELECT sum(amount * COALESCE(fx_rate, 1)) AS patient_paid FROM luminary.payment WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL) pay ON true
         LEFT JOIN LATERAL (SELECT sum(amount) AS patient_adjusted FROM luminary.invoice_adjustment WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL) adj ON true
         LEFT JOIN LATERAL (SELECT sum(amount) AS patient_transferred FROM luminary.claim_denial_disposition WHERE invoice_id = i.id AND disposition = 'PATIENT_RESPONSIBILITY' AND deleted_at IS NULL) transfer ON true
        WHERE i.patient_id = $1 AND i.deleted_at IS NULL`,
      [patientId],
    );

    return { open: rows, totals: totals[0] };
  },

  async lineForBillingKey(client: PoolClient, key: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.invoice_line
        WHERE billing_key = $1 AND deleted_at IS NULL`,
      [key],
    );
    return rows[0] ?? null;
  },
  /**
   * The patient's cover, resolved to a payer and a plan.
   *
   * Returns the scheme as the plan, because that is what it is — see the note
   * on migration 016. Null cover is self-pay, which prices at zero rather than
   * falling through to the most generous plan on file: guessing high bills the
   * patient too little and the scheme too much, and that is the direction that
   * gets a claim rejected.
   */
  async coverForPatient(client: PoolClient, patientId: string, on = new Date().toISOString().slice(0, 10)) {
    const { rows } = await client.query(
      `SELECT s.id AS plan_id, s.name AS plan_name, s.reimburse_percent, s.payer_id
         FROM luminary.patient p
         JOIN luminary.scheme s ON s.id = p.scheme_id AND s.active AND s.deleted_at IS NULL
        WHERE p.id = $1
          AND p.deleted_at IS NULL
          AND (p.cover_effective_from IS NULL OR p.cover_effective_from <= $2::date)
          AND (p.cover_valid_until IS NULL OR p.cover_valid_until >= $2::date)
          AND COALESCE(p.cover_status, '') NOT ILIKE 'Suspended%'`,
      [patientId, on],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      payer_id: row.payer_id as string | null,
      plan: {
        id: row.plan_id as string,
        name: row.plan_name as string,
        reimbursePercent: Number(row.reimburse_percent),
      },
    };
  },

  /**
   * The patient's open invoice for a day, or a new one.
   *
   * A visit with three completed orders should produce one invoice, not three.
   * Scoped to the day and to unsettled invoices, so a charge never lands on
   * something the patient has already paid and walked away from.
   */
  async openInvoiceForPatient(client: PoolClient, patientId: string, currency: string, on: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.invoice
        WHERE patient_id = $1
          AND issued_on = $2::date
          AND currency = $3
          AND status <> 'paid'
          AND deleted_at IS NULL
        ORDER BY created_at
        LIMIT 1`,
      [patientId, on, currency],
    );
    if (rows[0]) return rows[0];

    const reference = await this.nextInvoiceReference(client);
    const { rows: created } = await client.query(
      `INSERT INTO luminary.invoice
         (practice_id, patient_id, reference, issued_on, due_on, currency)
       VALUES (luminary.current_practice_id(), $1, $2, $3::date, $3::date + 30, $4)
       RETURNING *`,
      [patientId, reference, on, currency],
    );
    return created[0];
  },

  /**
   * Recompute an invoice from its own lines.
   *
   * Derived rather than incremented. A running total updated on every insert
   * drifts the moment one of them fails halfway, and an invoice whose header
   * disagrees with its lines is unauditable. `scheme_portion` follows the best
   * information available per line — approved where the scheme has answered,
   * estimated where it has not — while each line keeps both figures.
   */
  async recomputeInvoiceTotals(client: PoolClient, invoiceId: string) {
    const { rows } = await client.query(
      `WITH totals AS (
         SELECT COALESCE(sum(unit_price * quantity), 0) AS gross,
                COALESCE(sum(COALESCE(actual_funder_approved, estimated_funder)), 0) AS funder
           FROM luminary.invoice_line
          WHERE invoice_id = $1 AND deleted_at IS NULL AND exclusion_status IS NULL
       )
       UPDATE luminary.invoice i
          SET total = totals.gross,
              scheme_portion = totals.funder,
              patient_portion = GREATEST(totals.gross - totals.funder, 0),
              updated_at = now()
         FROM totals
        WHERE i.id = $1
        RETURNING i.*`,
      [invoiceId],
    );
    const invoice = rows[0];
    if (invoice) await this.recomputePatientBalance(client, invoice.patient_id);
    return invoice;
  },

  async receivableSummary(client: PoolClient, invoiceId: string) {
    const { rows } = await client.query(
      `WITH invoice_row AS (
         SELECT * FROM luminary.invoice WHERE id = $1 AND deleted_at IS NULL
       ),
       claim_totals AS (
         SELECT COALESCE(bool_or(total_approved_amount > 0 OR total_rejected_amount > 0
                    OR status IN ('APPROVED','PARTIALLY_APPROVED','REJECTED')
                    OR latest_adjudication.id IS NOT NULL), false) AS has_adjudication,
                COALESCE(sum(COALESCE(latest_adjudication.insurer_liability, c.insurer_liability, 0)), 0) AS insurer_liability,
                COALESCE(sum(COALESCE(latest_adjudication.member_liability, c.member_liability, 0)), 0) AS member_liability,
                COALESCE(sum(COALESCE(latest_adjudication.rejected_amount, c.total_rejected_amount, 0)), 0) AS denied
           FROM luminary.claim c
           LEFT JOIN LATERAL (
             SELECT id, insurer_liability, member_liability, rejected_amount
               FROM luminary.claim_adjudication
              WHERE claim_id = c.id AND deleted_at IS NULL
              ORDER BY adjudicated_at DESC NULLS LAST, created_at DESC
              LIMIT 1
           ) latest_adjudication ON true
          WHERE c.invoice_id = $1 AND c.deleted_at IS NULL
       ),
       payment_totals AS (
         SELECT COALESCE(sum(amount * COALESCE(fx_rate, 1)) FILTER (WHERE responsibility_bucket = 'patient'), 0) AS patient_paid,
                COALESCE(sum(amount * COALESCE(fx_rate, 1)) FILTER (WHERE responsibility_bucket = 'insurer'), 0) AS insurer_paid
           FROM luminary.payment
          WHERE invoice_id = $1 AND deleted_at IS NULL
       ),
       adjustment_totals AS (
         SELECT COALESCE(sum(amount) FILTER (WHERE responsibility_bucket = 'patient'), 0) AS patient_adjusted,
                COALESCE(sum(amount) FILTER (WHERE responsibility_bucket = 'insurer'), 0) AS insurer_adjusted,
                COALESCE(sum(amount) FILTER (WHERE responsibility_bucket = 'denied'), 0) AS denied_adjusted,
                COALESCE(sum(amount), 0) AS adjusted
           FROM luminary.invoice_adjustment
          WHERE invoice_id = $1 AND deleted_at IS NULL
       ),
       disposition_totals AS (
         SELECT COALESCE(sum(amount) FILTER (WHERE disposition = 'PATIENT_RESPONSIBILITY'), 0) AS patient_transferred
           FROM luminary.claim_denial_disposition
          WHERE invoice_id = $1 AND deleted_at IS NULL
       )
       SELECT i.patient_portion AS estimated_patient_responsibility,
              i.scheme_portion AS estimated_insurer_responsibility,
              CASE WHEN c.has_adjudication THEN c.member_liability ELSE i.patient_portion END
                + d.patient_transferred AS patient_responsibility,
              CASE WHEN c.has_adjudication THEN c.insurer_liability ELSE i.scheme_portion END AS insurer_responsibility,
              c.denied AS denied_amount,
              d.patient_transferred AS denial_transferred_to_patient,
              a.denied_adjusted AS denial_adjusted,
              GREATEST(c.denied - d.patient_transferred - a.denied_adjusted, 0) AS unresolved_denied_amount,
              p.patient_paid,
              p.insurer_paid,
              a.patient_adjusted,
              a.insurer_adjusted,
              a.adjusted AS adjusted_amount,
              GREATEST((CASE WHEN c.has_adjudication THEN c.member_liability ELSE i.patient_portion END)
                + d.patient_transferred - p.patient_paid - a.patient_adjusted, 0) AS patient_outstanding,
              GREATEST((CASE WHEN c.has_adjudication THEN c.insurer_liability ELSE i.scheme_portion END)
                - p.insurer_paid - a.insurer_adjusted, 0) AS insurer_outstanding,
              GREATEST((CASE WHEN c.has_adjudication THEN c.member_liability ELSE i.patient_portion END)
                + d.patient_transferred - p.patient_paid - a.patient_adjusted, 0)
                + GREATEST((CASE WHEN c.has_adjudication THEN c.insurer_liability ELSE i.scheme_portion END)
                  - p.insurer_paid - a.insurer_adjusted, 0)
                + GREATEST(c.denied - d.patient_transferred - a.denied_adjusted, 0) AS total_practice_outstanding
         FROM invoice_row i, claim_totals c, payment_totals p, adjustment_totals a, disposition_totals d`,
      [invoiceId],
    );
    return rows[0] ?? {
      patient_outstanding: 0,
      insurer_outstanding: 0,
      unresolved_denied_amount: 0,
      total_practice_outstanding: 0,
    };
  },

  async attachReceivableSummary(client: PoolClient, invoice: Record<string, unknown>) {
    const summary = await this.receivableSummary(client, String(invoice.id));
    return { ...invoice, receivables: summary, ...summary };
  },
};


function claimStatusLabel(status: 'adjudicated' | 'remitted' | 'rejected'): string {
  if (status === 'adjudicated') return 'Claim adjudicated';
  if (status === 'remitted') return 'Remittance received';
  return 'Claim rejected';
}

function numberMoney<T extends Record<string, unknown>>(row: T): T {
  const converted: Record<string, unknown> = { ...row };
  for (const key of ['gross', 'reversals', 'net', 'transaction_count']) {
    if (converted[key] !== undefined) converted[key] = Number(converted[key]);
  }
  return converted as T;
}

function collectionReceivableCte(asOfExpression = 'current_date'): string {
  return `WITH receivables AS (
    SELECT i.id AS invoice_id,
           i.reference AS invoice_reference,
           i.patient_id,
           p.reference AS patient_reference,
           p.full_name AS patient_name,
           first_claim.claim_id,
           first_claim.claim_number,
           first_claim.payer_id,
           first_claim.payer_name,
           i.currency,
           COALESCE(i.due_on, i.issued_on) AS aging_date,
           GREATEST((CASE WHEN COALESCE(c.has_adjudication, false)
                     THEN COALESCE(c.member_liability, 0) ELSE i.patient_portion END)
             + COALESCE(transfer.patient_transferred, 0)
             - COALESCE(pay.patient_paid, 0) - COALESCE(adj.patient_adjusted, 0), 0) AS patient_receivable,
           GREATEST(CASE WHEN COALESCE(c.has_adjudication, false)
                     THEN COALESCE(c.insurer_liability, 0) ELSE i.scheme_portion END
             - COALESCE(ipay.insurer_paid, 0) - COALESCE(iadj.insurer_adjusted, 0), 0) AS insurer_receivable,
           GREATEST(COALESCE(c.total_rejected_amount, 0)
             - COALESCE(transfer.patient_transferred, 0) - COALESCE(dadj.denied_adjusted, 0), 0) AS unresolved_receivable
      FROM luminary.invoice i
      JOIN luminary.patient p ON p.id = i.patient_id AND p.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT c.id AS claim_id, c.claim_number, c.payer_id, payer.name AS payer_name
          FROM luminary.claim c
          LEFT JOIN luminary.payer payer ON payer.id = c.payer_id AND payer.deleted_at IS NULL
         WHERE c.invoice_id = i.id AND c.deleted_at IS NULL
         ORDER BY c.created_at DESC LIMIT 1
      ) first_claim ON true
      LEFT JOIN LATERAL (
        SELECT bool_or(claim.total_approved_amount > 0 OR claim.total_rejected_amount > 0
                   OR claim.status IN ('APPROVED','PARTIALLY_APPROVED','REJECTED')
                   OR latest_adjudication.id IS NOT NULL) AS has_adjudication,
               sum(COALESCE(latest_adjudication.insurer_liability, claim.insurer_liability, 0)) AS insurer_liability,
               sum(COALESCE(latest_adjudication.member_liability, claim.member_liability, 0)) AS member_liability,
               sum(COALESCE(latest_adjudication.rejected_amount, claim.total_rejected_amount, 0)) AS total_rejected_amount
          FROM luminary.claim
          LEFT JOIN LATERAL (
            SELECT id, insurer_liability, member_liability, rejected_amount
              FROM luminary.claim_adjudication
             WHERE claim_id = claim.id AND deleted_at IS NULL
             ORDER BY adjudicated_at DESC NULLS LAST, created_at DESC
             LIMIT 1
          ) latest_adjudication ON true
         WHERE claim.invoice_id = i.id AND claim.deleted_at IS NULL
      ) c ON true
      LEFT JOIN LATERAL (SELECT sum(amount * COALESCE(fx_rate, 1)) AS patient_paid FROM luminary.payment WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL) pay ON true
      LEFT JOIN LATERAL (SELECT sum(amount * COALESCE(fx_rate, 1)) AS insurer_paid FROM luminary.payment WHERE invoice_id = i.id AND responsibility_bucket = 'insurer' AND deleted_at IS NULL) ipay ON true
      LEFT JOIN LATERAL (SELECT sum(amount) AS patient_adjusted FROM luminary.invoice_adjustment WHERE invoice_id = i.id AND responsibility_bucket = 'patient' AND deleted_at IS NULL) adj ON true
      LEFT JOIN LATERAL (SELECT sum(amount) AS insurer_adjusted FROM luminary.invoice_adjustment WHERE invoice_id = i.id AND responsibility_bucket = 'insurer' AND deleted_at IS NULL) iadj ON true
      LEFT JOIN LATERAL (SELECT sum(amount) AS denied_adjusted FROM luminary.invoice_adjustment WHERE invoice_id = i.id AND responsibility_bucket = 'denied' AND deleted_at IS NULL) dadj ON true
      LEFT JOIN LATERAL (SELECT sum(amount) AS patient_transferred FROM luminary.claim_denial_disposition WHERE invoice_id = i.id AND disposition = 'PATIENT_RESPONSIBILITY' AND deleted_at IS NULL) transfer ON true
     WHERE i.practice_id = luminary.current_practice_id()
       AND i.deleted_at IS NULL
  ),
  expanded AS (
    SELECT r.*, v.debtor_type, v.amount_outstanding,
           GREATEST(${asOfExpression} - r.aging_date, 0)::int AS age_days,
           CASE
             WHEN ${asOfExpression} - r.aging_date <= 0  THEN 'current'
             WHEN ${asOfExpression} - r.aging_date <= 30 THEN '1-30'
             WHEN ${asOfExpression} - r.aging_date <= 60 THEN '31-60'
             WHEN ${asOfExpression} - r.aging_date <= 90 THEN '61-90'
             ELSE '90+'
           END AS aging_bucket
      FROM receivables r
      CROSS JOIN LATERAL (VALUES
        ('PATIENT'::text, r.patient_receivable),
        ('INSURER'::text, r.insurer_receivable),
        ('UNRESOLVED_DENIAL'::text, r.unresolved_receivable)
      ) v(debtor_type, amount_outstanding)
  )`;
}
