import type { PoolClient } from 'pg';
import { catalogueRepository } from './catalogue.repository.js';
import { billingRepository } from '../billing/billing.repository.js';
import { can } from '../../platform/permissions.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';
import { requirePatientInTenant } from '../../platform/tenant-refs.js';
import type { Actor } from '../billing/billing.service.js';

/**
 * Catalogue, tariffs and the billing engine.
 *
 * Mirrors `lib/catalogue.js`, `lib/tariffs.js` and `lib/orders.js` in the
 * browser for the same reason the permission matrix is duplicated: that copy
 * decides what to *show* — a live estimate before anyone commits — while this
 * one decides what is *recorded*. Every rule there is re-checked here, and this
 * is the one that counts.
 *
 * Two rules matter more than the rest:
 *
 * **An estimate is not an approval.** What the tariff resolver returns is what
 * the practice expects a scheme to pay. It is written to `estimated_funder` and
 * never to the actual columns, so adjudication can overwrite what happened
 * without destroying what was predicted.
 *
 * **Never charge for work that did not happen.** Billing keys off the clinical
 * event, not the order, and a cancelled or declined order can never produce a
 * line however many times an event is replayed.
 */

export const TARIFF_SOURCES = {
  PLAN_TARIFF: 'plan tariff',
  PAYER_TARIFF: 'payer tariff',
  PLAN_PERCENT: 'plan percentage',
  UNCOVERED: 'no cover',
} as const;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const dateOnly = (value: unknown) => {
  if (!value) return today();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? today() : parsed.toISOString().slice(0, 10);
};

interface PlanRow { id: string; name: string; reimbursePercent: number }

