/**
 * Money, and the two rules Zimbabwe imposes on it.
 *
 * **Dual currency.** A practice bills in one currency and collects in either,
 * often on the same day. A payment therefore carries its own currency and the
 * rate applied at the moment it was taken — never the rate today. Re-deriving
 * history from a current rate would silently rewrite what the patient actually
 * handed over, which is the difference between a ledger and a guess.
 *
 * **Cash is normal.** Most collections happen at the desk in cash or EcoCash,
 * so receipting is a first-class action rather than something bolted onto an
 * invoice after the fact.
 *
 * These functions mirror `billing.service.ts` on the server deliberately, for
 * the same reason the permission matrix is duplicated: this copy decides what
 * to *show* — a live preview of what will be applied, before anyone commits —
 * while the server decides what is *recorded*. The server re-checks every rule
 * here, and it is the one that counts.
 */

/** What a practice can be paid in. Billing currency is per invoice. */
export const CURRENCIES = ['USD', 'ZWL'];

/**
 * Used only when nothing else knows better.
 *
 * Every real path carries a currency: an invoice has one, a statement takes
 * one from the invoices it covers, and the workspace binds its formatter to
 * the practice's configured `primaryCurrency`. This exists so that malformed
 * or half-migrated data prints something rather than "undefined 40.00" — it is
 * a floor, not a default anyone should rely on. Anywhere it actually reaches
 * the screen, the data feeding it is wrong.
 */
export const FALLBACK_CURRENCY = 'USD';

export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'ecocash', label: 'EcoCash' },
  { value: 'card', label: 'Card' },
  { value: 'transfer', label: 'Bank transfer' },
  { value: 'medical_aid', label: 'Medical aid' },
];

export const methodLabel = (value) =>
  PAYMENT_METHODS.find((m) => m.value === value)?.label ?? value;

