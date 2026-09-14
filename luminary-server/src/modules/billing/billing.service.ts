import type { PoolClient } from 'pg';
import { billingRepository } from './billing.repository.js';
import { can, type Role } from '../../platform/permissions.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors.js';
import { catalogueRepository, } from '../catalogue/catalogue.repository.js';
import { TARIFF_SOURCES } from '../catalogue/catalogue.service.js';
import { requireUserInTenant } from '../../platform/tenant-refs.js';

/**
 * Billing rules.
 *
 * Two things here are specific to operating in Zimbabwe rather than generic
 * accounting:
 *
 *   * **Dual currency.** A practice bills in one currency but collects in
 *     either, often on the same day. A payment therefore carries its own
 *     currency and the rate applied at the moment it was taken — not the rate
 *     today. Re-deriving history from a current rate would silently rewrite what
 *     the patient actually handed over.
 *
 *   * **Cash is normal.** Most collections are cash or EcoCash at the desk, so
 *     receipting has to be a first-class action rather than an afterthought
 *     bolted onto an invoice.
 */

export interface Actor {
  userId: string;
  role: Role;
  practiceId: string;
}

const METHODS = ['cash', 'ecocash', 'card', 'transfer', 'medical_aid'] as const;
export type PaymentMethod = (typeof METHODS)[number];
const RESPONSIBILITY_BUCKETS = ['patient', 'insurer'] as const;
const REVERSAL_STATUSES = ['original', 'reversal', 'reversed', 'unreversed'] as const;
const COLLECTION_DEBTOR_TYPES = ['PATIENT', 'INSURER', 'UNRESOLVED_DENIAL'] as const;
const COLLECTION_STATUSES = ['OPEN', 'FOLLOW_UP', 'DISPUTED', 'RESOLVED'] as const;
const COLLECTION_ACTION_TYPES = ['NOTE', 'PHONE_CALL', 'FOLLOW_UP', 'EMAIL', 'WHATSAPP', 'STATUS_CHANGE', 'ASSIGNMENT'] as const;