export const catalogueService = {
  async listServices(client: PoolClient, actor: Actor, includeInactive = false) {
    if (!can(actor.role, 'createInvoice') && !can(actor.role, 'orderServices')) {
      throw new Forbidden('Your role does not include the service catalogue');
    }
    return catalogueRepository.listServices(client, { includeInactive });
  },

  async listPayers(client: PoolClient, actor: Actor) {
    if (!can(actor.role, 'createInvoice') && !can(actor.role, 'manageTariffs') && !can(actor.role, 'manageCover')) {
      throw new Forbidden('Your role does not include payer configuration');
    }
    return catalogueRepository.listPayers(client);
  },

  async createPayer(client: PoolClient, actor: Actor, input: { name: string; active?: boolean }) {
    if (!can(actor.role, 'manageCover') && !can(actor.role, 'manageConfiguration')) {
      throw new Forbidden('Your role cannot create payers');
    }
    const name = input.name.trim();
    if (!name) throw new BadRequest('Payer name is required');
    const payer = await catalogueRepository.createPayer(client, { name, active: input.active ?? true });
    await client.query(
      `SELECT luminary.write_audit('Created payer', 'payer', $1, $2, NULL, 'notice')`,
      [payer.id, payer.name],
    );
    return payer;
  },

  async createScheme(client: PoolClient, actor: Actor, input: {
    payerId: string; name: string; reimbursePercent?: number; requiresPreauth?: boolean; active?: boolean;
  }) {
    if (!can(actor.role, 'manageCover') && !can(actor.role, 'manageConfiguration')) {
      throw new Forbidden('Your role cannot create schemes');
    }
    const name = input.name.trim();
    if (!name) throw new BadRequest('Scheme name is required');
    const scheme = await catalogueRepository.createScheme(client, {
      payerId: input.payerId,
      name,
      reimbursePercent: input.reimbursePercent ?? 0,
      requiresPreauth: input.requiresPreauth ?? false,
      active: input.active ?? true,
    });
    if (!scheme) throw new NotFound('Payer not found');
    await client.query(
      `SELECT luminary.write_audit('Created scheme', 'scheme', $1, $2, $3, 'notice')`,
      [scheme.id, scheme.name, `${scheme.reimburse_percent}%`],
    );
    return scheme;
  },

  /**
   * Re-price a service from a date.
   *
   * Guarded by `manageTariffs`: changing a price changes what every patient is
   * charged from that date, which is a different authority from configuring a
   * room. Backdating is refused — a price that moves under invoices already
   * raised is how a practice loses the ability to explain its own books.
   */
  async repriceService(
    client: PoolClient,
    actor: Actor,
    input: { serviceId: string; amount: number; currency: string; effectiveFrom: string },
  ) {
    if (!can(actor.role, 'manageTariffs')) {
      throw new Forbidden('Your role cannot change service pricing');
    }
    if (input.amount < 0) throw new BadRequest('A price cannot be negative');
    if (input.effectiveFrom < today()) {
      throw new BadRequest('A new price cannot start in the past — invoices already raised must keep the price they were raised at');
    }

    const service = await catalogueRepository.findService(client, input.serviceId);
    if (!service) throw new NotFound('Service not found');

    const previous = await catalogueRepository.priceOn(client, input.serviceId, input.effectiveFrom);
    const price = await catalogueRepository.repriceService(client, { ...input, by: actor.userId });

    await client.query(
      `SELECT luminary.write_audit('Re-priced a service', 'service', $1, $2, $3, 'notice')`,
      [
        service.id,
        service.display_name,
        `${previous ? `${previous.currency} ${previous.amount}` : 'unpriced'} to ${input.currency} ${input.amount} from ${input.effectiveFrom}`,
      ],
    );

    return price;
  },

  /**
   * What a scheme is expected to pay for a charge.
   *
   * A negotiated rate where one exists; the plan's headline percentage where
   * none does. The fallback is not a convenience — a practice will never have a
   * tariff row for everything it does, and a system that could only bill what
   * had been imported would be unusable until the import was perfect.
   */
  async resolveTariff(
    client: PoolClient,
    input: {
      serviceId: string; payerId: string | null; plan: PlanRow | null;
      charge: number; on?: string; defaultCode?: string | null;
    },
  ) {
    const gross = round2(input.charge);
    const on = input.on ?? today();

    if (!input.payerId || !input.plan || Number(input.plan.reimbursePercent) === 0) {
      return { via: TARIFF_SOURCES.UNCOVERED, code: input.defaultCode ?? null, funder: 0, patient: gross };
    }

    const row = await catalogueRepository.resolveTariff(client, {
      serviceId: input.serviceId, payerId: input.payerId, planId: input.plan.id, on,
    });

    if (row) {
      // A schedule can list a rate above what this practice charges — it is a
      // negotiated maximum, not an instruction to bill more. Capped, because a
      // shortfall below zero is a credit balance appearing from nowhere.
      const funder = round2(Math.min(Number(row.rate), gross));
      return {
        via: row.plan_id ? TARIFF_SOURCES.PLAN_TARIFF : TARIFF_SOURCES.PAYER_TARIFF,
        code: row.code ?? input.defaultCode ?? null,
        tariffId: row.id as string,
        rate: Number(row.rate),
        funder,
        patient: round2(gross - funder),
      };
    }

    const funder = round2(gross * (Number(input.plan.reimbursePercent) / 100));
    return {
      via: TARIFF_SOURCES.PLAN_PERCENT,
      code: input.defaultCode ?? null,
      percent: Number(input.plan.reimbursePercent),
      funder,
      patient: round2(gross - funder),
    };
  },

  // --- orders --------------------------------------------------------------

  async listOrders(client: PoolClient, actor: Actor, opts: { status?: string; patientId?: string }) {
    if (!can(actor.role, 'orderServices') && !can(actor.role, 'checkIn') && !can(actor.role, 'createInvoice')) {
      throw new Forbidden('Your role does not include the order queue');
    }
    return catalogueRepository.listOrders(client, opts);
  },

  async createOrder(
    client: PoolClient,
    actor: Actor,
    input: { patientId: string; serviceId: string; encounterId?: string; quantity?: number; priority?: string; clinicalNotes?: string },
  ) {
    if (!can(actor.role, 'orderServices')) throw new Forbidden('Your role cannot order services');
    await requirePatientInTenant(client, input.patientId);

    const service = await catalogueRepository.findService(client, input.serviceId);
    if (!service) throw new NotFound('Service not found');
    if (!service.active) throw new Conflict(`${service.display_name} is not currently offered`);
    if (service.orderable === false) throw new Conflict(`${service.display_name} is not available for clinical ordering`);
    if (input.encounterId) {
      const belongs = await catalogueRepository.encounterBelongsToPatient(client, input.encounterId, input.patientId);
      if (!belongs) throw new BadRequest('That encounter does not belong to this patient');
    }

    const order = await catalogueRepository.createOrder(client, { ...input, by: actor.userId });

    await client.query(
      `SELECT luminary.write_audit('Ordered a service', 'clinical_order', $1, $2, $3, 'info')`,
      [order.id, service.display_name, input.priority ?? 'Routine'],
    );

    return order;
  },

  /**
   * Move an order along, and bill it if that is what the move means.
   *
   * Billing is a consequence of the clinical event rather than a separate step
   * someone has to remember — which is the whole point of a trigger. The engine
   * decides for itself whether the service's trigger has been reached.
   */
  async advanceOrder(
    client: PoolClient,
    actor: Actor,
    input: { id: string; status: string; reason?: string },
  ) {
    if (!can(actor.role, 'orderServices') && !can(actor.role, 'checkIn')) {
      throw new Forbidden('Your role cannot update orders');
    }

    const order = await catalogueRepository.findOrder(client, input.id);
    if (!order) throw new NotFound('Order not found');

    const stopping = input.status === 'Cancelled' || input.status === 'Declined';
    if (stopping && (input.reason ?? '').trim().length < 5) {
      throw new BadRequest('Say why this order was stopped');
    }

    const updated = await catalogueRepository.updateOrderStatus(client, {
      id: input.id, status: input.status, by: actor.userId, reason: input.reason ?? null,
    });

    await client.query(
      `SELECT luminary.write_audit($1, 'clinical_order', $2, $3, $4, $5)`,
      [
        stopping ? `Order ${input.status.toLowerCase()}` : 'Order advanced',
        order.id, order.service_name,
        stopping ? (input.reason ?? '') : input.status,
        stopping ? 'notice' : 'info',
      ],
    );

    const billing = stopping ? null : await this.runBillingEngine(client, actor, updated);
    return { order: updated, billing };
  },

  /**
   * Turn a billable order into an invoice line.
   *
   * Idempotent by construction: the key names the order *and* the trigger that
   * fired, is written onto the line, and is checked first. A completion event
   * can arrive twice — a retry, a replay, two people clicking — and the second
   * arrival must not charge the patient again. A unique index backs this up, so
   * even a race cannot produce two lines.
   */
  async runBillingEngine(client: PoolClient, actor: Actor, order: Record<string, unknown>) {
    const status = String(order.status);
    if (status === 'Cancelled' || status === 'Declined') {
      return { billed: false, reason: `${status} — never charge for work not done` };
    }

    const service = await catalogueRepository.findService(client, String(order.service_id));
    if (!service) return { billed: false, reason: 'No catalogue service for this order' };
    if (!service.billable) return { billed: false, reason: `${service.display_name} is not billable` };

    const trigger = String(service.billing_trigger);
    if (trigger === 'MANUAL') return { billed: false, reason: 'Billed manually by arrangement' };
    if (trigger === 'ON_COMPLETION' && status !== 'Completed') {
      return { billed: false, reason: 'Waiting for completion' };
    }

    const key = `${order.id}:${trigger}`;
    const existing = await catalogueRepository.lineForBillingKey(client, key);
    if (existing) return { billed: false, reason: 'Already billed', lineId: existing.id };

    const on = dateOnly(order.completed_at ?? order.ordered_at);
    const price = await catalogueRepository.priceOn(client, service.id, on);
    if (!price) return { billed: false, reason: `${service.display_name} has no price on ${on}` };

    const quantity = Number(order.quantity ?? 1);
    // Quantity multiplies the charge before the tariff resolves: a scheme pays
    // per unit, and rounding a per-unit share then multiplying drifts by a cent
    // per line at volume.
    const gross = round2(Number(price.amount) * quantity);

    const cover = await billingRepository.coverForPatient?.(client, String(order.patient_id));
    const tariff = await this.resolveTariff(client, {
      serviceId: service.id,
      payerId: cover?.payer_id ?? null,
      plan: cover?.plan ?? null,
      charge: gross,
      on,
      defaultCode: service.default_tariff_code,
    });

    const invoice = await billingRepository.openInvoiceForPatient(
      client, String(order.patient_id), price.currency, on,
    );

    const { rows } = await client.query(
      `INSERT INTO luminary.invoice_line
         (practice_id, invoice_id, origin, service_id, order_id, encounter_id,
          tariff_code, description, quantity, unit_price, scheme_pays,
          estimated_funder, tariff_id, tariff_via, billing_key)
       VALUES (luminary.current_practice_id(), $1, 'clinical', $2, $3, $4, $5, $6,
               $7, $8, $9, $9, $10, $11, $12)
       ON CONFLICT (practice_id, billing_key) WHERE billing_key IS NOT NULL AND deleted_at IS NULL
         DO NOTHING
       RETURNING *`,
      [
        invoice.id, service.id, order.id, order.encounter_id ?? null,
        tariff.code ?? service.default_tariff_code ?? '', service.billing_description,
        quantity, price.amount, tariff.funder,
        (tariff as { tariffId?: string }).tariffId ?? null, tariff.via, key,
      ],
    );

    // The insert lost a race with an identical event. Not an error: the charge
    // exists exactly once, which is what the key is for.
    if (rows.length === 0) return { billed: false, reason: 'Already billed' };

    await billingRepository.recomputeInvoiceTotals(client, invoice.id);
    await catalogueRepository.attachOrderInvoice(client, String(order.id), invoice.id);

    await client.query(
      `SELECT luminary.write_audit('Billed a completed order', 'invoice', $1, $2, $3, 'notice')`,
      [invoice.id, invoice.reference, `${service.display_name} ${price.currency} ${gross} (${order.id})`],
    );

    return {
      billed: true,
      line: rows[0],
      invoiceId: invoice.id,
      estimatedFunder: tariff.funder,
      estimatedPatient: tariff.patient,
      via: tariff.via,
    };
  },

  // --- imports -------------------------------------------------------------

  async listBatches(client: PoolClient, actor: Actor) {
    if (!can(actor.role, 'manageTariffs')) throw new Forbidden('Your role does not include tariff imports');
    return catalogueRepository.listBatches(client);
  },

  /**
   * Publish a reviewed batch of rates.
   *
   * The rows arriving here have already been parsed, mapped, validated and
   * approved by a person; this records the decision. Guarded by `manageTariffs`
   * because publishing a schedule changes what every patient on that scheme is
   * charged.
   */
  async publishTariffBatch(
    client: PoolClient,
    actor: Actor,
    input: { filename: string; payerId: string; mapping: unknown; counts: Record<string, number>; rows: Array<Record<string, unknown>> },
  ) {
    if (!can(actor.role, 'manageTariffs')) throw new Forbidden('Your role cannot publish tariffs');
    if (input.rows.length === 0) throw new BadRequest('Nothing to publish');

    const batch = await catalogueRepository.createBatch(client, {
      kind: 'tariff',
      filename: input.filename,
      payerId: input.payerId,
      mapping: input.mapping,
      rowCount: input.counts.total ?? input.rows.length,
      validCount: input.counts.valid ?? 0,
      warningCount: input.counts.warnings ?? 0,
      errorCount: input.counts.errors ?? 0,
      publishedCount: input.rows.length,
      status: 'PUBLISHED',
      by: actor.userId,
    });

    const published = await catalogueRepository.publishTariffs(client, {
      batchId: batch.id, rows: input.rows, by: actor.userId,
    });

    // Alert severity: this is the entry a reviewer most needs surfaced, because
    // it moves money for everyone on the scheme at once.
    await client.query(
      `SELECT luminary.write_audit('Published a tariff schedule', 'import_batch', $1, $2, $3, 'alert')`,
      [batch.id, input.filename, `${published.length} rates`],
    );

    return { batch, published: published.length };
  },

  async publishServiceBatch(
    client: PoolClient,
    actor: Actor,
    input: { filename: string; mapping: unknown; counts: Record<string, number>; rows: Array<Record<string, unknown>> },
  ) {
    if (!can(actor.role, 'manageTariffs')) throw new Forbidden('Your role cannot publish service catalogues');
    if (input.rows.length === 0) throw new BadRequest('Nothing to publish');

    const batch = await catalogueRepository.createBatch(client, {
      kind: 'service',
      filename: input.filename,
      mapping: input.mapping,
      rowCount: input.counts.total ?? input.rows.length,
      validCount: input.counts.valid ?? 0,
      warningCount: input.counts.warnings ?? 0,
      errorCount: input.counts.errors ?? 0,
      publishedCount: input.rows.length,
      status: 'PUBLISHED',
      by: actor.userId,
    });

    const published = await catalogueRepository.publishServices(client, {
      batchId: batch.id, rows: input.rows, by: actor.userId,
    });

    await client.query(
      `SELECT luminary.write_audit('Published a service catalogue', 'import_batch', $1, $2, $3, 'alert')`,
      [batch.id, input.filename, `${published.length} services`],
    );

    return { batch, published: published.length };
  },

  async rollbackBatch(client: PoolClient, actor: Actor, batchId: string) {
    if (!can(actor.role, 'manageTariffs')) throw new Forbidden('Your role cannot roll back tariffs');

    const reverted = await catalogueRepository.rollbackBatch(client, batchId);

    await client.query(
      `SELECT luminary.write_audit('Rolled back a tariff schedule', 'import_batch', $1, $2, $3, 'alert')`,
      [batchId, batchId, `${reverted} rates deactivated, prior periods reopened, invoices unchanged`],
    );

    return { reverted };
  },

  async addAlias(
    client: PoolClient,
    actor: Actor,
    input: { serviceId: string; alias: string; payerId?: string | null },
  ) {
    if (!can(actor.role, 'manageTariffs')) throw new Forbidden('Your role cannot change service aliases');
    if ((input.alias ?? '').trim().length === 0) throw new BadRequest('An alias cannot be empty');

    const service = await catalogueRepository.findService(client, input.serviceId);
    if (!service) throw new NotFound('Service not found');

    const alias = await catalogueRepository.addAlias(client, {
      serviceId: input.serviceId, alias: input.alias, source: 'import',
      payerId: input.payerId ?? null, by: actor.userId,
    });
    if (!alias) throw new Conflict('That alias already points at this service');

    await client.query(
      `SELECT luminary.write_audit('Confirmed a service alias', 'service', $1, $2, $3, 'notice')`,
      [service.id, service.display_name, `"${alias.alias}" will match ${service.display_name} in future imports`],
    );

    return alias;
  },
};
