import type { PoolClient } from 'pg';

/**
 * Catalogue, tariff and order storage.
 *
 * Every query here answers a question of the form "what applied on this date?".
 * That framing is the point: a price is not a number but a number with a period
 * attached, and an invoice raised in August has to keep resolving August's
 * figures however many times the practice re-prices afterwards.
 *
 * The date arithmetic lives in SQL rather than in TypeScript deliberately —
 * `current_date` on the database is one clock, and a resolution that depended
 * on the caller's clock would give two answers to the same question depending
 * on which node asked.
 */
export const catalogueRepository = {
  async listServices(client: PoolClient, opts: { includeInactive?: boolean } = {}) {
    const { rows } = await client.query(
      `SELECT s.*,
              p.amount   AS price_amount,
              p.currency AS price_currency,
              p.effective_from AS price_from,
              COALESCE(
                (SELECT array_agg(a.alias ORDER BY a.alias)
                   FROM luminary.service_alias a
                  WHERE a.service_id = s.id AND a.deleted_at IS NULL),
                '{}'
              ) AS aliases,
              (SELECT count(*)::int
                 FROM luminary.tariff t
                WHERE t.service_id = s.id
                  AND t.deleted_at IS NULL AND t.active
                  AND t.effective_from <= current_date
                  AND (t.effective_to IS NULL OR t.effective_to >= current_date)
              ) AS tariff_count
         FROM luminary.service s
         -- The price period in force today. A lateral join rather than a
         -- correlated subquery per column, so one row is chosen once.
         LEFT JOIN LATERAL (
           SELECT sp.amount, sp.currency, sp.effective_from
             FROM luminary.service_price sp
            WHERE sp.service_id = s.id
              AND sp.deleted_at IS NULL
              AND sp.effective_from <= current_date
              AND (sp.effective_to IS NULL OR sp.effective_to >= current_date)
            ORDER BY sp.effective_from DESC
            LIMIT 1
         ) p ON true
        WHERE s.deleted_at IS NULL
          AND ($1::boolean OR s.active)
        ORDER BY s.department, s.display_name`,
      [opts.includeInactive ?? false],
    );
    return rows;
  },

  async findService(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.service WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  /**
   * The practice's own price on a date.
   *
   * Takes the date rather than assuming today, because a line on a historical
   * invoice has to be explainable and a claim resubmitted next month must not
   * silently re-price itself.
   */
  async priceOn(client: PoolClient, serviceId: string, on: string) {
    const { rows } = await client.query(
      `SELECT amount, currency, effective_from, effective_to
         FROM luminary.service_price
        WHERE service_id = $1
          AND deleted_at IS NULL
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC
        LIMIT 1`,
      [serviceId, on],
    );
    return rows[0] ?? null;
  },

  /**
   * Re-price without destroying what it used to cost.
   *
   * The period in force is closed the day before the new one opens rather than
   * being edited. A catalogue that overwrites its own prices cannot answer
   * "why was this invoice 40?" six months later, which is the question an
   * auditor actually asks.
   */
  async repriceService(
    client: PoolClient,
    input: { serviceId: string; amount: number; currency: string; effectiveFrom: string; by: string },
  ) {
    await client.query(
      `UPDATE luminary.service_price
          SET effective_to = ($2::date - 1)
        WHERE service_id = $1
          AND deleted_at IS NULL
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [input.serviceId, input.effectiveFrom],
    );

    const { rows } = await client.query(
      `INSERT INTO luminary.service_price
         (practice_id, service_id, amount, currency, effective_from, created_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4::date, $5)
       RETURNING *`,
      [input.serviceId, input.amount, input.currency, input.effectiveFrom, input.by],
    );
    return rows[0];
  },

  async addAlias(
    client: PoolClient,
    input: { serviceId: string; alias: string; source: string; payerId?: string | null; by: string },
  ) {
    const { rows } = await client.query(
      `INSERT INTO luminary.service_alias
         (practice_id, service_id, alias, source, payer_id, approved_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5)
       ON CONFLICT (practice_id, service_id, alias) DO NOTHING
       RETURNING *`,
      [input.serviceId, input.alias.trim(), input.source, input.payerId ?? null, input.by],
    );
    return rows[0] ?? null;
  },

  async listPayers(client: PoolClient) {
    const { rows } = await client.query(
      `SELECT p.*,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'id', pl.id, 'name', pl.name,
                          'reimbursePercent', pl.reimburse_percent,
                          'requiresPreAuth', pl.requires_preauth,
                          'active', pl.active) ORDER BY pl.name)
                   FROM luminary.scheme pl
                  WHERE pl.payer_id = p.id AND pl.deleted_at IS NULL),
                '[]'::json
              ) AS plans
         FROM luminary.payer p
        WHERE p.deleted_at IS NULL AND p.active
        ORDER BY p.name`,
    );
    return rows;
  },

  async createPayer(client: PoolClient, input: { name: string; active: boolean }) {
    const { rows } = await client.query(
      `INSERT INTO luminary.payer (practice_id, name, active)
       VALUES (luminary.current_practice_id(), $1, $2)
       ON CONFLICT (practice_id, name) DO UPDATE
          SET active = EXCLUDED.active, updated_at = now(), deleted_at = NULL
       RETURNING *`,
      [input.name, input.active],
    );
    return rows[0];
  },

  async createScheme(client: PoolClient, input: {
    payerId: string; name: string; reimbursePercent: number; requiresPreauth: boolean; active: boolean;
  }) {
    const { rows } = await client.query(
      `INSERT INTO luminary.scheme
         (practice_id, payer_id, name, reimburse_percent, requires_preauth, active)
       SELECT luminary.current_practice_id(), p.id, $2, $3, $4, $5
         FROM luminary.payer p
        WHERE p.id = $1 AND p.deleted_at IS NULL
       ON CONFLICT (practice_id, payer_id, name) WHERE deleted_at IS NULL DO UPDATE
          SET reimburse_percent = EXCLUDED.reimburse_percent,
              requires_preauth = EXCLUDED.requires_preauth,
              active = EXCLUDED.active,
              updated_at = now(),
              deleted_at = NULL
       RETURNING *`,
      [input.payerId, input.name, input.reimbursePercent, input.requiresPreauth, input.active],
    );
    return rows[0] ?? null;
  },

  /**
   * The tariff in force for a service, payer and plan on a date.
   *
   * A plan-specific rate outranks a payer-wide one, and a payer-wide row is a
   * schedule that did not distinguish plans — common, and useful. Ordered so
   * the more specific row wins without two round trips.
   */
  async resolveTariff(
    client: PoolClient,
    input: { serviceId: string; payerId: string; planId: string | null; on: string },
  ) {
    const { rows } = await client.query(
      `SELECT *
         FROM luminary.tariff
        WHERE service_id = $1
          AND payer_id = $2
          AND deleted_at IS NULL AND active
          AND effective_from <= $4::date
          AND (effective_to IS NULL OR effective_to >= $4::date)
          AND (plan_id = $3 OR plan_id IS NULL)
        ORDER BY (plan_id IS NOT NULL) DESC, effective_from DESC
        LIMIT 1`,
      [input.serviceId, input.payerId, input.planId, input.on],
    );
    return rows[0] ?? null;
  },

  async listTariffs(client: PoolClient, opts: { serviceId?: string; payerId?: string; current?: boolean }) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.tariff
        WHERE deleted_at IS NULL
          AND ($1::uuid IS NULL OR service_id = $1)
          AND ($2::uuid IS NULL OR payer_id = $2)
          AND (NOT $3::boolean OR (active
               AND effective_from <= current_date
               AND (effective_to IS NULL OR effective_to >= current_date)))
        ORDER BY effective_from DESC`,
      [opts.serviceId ?? null, opts.payerId ?? null, opts.current ?? false],
    );
    return rows;
  },

  /**
   * Publish a batch of rates: supersede, never overwrite.
   *
   * Each incoming row closes the period of whatever it replaces the day before
   * it opens, and records which row replaced it. Nothing is deleted, so an
   * invoice raised under the old rate still resolves it — and a rollback has
   * something to reopen rather than something to restore.
   */
  async publishTariffs(
    client: PoolClient,
    input: { batchId: string; rows: Array<Record<string, unknown>>; by: string },
  ) {
    const published: Array<Record<string, unknown>> = [];

    for (const row of input.rows) {
      const { rows: inserted } = await client.query(
        `INSERT INTO luminary.tariff
           (practice_id, payer_id, plan_id, service_id, code, description,
            rate, currency, effective_from, effective_to, source, import_batch_id, created_by)
         VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, $12)
         RETURNING *`,
        [
          row.payerId, row.planId ?? null, row.serviceId, row.code, row.description ?? '',
          row.rate, row.currency, row.effectiveFrom, row.effectiveTo ?? null,
          row.source ?? null, input.batchId, input.by,
        ],
      );
      const created = inserted[0];

      await client.query(
        `UPDATE luminary.tariff
            SET effective_to = ($1::date - 1), superseded_by = $2
          WHERE id <> $2
            AND service_id = $3
            AND payer_id = $4
            AND plan_id IS NOT DISTINCT FROM $5
            AND deleted_at IS NULL AND active
            AND effective_from < $1::date
            AND (effective_to IS NULL OR effective_to >= $1::date)`,
        [row.effectiveFrom, created.id, row.serviceId, row.payerId, row.planId ?? null],
      );

      published.push(created);
    }

    return published;
  },

  async publishServices(
    client: PoolClient,
    input: { batchId: string; rows: Array<Record<string, unknown>>; by: string },
  ) {
    const published: Array<Record<string, unknown>> = [];

    for (const row of input.rows) {
      const { rows: inserted } = await client.query(
        `INSERT INTO luminary.service
           (practice_id, internal_code, display_name, clinical_name, billing_description,
            category, department, service_type, default_duration, default_quantity,
            billable, orderable, billing_trigger, default_tariff_code, notes, active, import_batch_id)
         VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (practice_id, internal_code)
         DO UPDATE SET display_name = EXCLUDED.display_name,
                       clinical_name = EXCLUDED.clinical_name,
                       billing_description = EXCLUDED.billing_description,
                       category = EXCLUDED.category,
                       department = EXCLUDED.department,
                       service_type = EXCLUDED.service_type,
                       default_duration = EXCLUDED.default_duration,
                       default_quantity = EXCLUDED.default_quantity,
                       billable = EXCLUDED.billable,
                       orderable = EXCLUDED.orderable,
                       billing_trigger = EXCLUDED.billing_trigger,
                       default_tariff_code = EXCLUDED.default_tariff_code,
                       notes = EXCLUDED.notes,
                       active = EXCLUDED.active,
                       import_batch_id = EXCLUDED.import_batch_id,
                       updated_at = now(),
                       deleted_at = NULL
         RETURNING *`,
        [
          row.internalCode, row.displayName, row.clinicalName ?? row.displayName,
          row.billingDescription ?? row.displayName, row.category ?? 'Consultation',
          row.department ?? 'General Practice', row.serviceType ?? 'service',
          row.defaultDuration ?? 15, row.defaultQuantity ?? 1,
          row.billable ?? true, row.orderable ?? true, row.billingTrigger ?? 'ON_COMPLETION',
          row.defaultTariffCode ?? null, row.notes ?? '', row.active ?? true, input.batchId,
        ],
      );
      const service = inserted[0];

      const prices = Array.isArray(row.price) ? row.price : [];
      for (const price of prices) {
        if (price?.amount === null || price?.amount === undefined || !price?.effectiveFrom) continue;
        await this.repriceService(client, {
          serviceId: service.id,
          amount: Number(price.amount),
          currency: String(price.currency ?? 'USD').toUpperCase(),
          effectiveFrom: String(price.effectiveFrom),
          by: input.by,
        });
      }

      const aliases = Array.isArray(row.aliases) ? row.aliases : [];
      for (const alias of aliases) {
        if (String(alias ?? '').trim()) {
          await this.addAlias(client, {
            serviceId: service.id,
            alias: String(alias),
            source: 'service_import',
            by: input.by,
          });
        }
      }

      published.push(service);
    }

    return published;
  },

  /**
   * Undo a batch without touching the books.
   *
   * The batch's rows are deactivated and the periods they closed reopen.
   * Invoices already raised at those rates are deliberately left alone: an
   * invoice states what was charged at the time, and re-pricing history to
   * match a corrected schedule would be falsifying the record, not fixing it.
   */
  async rollbackBatch(client: PoolClient, batchId: string) {
    await client.query(
      `UPDATE luminary.tariff
          SET effective_to = NULL, superseded_by = NULL
        WHERE superseded_by IN (
                SELECT id FROM luminary.tariff WHERE import_batch_id = $1
              )`,
      [batchId],
    );

    const { rows } = await client.query(
      `UPDATE luminary.tariff
          SET active = false, rolled_back_at = now()
        WHERE import_batch_id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [batchId],
    );

    await client.query(
      `UPDATE luminary.import_batch SET status = 'ROLLED_BACK' WHERE id = $1`,
      [batchId],
    );

    return rows.length;
  },

  async createBatch(client: PoolClient, input: Record<string, unknown>) {
    const { rows } = await client.query(
      `INSERT INTO luminary.import_batch
         (practice_id, kind, filename, checksum, payer_id, mapping,
          row_count, valid_count, warning_count, error_count, published_count, status, imported_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.kind, input.filename, input.checksum ?? null, input.payerId ?? null,
        JSON.stringify(input.mapping ?? {}), input.rowCount ?? 0, input.validCount ?? 0,
        input.warningCount ?? 0, input.errorCount ?? 0, input.publishedCount ?? 0,
        input.status ?? 'UPLOADED', input.by,
      ],
    );
    return rows[0];
  },

  async listBatches(client: PoolClient) {
    const { rows } = await client.query(
      `SELECT b.*, u.full_name AS imported_by_name
         FROM luminary.import_batch b
         JOIN luminary.app_user u ON u.id = b.imported_by
        WHERE b.deleted_at IS NULL
        ORDER BY b.imported_at DESC`,
    );
    return rows;
  },

  // --- orders --------------------------------------------------------------

  async listOrders(client: PoolClient, opts: { status?: string; patientId?: string }) {
    const { rows } = await client.query(
      `SELECT o.*, p.full_name AS patient_name, s.display_name AS service_name,
              s.department, s.billing_trigger, s.billable,
              u.display_name AS ordered_by_name
         FROM luminary.clinical_order o
         JOIN luminary.patient p ON p.id = o.patient_id
         JOIN luminary.service s ON s.id = o.service_id
         JOIN luminary.app_user u ON u.id = o.ordered_by
        WHERE o.deleted_at IS NULL
          AND ($1::text IS NULL OR o.status = $1)
          AND ($2::uuid IS NULL OR o.patient_id = $2)
        ORDER BY o.ordered_at DESC`,
      [opts.status ?? null, opts.patientId ?? null],
    );
    return rows;
  },

  async findOrder(client: PoolClient, id: string) {
    const { rows } = await client.query(
      `SELECT o.*, p.full_name AS patient_name, s.billing_trigger, s.billable,
              s.display_name AS service_name, s.billing_description
         FROM luminary.clinical_order o
         JOIN luminary.patient p ON p.id = o.patient_id
         JOIN luminary.service s ON s.id = o.service_id
        WHERE o.id = $1 AND o.deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  },

  async encounterBelongsToPatient(client: PoolClient, encounterId: string, patientId: string) {
    const { rows } = await client.query(
      `SELECT 1 FROM luminary.encounter
        WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
      [encounterId, patientId],
    );
    return Boolean(rows[0]);
  },

  async createOrder(client: PoolClient, input: Record<string, unknown>) {
    const { rows } = await client.query(
      `INSERT INTO luminary.clinical_order
         (practice_id, patient_id, encounter_id, service_id, quantity, priority, clinical_notes, ordered_by)
       VALUES (luminary.current_practice_id(), $1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.patientId, input.encounterId ?? null, input.serviceId,
        input.quantity ?? 1, input.priority ?? 'Routine', input.clinicalNotes ?? '', input.by,
      ],
    );
    return rows[0];
  },

  async updateOrderStatus(
    client: PoolClient,
    input: { id: string; status: string; by: string; reason?: string | null },
  ) {
    const { rows } = await client.query(
      `UPDATE luminary.clinical_order
          SET status = $2,
              completed_at = CASE WHEN $2 = 'Completed' THEN now() ELSE completed_at END,
              completed_by = CASE WHEN $2 = 'Completed' THEN $3 ELSE completed_by END,
              cancellation_reason = COALESCE($4, cancellation_reason),
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [input.id, input.status, input.by, input.reason ?? null],
    );
    return rows[0] ?? null;
  },

  async attachOrderInvoice(client: PoolClient, orderId: string, invoiceId: string) {
    await client.query(
      `UPDATE luminary.clinical_order SET invoice_id = $2, updated_at = now() WHERE id = $1`,
      [orderId, invoiceId],
    );
  },

  /** Has this exact billing event already produced a line? */
  async lineForBillingKey(client: PoolClient, key: string) {
    const { rows } = await client.query(
      `SELECT * FROM luminary.invoice_line
        WHERE billing_key = $1 AND deleted_at IS NULL`,
      [key],
    );
    return rows[0] ?? null;
  },
};