type InvoiceLineInput = {
  origin?: 'manual' | 'clinical';
  serviceId?: string | null;
  orderId?: string | null;
  encounterId?: string | null;
  code?: string;
  description?: string;
  quantity: number;
  unitPrice?: number;
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export const billingService = {
  async listInvoices(client: PoolClient, actor: Actor, opts: { patientId?: string; status?: string }) {
    if (!can(actor.role, 'createInvoice') && !can(actor.role, 'recordPayment')) {
      throw new Forbidden('Your role does not include billing');
    }
    return billingRepository.listInvoices(client, opts);
  },

  async getInvoice(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'createInvoice') && !can(actor.role, 'recordPayment')) {
      throw new Forbidden('Your role does not include billing');
    }
    const invoice = await billingRepository.findInvoice(client, id);
    if (!invoice) throw new NotFound('Invoice not found');
    // Adjustments travel with the invoice. A balance that went away without a
    // payment behind it is exactly the thing a reader needs the explanation for.
    const adjustments = await billingRepository.listAdjustments(client, id);
    return { ...invoice, adjustments };
  },

  /**
   * Raise an invoice. The scheme's reimbursement rate comes from configuration,
   * never a constant — it differs per scheme and the practice changes it
   * without a deployment.
   */
  async createInvoice(
    client: PoolClient,
    actor: Actor,
    input: {
      patientId: string;
      currency: string;
      dueInDays?: number;
      idempotencyKey?: string;
      lines: InvoiceLineInput[];
    },
  ) {
    if (!can(actor.role, 'createInvoice')) throw new Forbidden('Your role cannot raise invoices');
    if (input.lines.length === 0) throw new BadRequest('An invoice needs at least one line');
    if (input.lines.some((l) => (l.unitPrice ?? 0) < 0 || l.quantity <= 0)) {
      throw new BadRequest('Quantities must be positive and prices cannot be negative');
    }

    const patient = await billingRepository.findPatientForBilling(client, input.patientId);
    if (!patient) throw new NotFound('Patient not found');
    if (input.idempotencyKey) {
      const existing = await billingRepository.invoiceForIdempotencyKey(client, input.idempotencyKey);
      if (existing) {
        if (existing.patient_id !== input.patientId) {
          throw new Conflict('That invoice idempotency key was already used for another invoice');
        }
        const full = await billingRepository.findInvoice(client, existing.id);
        return { ...full, claim: await billingRepository.createClaimForInvoice(client, existing.id), idempotent: true };
      }
    }

    const lines = await this.prepareInvoiceLines(client, input.patientId, input.lines);
    const invoice = await billingRepository.createInvoice(client, {
      patientId: input.patientId,
      currency: input.currency,
      dueInDays: input.dueInDays ?? 30,
      idempotencyKey: input.idempotencyKey ?? null,
      lines,
    });
    const claim = await billingRepository.createClaimForInvoice(client, invoice.id);

    await client.query(
      `SELECT luminary.write_audit('Raised invoice', 'invoice', $1, $2, $3, 'notice')`,
      [invoice.id, invoice.reference, `${invoice.currency} ${invoice.total}`],
    );
    return { ...invoice, claim };
  },

  async prepareInvoiceLines(client: PoolClient, patientId: string, inputLines: InvoiceLineInput[]) {
    return Promise.all(inputLines.map(async (line) => {
      const origin = line.origin ?? (line.orderId || line.serviceId || line.encounterId ? 'clinical' : 'manual');
      if (origin === 'manual') {
        if (!line.code?.trim() || !line.description?.trim() || line.unitPrice === undefined) {
          throw new BadRequest('Manual invoice lines need a code, description and unit price');
        }
        return {
          origin,
          serviceId: null,
          orderId: null,
          encounterId: null,
          tariffId: null,
          tariffVia: TARIFF_SOURCES.UNCOVERED,
          code: line.code.trim(),
          description: line.description.trim(),
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          schemePays: 0,
          billingKey: null,
        };
      }

      let serviceId = line.serviceId ?? null;
      let encounterId = line.encounterId ?? null;
      let billingKey: string | null = null;
      let order: Record<string, unknown> | null = null;

      if (line.orderId) {
        order = await catalogueRepository.findOrder(client, line.orderId);
        if (!order) throw new NotFound('Order not found');
        if (order.patient_id !== patientId) throw new BadRequest('That order does not belong to this invoice patient');
        if (['Cancelled', 'Declined'].includes(String(order.status))) {
          throw new Conflict('A stopped order cannot be billed');
        }
        serviceId = String(order.service_id);
        encounterId = encounterId ?? (order.encounter_id as string | null);
      }

      if (!serviceId) throw new BadRequest('Clinical invoice lines need a service or order');
      const service = await catalogueRepository.findService(client, serviceId);
      if (!service) throw new NotFound('Service not found');
      if (!service.active) throw new Conflict(`${service.display_name} is not currently offered`);
      if (!service.billable) throw new Conflict(`${service.display_name} is not billable`);

      if (encounterId) {
        const belongs = await catalogueRepository.encounterBelongsToPatient(client, encounterId, patientId);
        if (!belongs) throw new BadRequest('That encounter does not belong to this invoice patient');
      }

      const on = today();
      const cover = await billingRepository.coverForPatient(client, patientId, on);
      const price = await catalogueRepository.priceOn(client, service.id, on);
      if (!price) throw new BadRequest(`${service.display_name} has no price on ${on}`);

      const gross = round2(Number(price.amount) * line.quantity);
      let tariff = {
        via: TARIFF_SOURCES.UNCOVERED,
        code: service.default_tariff_code ?? null,
        funder: 0,
        patient: gross,
      } as { via: string; code: string | null; tariffId?: string; rate?: number; funder: number; patient: number };

      if (cover?.payer_id && cover.plan) {
        const row = await catalogueRepository.resolveTariff(client, {
          serviceId: service.id,
          payerId: cover.payer_id,
          planId: cover.plan.id,
          on,
        });
        if (row) {
          const funder = round2(Math.min(Number(row.rate), gross));
          tariff = {
            via: row.plan_id ? TARIFF_SOURCES.PLAN_TARIFF : TARIFF_SOURCES.PAYER_TARIFF,
            code: row.code ?? service.default_tariff_code ?? null,
            tariffId: row.id,
            rate: Number(row.rate),
            funder,
            patient: round2(gross - funder),
          };
        } else {
          const funder = round2(gross * (Number(cover.plan.reimbursePercent) / 100));
          tariff = {
            via: TARIFF_SOURCES.PLAN_PERCENT,
            code: service.default_tariff_code ?? null,
            funder,
            patient: round2(gross - funder),
          };
        }
      }

      if (order) {
        billingKey = `${order.id}:${service.billing_trigger}`;
        const existing = await billingRepository.lineForBillingKey(client, billingKey);
        if (existing) throw new Conflict('That clinical event has already been billed');
      }

      return {
        origin,
        serviceId: service.id,
        orderId: line.orderId ?? null,
        encounterId,
        tariffId: tariff.tariffId ?? null,
        tariffVia: tariff.via,
        code: tariff.code ?? service.default_tariff_code ?? '',
        description: service.billing_description,
        quantity: line.quantity,
        unitPrice: Number(price.amount),
        schemePays: tariff.funder,
        billingKey,
      };
    }));
  },

  /**
   * Take a payment.
   *
   * Recorded against the invoice, in whatever currency the patient actually
   * paid, with the rate used at the time. Overpayment is refused rather than
   * quietly held as credit — a practice needs to notice it at the desk, while
   * the patient is still standing there.
   */
  async recordPayment(
    client: PoolClient,
    actor: Actor,
    input: {
      invoiceId: string; amount: number; currency: string; fxRate?: number; method: PaymentMethod; idempotencyKey?: string;
      responsibilityBucket?: 'patient' | 'insurer'; claimId?: string; remittanceId?: string; payerId?: string; paymentReference?: string;
    },
  ) {
    if (!can(actor.role, 'recordPayment')) throw new Forbidden('Your role cannot record payments');
    if (input.amount <= 0) throw new BadRequest('A payment must be greater than zero');
    if (!METHODS.includes(input.method)) throw new BadRequest(`Unknown payment method: ${input.method}`);

    const invoice = await billingRepository.findInvoice(client, input.invoiceId);
    if (!invoice) throw new NotFound('Invoice not found');
    const responsibilityBucket = input.responsibilityBucket ?? (input.method === 'medical_aid' ? 'insurer' : 'patient');
    if (input.idempotencyKey) {
      const existing = await billingRepository.paymentForIdempotencyKey(client, input.idempotencyKey);
      if (existing) {
        if (existing.invoice_id !== input.invoiceId
          || Number(existing.amount) !== input.amount
          || existing.currency !== input.currency
          || existing.method !== input.method
          || existing.responsibility_bucket !== responsibilityBucket) {
          throw new Conflict('That payment idempotency key was already used for a different payment');
        }
        const settled = await billingRepository.settleInvoice(client, existing.invoice_id);
        return { payment: existing, invoice: settled, receipt: buildReceipt(invoice, existing, settled), idempotent: true };
      }
    }

    // A rate is required only when the tender differs from the billing currency.
    const sameCurrency = input.currency === invoice.currency;
    if (!sameCurrency && !input.fxRate) {
      throw new BadRequest(`Paying in ${input.currency} against a ${invoice.currency} invoice needs an exchange rate`);
    }
    const fxRate = sameCurrency ? 1 : input.fxRate!;

    const applied = Math.round(input.amount * fxRate * 100) / 100;
    if (responsibilityBucket === 'insurer' && !input.claimId) {
      throw new BadRequest('Insurer payments require the claim they settle');
    }
    if (responsibilityBucket === 'patient' && (input.claimId || input.remittanceId || input.payerId)) {
      throw new BadRequest('Patient payments should not carry insurer claim or remittance provenance');
    }
    if (input.method === 'medical_aid' && responsibilityBucket !== 'insurer') {
      throw new BadRequest('Medical aid payments must be allocated to the insurer receivable');
    }
    if (responsibilityBucket === 'insurer') {
      await assertInsurerPaymentProvenance(client, input.invoiceId, input.claimId!, input.remittanceId, input.payerId);
    }

    const receivables = await billingRepository.receivableSummary(client, input.invoiceId);
    const outstanding = round2(Number(
      responsibilityBucket === 'insurer' ? receivables.insurer_outstanding : receivables.patient_outstanding,
    ));

    if (outstanding <= 0) throw new Conflict('This invoice is already settled');
    if (applied > outstanding) {
      throw new Conflict(
        `That is more than the ${invoice.currency} ${outstanding.toFixed(2)} ${responsibilityBucket} outstanding. ` +
        'Take the exact amount, or raise a separate credit.',
      );
    }

    const payment = await billingRepository.recordPayment(client, {
      invoiceId: input.invoiceId,
      amount: input.amount,
      currency: input.currency,
      fxRate,
      method: input.method,
      receivedBy: actor.userId,
      idempotencyKey: input.idempotencyKey ?? null,
      responsibilityBucket,
      claimId: input.claimId ?? null,
      remittanceId: input.remittanceId ?? null,
      payerId: input.payerId ?? null,
      paymentReference: input.paymentReference ?? null,
    });

    const settled = await billingRepository.settleInvoice(client, input.invoiceId);

    await client.query(
      `SELECT luminary.write_audit('Recorded payment', 'invoice', $1, $2, $3, 'notice')`,
      [invoice.id, invoice.reference, `${input.currency} ${input.amount} by ${input.method} to ${responsibilityBucket}`],
    );

    return { payment, invoice: settled, receipt: buildReceipt(invoice, payment, settled) };
  },

  /**
   * Reverse a payment.
   *
   * Written as a counter-entry rather than deleting the original, so the ledger
   * shows the mistake and the correction. Money that can be quietly un-recorded
   * is money nobody can audit.
   */
  async reversePayment(client: PoolClient, actor: Actor, paymentId: string, reason: string) {
    if (!can(actor.role, 'recordPayment')) throw new Forbidden('Your role cannot reverse payments');
    if (reason.trim().length < 10) throw new BadRequest('Give a fuller reason for the reversal');

    const original = await billingRepository.findPayment(client, paymentId);
    if (!original) throw new NotFound('Payment not found');
    if (original.reverses_id) throw new Conflict('That entry is itself a reversal');

    const { rows: existing } = await client.query(
      `SELECT 1 FROM luminary.payment WHERE reverses_id = $1 AND deleted_at IS NULL`,
      [paymentId],
    );
    if (existing.length > 0) throw new Conflict('That payment has already been reversed');

    const reversal = await billingRepository.recordPayment(client, {
      invoiceId: original.invoice_id,
      amount: -Number(original.amount),
      currency: original.currency,
      fxRate: original.fx_rate,
      method: original.method,
      receivedBy: actor.userId,
      reversesId: paymentId,
      responsibilityBucket: original.responsibility_bucket,
      claimId: original.claim_id,
      remittanceId: original.remittance_id,
      payerId: original.payer_id,
      paymentReference: null,
    });

    const invoice = await billingRepository.settleInvoice(client, original.invoice_id);

    await client.query(
      `SELECT luminary.write_audit('Reversed payment', 'payment', $1, $2, $3, 'alert')`,
      [paymentId, original.currency + ' ' + original.amount, reason.trim()],
    );

    return { reversal, invoice };
  },

  /**
   * Write off, or credit, part of a balance.
   *
   * The counterpart to a payment: the debt is discharged, but no money
   * arrived. `recordPayment` has always refused an overpayment with the advice
   * to "raise a separate credit" — this is what raises it, and without it that
   * advice named a thing that did not exist.
   *
   * Guarded by `adjustBalance`, which reception does not hold. Taking money in
   * and deciding the practice will never collect are different decisions, and
   * one person holding both removes the only check on the second.
   */
  async adjustBalance(
    client: PoolClient,
    actor: Actor,
    input: {
      invoiceId: string; kind: 'write_off' | 'credit_note'; amount: number; reason: string;
      responsibilityBucket?: 'patient' | 'insurer' | 'denied'; claimId?: string; claimLineId?: string;
    },
  ) {
    if (!can(actor.role, 'adjustBalance')) {
      throw new Forbidden('Your role cannot write off or credit a balance');
    }
    if (input.amount <= 0) throw new BadRequest('An adjustment must be greater than zero');
    if (input.reason.trim().length < 10) {
      throw new BadRequest('Give a fuller reason. This is a permanent financial record.');
    }

    const invoice = await billingRepository.findInvoice(client, input.invoiceId);
    if (!invoice) throw new NotFound('Invoice not found');

    const responsibilityBucket = input.responsibilityBucket ?? 'patient';
    const receivables = await billingRepository.receivableSummary(client, input.invoiceId);
    const outstanding = round2(Number(
      responsibilityBucket === 'insurer'
        ? receivables.insurer_outstanding
        : responsibilityBucket === 'denied'
          ? receivables.unresolved_denied_amount
          : receivables.patient_outstanding,
    ));
    if (outstanding <= 0) throw new Conflict('Nothing is outstanding on this invoice');
    if (input.amount > outstanding) {
      throw new Conflict(
        `That is more than the ${invoice.currency} ${outstanding.toFixed(2)} ${responsibilityBucket} outstanding.`,
      );
    }

    const adjustment = await billingRepository.recordAdjustment(client, {
      invoiceId: input.invoiceId,
      kind: input.kind,
      amount: input.amount,
      currency: invoice.currency,
      reason: input.reason,
      decidedBy: actor.userId,
      responsibilityBucket,
      claimId: input.claimId ?? null,
      claimLineId: input.claimLineId ?? null,
    });

    const settled = await billingRepository.settleInvoice(client, input.invoiceId);

    // Alert severity, like a reversal. Money leaving the receivable with no
    // cash behind it is the entry a reviewer most needs surfaced.
    await client.query(
      `SELECT luminary.write_audit($1, 'invoice', $2, $3, $4, 'alert')`,
      [
        input.kind === 'write_off' ? 'Recorded write-off' : 'Recorded credit note',
        invoice.id,
        invoice.reference,
        `${invoice.currency} ${input.amount} · ${input.reason.trim()}`,
      ],
    );

    return { adjustment, invoice: settled };
  },

  /**
   * A patient's whole account.
   *
   * Readable by anyone who can already see the invoices it is made of — it
   * adds no facts, only the total the patient at the desk is actually asking
   * for.
   */
  async statement(client: PoolClient, actor: Actor, patientId: string) {
    if (!can(actor.role, 'createInvoice') && !can(actor.role, 'recordPayment')) {
      throw new Forbidden('Your role does not include billing');
    }
    const { open, totals } = await billingRepository.statement(client, patientId);
    const outstanding = open.reduce((sum, row) => sum + Number(row.outstanding), 0);

    return {
      patientId,
      currency: open[0]?.currency ?? 'ZWL',
      billed: Number(totals.billed),
      collected: Number(totals.collected),
      adjusted: Number(totals.adjusted),
      outstanding: Math.round(outstanding * 100) / 100,
      oldestDays: open.reduce((worst, row) => Math.max(worst, Number(row.days_overdue)), 0),
      open,
    };
  },

  async listPayments(
    client: PoolClient,
    actor: Actor,
    opts: {
      from?: string; to?: string; patientId?: string; invoiceId?: string; actorId?: string;
      method?: PaymentMethod; responsibilityBucket?: 'patient' | 'insurer';
      claimId?: string; payerId?: string; reversalStatus?: 'original' | 'reversal' | 'reversed' | 'unreversed';
    },
  ) {
    if (!can(actor.role, 'exportReports') && !can(actor.role, 'createInvoice') && !can(actor.role, 'recordPayment')) {
      throw new Forbidden('Your role does not include payment reporting');
    }
    validateReportingDates(opts.from, opts.to);
    if (opts.method && !METHODS.includes(opts.method)) throw new BadRequest(`Unknown payment method: ${opts.method}`);
    if (opts.responsibilityBucket && !RESPONSIBILITY_BUCKETS.includes(opts.responsibilityBucket)) {
      throw new BadRequest(`Unknown responsibility bucket: ${opts.responsibilityBucket}`);
    }
    if (opts.reversalStatus && !REVERSAL_STATUSES.includes(opts.reversalStatus)) {
      throw new BadRequest(`Unknown reversal status: ${opts.reversalStatus}`);
    }
    return billingRepository.listPayments(client, opts);
  },

  async collections(
    client: PoolClient,
    actor: Actor,
    opts: { from?: string; to?: string },
  ) {
    if (!can(actor.role, 'exportReports')) {
      throw new Forbidden('Your role does not include revenue reporting');
    }
    validateReportingDates(opts.from, opts.to);
    return billingRepository.collectionsReport(client, opts);
  },

  async aging(client: PoolClient, actor: Actor, opts: { asOf?: string } = {}) {
    if (!can(actor.role, 'exportReports') && !can(actor.role, 'createInvoice')) {
      throw new Forbidden('Your role does not include revenue reporting');
    }
    if (opts.asOf && !dateOnlyPattern.test(opts.asOf)) throw new BadRequest('Use YYYY-MM-DD for asOf');
    const timezone = await billingRepository.practiceTimezone(client);
    const currentBusinessDate = await billingRepository.currentBusinessDate(client, timezone);
    if (opts.asOf && opts.asOf !== currentBusinessDate) {
      throw new BadRequest(
        'Historical as-of aging is not yet supported because current claim/adjudication state is canonical.',
        { historicalAsOfSupported: false, currentBusinessDate, timezone },
      );
    }
    return billingRepository.agingReport(client, opts.asOf ?? currentBusinessDate, timezone);
  },

  async createCollectionCase(client: PoolClient, actor: Actor, input: {
    invoiceId: string; claimId?: string | null; debtorType: 'PATIENT' | 'INSURER' | 'UNRESOLVED_DENIAL';
    assignedTo?: string | null; nextActionAt?: string | null; status?: 'OPEN' | 'FOLLOW_UP' | 'DISPUTED' | 'RESOLVED';
  }) {
    assertCollectionsAccess(actor, 'manage collection cases');
    if (!COLLECTION_DEBTOR_TYPES.includes(input.debtorType)) throw new BadRequest('Unknown debtor type');
    if (input.status && !COLLECTION_STATUSES.includes(input.status)) throw new BadRequest('Unknown collection status');
    if (input.assignedTo) await requireUserInTenant(client, input.assignedTo);
    const collectionCase = await billingRepository.createCollectionCase(client, input);
    if (!collectionCase) throw new NotFound('Invoice not found');
    await client.query(
      `SELECT luminary.write_audit('Opened collection case', 'invoice', $1, $2, $3, 'notice')`,
      [input.invoiceId, input.debtorType, input.claimId ?? null],
    );
    return billingRepository.getCollectionCase(client, collectionCase.id);
  },

  async listCollectionCases(client: PoolClient, actor: Actor, opts: {
    debtorType?: 'PATIENT' | 'INSURER' | 'UNRESOLVED_DENIAL'; status?: string; assignedTo?: string;
    assigned?: 'me'; nextAction?: 'due' | 'overdue'; includeResolved?: boolean;
  }) {
    assertCollectionsAccess(actor, 'view collections');
    if (opts.debtorType && !COLLECTION_DEBTOR_TYPES.includes(opts.debtorType)) throw new BadRequest('Unknown debtor type');
    if (opts.status && !COLLECTION_STATUSES.includes(opts.status as never)) throw new BadRequest('Unknown collection status');
    return billingRepository.listCollectionCases(client, {
      debtorType: opts.debtorType,
      status: opts.status,
      assignedTo: opts.assignedTo,
      assignedToMe: opts.assigned === 'me' ? actor.userId : undefined,
      nextAction: opts.nextAction,
      includeResolved: opts.includeResolved,
    });
  },

  async getCollectionCase(client: PoolClient, actor: Actor, id: string) {
    assertCollectionsAccess(actor, 'view collections');
    const collectionCase = await billingRepository.getCollectionCase(client, id);
    if (!collectionCase) throw new NotFound('Collection case not found');
    return collectionCase;
  },

  async updateCollectionCase(client: PoolClient, actor: Actor, id: string, input: {
    status?: 'OPEN' | 'FOLLOW_UP' | 'DISPUTED' | 'RESOLVED'; assignedTo?: string | null; nextActionAt?: string | null; note?: string;
  }) {
    assertCollectionsAccess(actor, 'manage collection cases');
    if (input.status && !COLLECTION_STATUSES.includes(input.status)) throw new BadRequest('Unknown collection status');
    if (input.assignedTo) await requireUserInTenant(client, input.assignedTo);
    const before = await billingRepository.getCollectionCase(client, id);
    if (!before) throw new NotFound('Collection case not found');
    const updated = await billingRepository.updateCollectionCase(client, id, input);
    if (!updated) throw new NotFound('Collection case not found');

    const actionType = input.assignedTo !== undefined ? 'ASSIGNMENT' : 'STATUS_CHANGE';
    const note = input.note?.trim()
      || [
        input.status ? `Status set to ${input.status}` : null,
        input.assignedTo !== undefined ? `Assigned to ${input.assignedTo ?? 'nobody'}` : null,
        input.nextActionAt !== undefined ? `Next action set to ${input.nextActionAt ?? 'none'}` : null,
      ].filter(Boolean).join('; ');
    if (note) {
      await billingRepository.recordCollectionAction(client, {
        caseId: id,
        actorId: actor.userId,
        actionType,
        note,
        nextActionAt: input.nextActionAt ?? undefined,
      });
    }
    await client.query(
      `SELECT luminary.write_audit('Updated collection case', 'invoice', $1, $2, $3, 'notice')`,
      [before.invoice_id, before.debtor_type, note || null],
    );
    return billingRepository.getCollectionCase(client, id);
  },

  async recordCollectionAction(client: PoolClient, actor: Actor, id: string, input: {
    actionType: string; note: string; nextActionAt?: string | null; reference?: string | null;
  }) {
    assertCollectionsAccess(actor, 'record collection activity');
    if (!COLLECTION_ACTION_TYPES.includes(input.actionType as never)) throw new BadRequest('Unknown collection action type');
    if (input.note.trim().length < 3) throw new BadRequest('Collection note is too short');
    const collectionCase = await billingRepository.getCollectionCase(client, id);
    if (!collectionCase) throw new NotFound('Collection case not found');
    const action = await billingRepository.recordCollectionAction(client, {
      caseId: id,
      actorId: actor.userId,
      actionType: input.actionType,
      note: input.note,
      nextActionAt: input.nextActionAt ?? null,
      reference: input.reference ?? null,
    });
    await client.query(
      `SELECT luminary.write_audit('Recorded collection action', 'invoice', $1, $2, $3, 'notice')`,
      [collectionCase.invoice_id, collectionCase.debtor_type, input.note.trim()],
    );
    return action;
  },

  async listClaims(client: PoolClient, actor: Actor, opts: { patientId?: string; status?: string }) {
    if (!can(actor.role, 'submitClaims') && !can(actor.role, 'captureBiometric')) {
      throw new Forbidden('Your role does not include claims');
    }
    return billingRepository.listClaims(client, opts);
  },

  async getClaim(client: PoolClient, actor: Actor, id: string) {
    if (!can(actor.role, 'submitClaims') && !can(actor.role, 'captureBiometric')) {
      throw new Forbidden('Your role does not include claims');
    }
    const claim = await billingRepository.findClaim(client, id);
    if (!claim) throw new NotFound('Claim not found');
    return claim;
  },

  async captureBiometric(client: PoolClient, actor: Actor, id: string, biometricRef?: string) {
    if (!can(actor.role, 'captureBiometric')) throw new Forbidden('Your role cannot capture biometrics');
    const claim = await billingRepository.findClaim(client, id);
    if (!claim) throw new NotFound('Claim not found');
    if (!['draft', 'biometric_verified'].includes(claim.status)) {
      throw new Conflict('Biometrics can only be captured before submission');
    }

    const updated = await billingRepository.markClaimBiometric(client, id, biometricRef ?? null);
    await client.query(
      `SELECT luminary.write_audit('Captured claim biometric', 'claim', $1, $2, $3, 'notice')`,
      [id, claim.reference, biometricRef ?? 'verified at desk'],
    );
    return updated;
  },

  async submitClaim(client: PoolClient, actor: Actor, id: string, switchRef?: string) {
    if (!can(actor.role, 'submitClaims')) throw new Forbidden('Your role cannot submit claims');
    const claim = await billingRepository.findClaim(client, id);
    if (!claim) throw new NotFound('Claim not found');
    if (!['draft', 'biometric_verified'].includes(claim.status)) {
      throw new Conflict('Only draft or biometric-verified claims can be submitted');
    }

    const updated = await billingRepository.submitClaim(client, id, switchRef ?? null);
    await client.query(
      `SELECT luminary.write_audit('Submitted claim', 'claim', $1, $2, $3, 'notice')`,
      [id, claim.reference, switchRef ?? 'queued for NH263'],
    );
    return updated;
  },

  async adjudicateClaim(
    client: PoolClient,
    actor: Actor,
    id: string,
    input: { status: 'adjudicated' | 'remitted' | 'rejected'; response?: string; rejectionCode?: string },
  ) {
    if (!can(actor.role, 'submitClaims')) throw new Forbidden('Your role cannot update claim outcomes');
    const claim = await billingRepository.findClaim(client, id);
    if (!claim) throw new NotFound('Claim not found');
    if (!['submitted', 'adjudicated'].includes(claim.status) && input.status !== 'rejected') {
      throw new Conflict('Only submitted claims can be adjudicated or remitted');
    }
    if (input.status === 'rejected' && !input.rejectionCode) {
      throw new BadRequest('Rejected claims need a rejection code');
    }

    const updated = await billingRepository.adjudicateClaim(client, id, input);
    await client.query(
      `SELECT luminary.write_audit('Updated claim outcome', 'claim', $1, $2, $3, 'notice')`,
      [id, claim.reference, `${input.status}${input.rejectionCode ? `: ${input.rejectionCode}` : ''}`],
    );
    return updated;
  },
};