/** Two decimal places, without the float drift that turns 0.1 + 0.2 into a bug. */
export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** `format(1234.5, 'USD')` → `USD 1,234.50`. Code first, as a Zimbabwean receipt prints it. */
export const format = (amount, code = FALLBACK_CURRENCY) =>
  `${code} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What a tender is worth against the invoice.
 *
 * A payment in the invoice's own currency always applies at 1 — no rate is
 * asked for and none is stored, so there is no rate to be wrong about later.
 */
export const applyRate = (amount, rate) => round2(Number(amount) * Number(rate || 1));

/** Reversals are counter-entries, so this is a sum and not a special case. */
export const paidSoFar = (payments = []) =>
  round2(payments.reduce((total, p) => total + applyRate(p.amount, p.fxRate), 0));

/**
 * What is still owed: billed, less cash collected, less anything written off
 * or credited. An adjustment discharges a balance exactly as a payment does —
 * the difference is only that no money arrived, which is why the two are kept
 * as separate ledgers rather than netted into one number.
 */
export const outstandingOn = (invoice) =>
  round2(
    Number(invoice.patientResponsibility ?? 0)
    - paidSoFar(invoice.payments)
    - adjustedTotal(invoice.adjustments),
  );

/**
 * Validate a tender before it is taken.
 *
 * Returns `{ ok }` or `{ ok: false, message }` — the same refusals the server
 * makes, so the desk hears about a problem while the patient is still standing
 * there rather than after the fact.
 */
export function checkPayment(invoice, { amount, currency, fxRate }) {
  const value = Number(amount);
  if (!amount || Number.isNaN(value) || value <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero.' };
  }

  const invoiceCurrency = invoice.currency ?? FALLBACK_CURRENCY;
  const sameCurrency = currency === invoiceCurrency;
  const rate = Number(fxRate);

  if (!sameCurrency && (!fxRate || Number.isNaN(rate) || rate <= 0)) {
    return {
      ok: false,
      message: `Paying in ${currency} against a ${invoiceCurrency} invoice needs an exchange rate.`,
    };
  }

  const applied = applyRate(value, sameCurrency ? 1 : rate);
  const outstanding = outstandingOn(invoice);

  if (outstanding <= 0) return { ok: false, message: 'This invoice is already settled.' };

  // Overpayment is refused rather than quietly held as credit. A practice needs
  // to notice it at the desk, not discover it in a reconciliation next month.
  if (applied > outstanding) {
    return {
      ok: false,
      message: `That is more than the ${format(outstanding, invoiceCurrency)} outstanding. Take the exact amount, or raise a separate credit.`,
    };
  }

  return { ok: true, applied, outstanding, rate: sameCurrency ? 1 : rate };
}

/**
 * What the patient leaves with. It must state exactly what was taken.
 *
 * `number` is passed in rather than generated here. A receipt number has to be
 * sequential and survive a refresh, which is a fact about the practice's books
 * and not something a pure function should be inventing per call — two receipts
 * numbered the same is a worse defect than none being numbered at all.
 */
export function buildReceipt(invoice, payment, remaining, number) {
  const invoiceCurrency = invoice.currency ?? FALLBACK_CURRENCY;
  return {
    number,
    invoiceReference: invoice.id,
    patient: invoice.patient,
    tendered: { amount: payment.amount, currency: payment.currency },
    appliedToInvoice: {
      amount: applyRate(payment.amount, payment.fxRate),
      currency: invoiceCurrency,
      ...(payment.fxRate !== 1 ? { rateUsed: payment.fxRate } : {}),
    },
    method: payment.method,
    receivedAt: payment.receivedAt,
    receivedBy: payment.receivedBy,
    balanceRemaining: remaining,
    status: remaining <= 0 ? 'Paid' : 'Part paid',
  };
}

/* ------------------------------------------------------------------ *
 * Adjustments — write-offs and credit notes.
 *
 * `checkPayment` refuses an overpayment and tells the desk to "raise a
 * separate credit". This is that credit. Without it the advice is a dead end,
 * and a rejected claim leaves a balance nothing can ever discharge: the
 * patient will not pay it, the scheme has declined it, and cash is the only
 * instrument on the screen.
 *
 * An adjustment is a ledger entry, never an edit. It reduces what is owed and
 * records who decided and why, so the difference between "collected ZWL 900"
 * and "billed ZWL 1,240, wrote off ZWL 340" survives into the reporting. A
 * practice that cannot see its write-offs cannot see its bad debt.
 * ------------------------------------------------------------------ */

export const ADJUSTMENT_TYPES = [
  { value: 'write_off', label: 'Write-off', hint: 'Bad debt the practice accepts it will not collect.' },
  { value: 'credit_note', label: 'Credit note', hint: 'Billed in error, or a goodwill reduction.' },
];

export const adjustmentLabel = (value) =>
  ADJUSTMENT_TYPES.find((a) => a.value === value)?.label ?? value;

/** What has been written off or credited, in the invoice's own currency. */
export const adjustedTotal = (adjustments = []) =>
  round2(adjustments.reduce((total, a) => total + Number(a.amount || 0), 0));

/**
 * Validate an adjustment before it is written.
 *
 * Deliberately as strict as a payment. Money leaving the receivable without
 * cash arriving is the easier of the two to abuse, so it demands a reason, is
 * capped at what is actually owed, and lands in the audit log at alert.
 */
export function checkAdjustment(invoice, { amount, reason }) {
  const value = Number(amount);
  if (!amount || Number.isNaN(value) || value <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero.' };
  }
  const outstanding = outstandingOn(invoice);
  if (outstanding <= 0) return { ok: false, message: 'Nothing is outstanding on this invoice.' };
  if (value > outstanding) {
    return {
      ok: false,
      message: `That is more than the ${format(outstanding, invoice.currency ?? FALLBACK_CURRENCY)} outstanding.`,
    };
  }
  if ((reason || '').trim().length < 10) {
    return { ok: false, message: 'Give a fuller reason. This is a permanent financial record.' };
  }
  return { ok: true, amount: round2(value), outstanding, remaining: round2(outstanding - value) };
}

/* ------------------------------------------------------------------ *
 * Aging.
 *
 * The buckets and their boundaries mirror `agingReport` in
 * `billing.repository.ts` exactly — `current_date - due_on`, with the same
 * inclusive edges — so the screen and the server's report cannot disagree
 * about which bucket a debt sits in. A manager who chases the 61-90 column
 * here and gets a different list from the API stops trusting both.
 * ------------------------------------------------------------------ */

export const AGING_BUCKETS = [
  { key: 'current', label: 'Current', detail: 'Not yet due', tone: 'neutral' },
  { key: '1-30', label: '1–30 days', detail: 'Just past due', tone: 'accent' },
  { key: '31-60', label: '31–60 days', detail: 'Chase by phone', tone: 'warm' },
  { key: '61-90', label: '61–90 days', detail: 'Final demand', tone: 'warm' },
  { key: '90+', label: '90+ days', detail: 'Likely bad debt', tone: 'alert' },
];

const DAY = 24 * 60 * 60 * 1000;

/** Midnight UTC, so a bucket edge never turns on the time of day. */
const startOfDay = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

/**
 * Days past due. Negative means not yet due; null means the invoice carries no
 * due date to age against, which is reported rather than guessed at.
 */
export function daysOverdue(invoice, today = new Date()) {
  const due = startOfDay(invoice?.dueOn);
  const now = startOfDay(today);
  if (due === null || now === null) return null;
  return Math.round((now - due) / DAY);
}

export function agingBucket(days) {
  if (days === null || days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/**
 * Accounts receivable, bucketed the way a practice manager chases it. Settled
 * invoices are excluded — aging is a question about what is still owed.
 */
export function buildAging(invoices = [], today = new Date()) {
  const buckets = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b.key, { ...b, invoices: [], count: 0, outstanding: 0 }]),
  );

  invoices.forEach((invoice) => {
    const outstanding = outstandingOn(invoice);
    if (outstanding <= 0) return;
    const days = daysOverdue(invoice, today);
    const bucket = buckets[agingBucket(days)];
    bucket.invoices.push({ ...invoice, outstanding, days });
    bucket.count += 1;
    bucket.outstanding = round2(bucket.outstanding + outstanding);
  });

  const ordered = AGING_BUCKETS.map((b) => buckets[b.key]);
  const total = round2(ordered.reduce((sum, b) => sum + b.outstanding, 0));
  const overdue = round2(
    ordered.filter((b) => b.key !== 'current').reduce((sum, b) => sum + b.outstanding, 0),
  );

  return { buckets: ordered, total, overdue };
}

/* ------------------------------------------------------------------ *
 * Statements.
 *
 * The invoice is the unit everywhere else in billing, but it is not the unit
 * the patient thinks in. Someone at the desk asks "what do I owe you?" and
 * means every open invoice at once — so a statement aggregates them, and one
 * tender settles across them oldest first rather than making the receptionist
 * split a single note of cash by hand.
 * ------------------------------------------------------------------ */

/** Oldest due date first; undated invoices sort last. */
const byOldestDue = (a, b) => {
  const left = startOfDay(a.dueOn);
  const right = startOfDay(b.dueOn);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
};

export function statementFor(patient, invoices = [], today = new Date()) {
  const mine = invoices.filter((i) => i.patient === patient);
  const open = mine
    .filter((i) => outstandingOn(i) > 0)
    .sort(byOldestDue)
    .map((i) => ({ ...i, outstanding: outstandingOn(i), days: daysOverdue(i, today) }));

  const billed = round2(mine.reduce((sum, i) => sum + Number(i.patientResponsibility ?? 0), 0));
  const collected = round2(mine.reduce((sum, i) => sum + paidSoFar(i.payments), 0));
  const adjusted = round2(mine.reduce((sum, i) => sum + adjustedTotal(i.adjustments), 0));
  const outstanding = round2(open.reduce((sum, i) => sum + i.outstanding, 0));

  return {
    patient,
    invoices: mine,
    open,
    billed,
    collected,
    adjusted,
    outstanding,
    // The single number that decides whether this account goes to collections.
    oldestDays: open.length ? Math.max(...open.map((i) => i.days ?? 0)) : 0,
    currency: open[0]?.currency ?? mine[0]?.currency ?? FALLBACK_CURRENCY,
  };
}

/**
 * Split one tender across open invoices, oldest first.
 *
 * Oldest first is the convention every practice already follows on paper, and
 * it is the only order that keeps the aging report honest: settling the newest
 * invoice first would leave a 90-day debt sitting in the worst bucket while
 * the practice books a payment from that same patient.
 *
 * Returns the allocation and whatever could not be placed, so a surplus is
 * surfaced rather than silently absorbed.
 */
export function allocateAcrossInvoices(open = [], applied) {
  let left = round2(applied);
  const allocations = [];

  [...open].sort(byOldestDue).forEach((invoice) => {
    if (left <= 0) return;
    const due = outstandingOn(invoice);
    if (due <= 0) return;
    const take = round2(Math.min(due, left));
    left = round2(left - take);
    allocations.push({ invoiceId: invoice.id, amount: take, remaining: round2(due - take) });
  });

  return { allocations, unallocated: round2(Math.max(0, left)) };
}

/**
 * Validate a tender against a whole account rather than one invoice.
 *
 * The same refusals `checkPayment` makes, measured against the account total.
 * An overpayment is still refused: a credit balance nobody noticed at the desk
 * is a reconciliation problem next month.
 */
export function checkStatementPayment(statement, { amount, currency, fxRate }) {
  const value = Number(amount);
  if (!amount || Number.isNaN(value) || value <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero.' };
  }
  if (statement.outstanding <= 0) {
    return { ok: false, message: 'This account is settled in full.' };
  }

  const sameCurrency = currency === statement.currency;
  const rate = Number(fxRate);
  if (!sameCurrency && (!fxRate || Number.isNaN(rate) || rate <= 0)) {
    return {
      ok: false,
      message: `Paying in ${currency} against a ${statement.currency} account needs an exchange rate.`,
    };
  }

  const applied = applyRate(value, sameCurrency ? 1 : rate);
  if (applied > statement.outstanding) {
    return {
      ok: false,
      message: `That is more than the ${format(statement.outstanding, statement.currency)} owed on this account.`,
    };
  }

  const { allocations } = allocateAcrossInvoices(statement.open, applied);
  return { ok: true, applied, allocations, rate: sameCurrency ? 1 : rate };
}

/**
 * What was still owed immediately after a given payment.
 *
 * A reprint has to reproduce the slip that was handed over, not describe the
 * invoice as it stands today. If the patient paid half in August and the rest
 * in September, the August receipt said a balance remained — reprinting it
 * with "settled in full" would be issuing a different document under the same
 * receipt number.
 *
 * So this replays the ledger up to that payment and counts only the
 * adjustments already made by then, rather than subtracting everything that
 * has happened since.
 */
export function balanceAfter(invoice, paymentId) {
  const payments = invoice.payments ?? [];
  const index = payments.findIndex((payment) => payment.id === paymentId);
  if (index < 0) return outstandingOn(invoice);

  const at = new Date(payments[index].receivedAt).getTime();
  const applied = paidSoFar(payments.slice(0, index + 1));
  const written = adjustedTotal(
    (invoice.adjustments ?? []).filter((adjustment) => new Date(adjustment.at).getTime() <= at)
  );

  return round2(Math.max(0, Number(invoice.patientResponsibility ?? 0) - applied - written));
}

/* ------------------------------------------------------------------ *
 * Funder money: estimated against actual.
 *
 * The single most important distinction in this file, and the one the earlier
 * model did not make. An invoice used to carry `services[].insurance` — one
 * number that meant "what we think the scheme will pay" right up until the
 * scheme paid something different, at which point it silently meant nothing at
 * all. That is what let a rejected claim sit on the books as revenue that was
 * never going to arrive.
 *
 * So a line now carries both, and they are never merged:
 *
 *   estimatedFunder        what the tariff said, when the line was raised
 *   actualFunderApproved   what the scheme adjudicated, once it answered
 *   actualFunderPaid       what actually landed in the account
 *
 * The patient's liability follows the best information available — approved if
 * the scheme has answered, the estimate if it has not — and the estimate is
 * never overwritten, so "we expected 24 and got 16" stays answerable.
 * ------------------------------------------------------------------ */

/** Has the scheme actually answered on this line? */
export const isAdjudicated = (line) => line?.actualFunderApproved !== null
  && line?.actualFunderApproved !== undefined;

/**
 * What the funder is good for on this line right now.
 *
 * Approved once adjudicated, estimated until then. Never both, and never the
 * larger of the two: an approval of zero is an answer, not a missing value.
 */
export const funderShare = (line) =>
  (isAdjudicated(line) ? round2(line.actualFunderApproved) : round2(line.estimatedFunder ?? 0));

/** What the patient owes on this line, given what is known so far. */
export const patientShare = (line) =>
  round2(Math.max(0, Number(line.gross ?? 0) - funderShare(line)));

/**
 * Roll a set of lines up into the figures an invoice actually displays.
 *
 * Estimated and confirmed are reported side by side rather than collapsed,
 * because the gap between them is the practice's exposure — the money it has
 * earned, believes a scheme owes, and has not been told it will receive.
 */
export function summariseLines(lines = []) {
  const totals = lines.reduce((acc, line) => {
    acc.gross = round2(acc.gross + Number(line.gross ?? 0));
    acc.estimatedFunder = round2(acc.estimatedFunder + Number(line.estimatedFunder ?? 0));
    acc.funderApproved = round2(acc.funderApproved + (isAdjudicated(line) ? Number(line.actualFunderApproved) : 0));
    acc.funderPaid = round2(acc.funderPaid + Number(line.actualFunderPaid ?? 0));
    acc.patient = round2(acc.patient + patientShare(line));
    if (isAdjudicated(line)) acc.adjudicatedLines += 1;
    return acc;
  }, {
    gross: 0, estimatedFunder: 0, funderApproved: 0, funderPaid: 0, patient: 0, adjudicatedLines: 0,
  });

  return {
    ...totals,
    estimatedPatient: round2(totals.gross - totals.estimatedFunder),
    // Approved but not yet remitted. This is what a practice chases the scheme
    // for, and it is invisible unless approved and paid are tracked apart.
    outstandingFunder: round2(Math.max(0, totals.funderApproved - totals.funderPaid)),
    fullyAdjudicated: lines.length > 0 && totals.adjudicatedLines === lines.length,
  };
}

/**
 * Record what the scheme actually decided, without disturbing the estimate.
 *
 * `approved` is spread across the lines in proportion to what each was
 * expected to attract, because a remittance advice settles a claim rather than
 * a line and the practice still has to know which service was cut. Where
 * nothing was expected the money is spread evenly instead, so an approval
 * against an entirely self-pay claim is not silently discarded.
 */
export function applyAdjudication(lines = [], { approved, paid = null }) {
  const expected = round2(lines.reduce((sum, line) => sum + Number(line.estimatedFunder ?? 0), 0));
  const total = round2(approved);

  let remaining = total;
  return lines.map((line, index) => {
    const last = index === lines.length - 1;
    const share = expected > 0
      ? round2(total * (Number(line.estimatedFunder ?? 0) / expected))
      : round2(total / lines.length);
    // The last line absorbs the rounding, so the parts always sum to the whole
    // the scheme actually approved rather than to a cent either side of it.
    const approvedHere = last ? round2(Math.max(0, remaining)) : Math.min(share, remaining);
    remaining = round2(remaining - approvedHere);

    return {
      ...line,
      actualFunderApproved: approvedHere,
      actualFunderPaid: paid === null ? line.actualFunderPaid ?? null : approvedHere,
    };
  });
}