/** A receipt is what the patient leaves with; it must state exactly what was taken. */
function buildReceipt(invoice: Record<string, unknown>, payment: Record<string, unknown>, settled: Record<string, unknown>) {
  const tendered = Number(payment.amount);
  const rate = Number(payment.fx_rate ?? 1);
  return {
    invoiceReference: invoice.reference,
    patient: invoice.patient_name,
    tendered: { amount: tendered, currency: payment.currency },
    appliedToInvoice: {
      amount: Math.round(tendered * rate * 100) / 100,
      currency: invoice.currency,
      ...(rate !== 1 ? { rateUsed: rate } : {}),
    },
    method: payment.method,
    receivedAt: payment.received_at,
    balanceRemaining: Number(settled.patient_outstanding ?? 0),
    status: settled.status,
  };
}

function validateReportingDates(from?: string, to?: string): void {
  for (const [label, value] of [['from', from], ['to', to]] as const) {
    if (value && !dateOnlyPattern.test(value)) throw new BadRequest(`Use YYYY-MM-DD for ${label}`);
  }
  const start = from ?? to;
  const end = to ?? from;
  if (start && end && start > end) throw new BadRequest('from cannot be after to');
}

function assertCollectionsAccess(actor: Actor, action: string): void {
  if (!can(actor.role, 'exportReports') && !can(actor.role, 'createInvoice') && !can(actor.role, 'recordPayment')) {
    throw new Forbidden(`Your role cannot ${action}`);
  }
}

async function assertInsurerPaymentProvenance(
  client: PoolClient,
  invoiceId: string,
  claimId: string,
  remittanceId?: string,
  payerId?: string,
) {
  const { rows } = await client.query(
    `SELECT c.id, c.invoice_id, c.payer_id
       FROM luminary.claim c
      WHERE c.id = $1 AND c.invoice_id = $2 AND c.deleted_at IS NULL`,
    [claimId, invoiceId],
  );
  const claim = rows[0];
  if (!claim) throw new BadRequest('That claim does not belong to this invoice');
  if (payerId && claim.payer_id && payerId !== claim.payer_id) {
    throw new BadRequest('That payer does not match the claim');
  }
  if (!remittanceId) return;

  const { rows: remittanceRows } = await client.query(
    `SELECT id, claim_id, payer_id
       FROM luminary.claim_remittance
      WHERE id = $1 AND deleted_at IS NULL`,
    [remittanceId],
  );
  const remittance = remittanceRows[0];
  if (!remittance) throw new NotFound('Remittance not found');
  if (remittance.claim_id && remittance.claim_id !== claimId) {
    throw new BadRequest('That remittance does not belong to this claim');
  }
  if (payerId && remittance.payer_id && payerId !== remittance.payer_id) {
    throw new BadRequest('That payer does not match the remittance');
  }
}
