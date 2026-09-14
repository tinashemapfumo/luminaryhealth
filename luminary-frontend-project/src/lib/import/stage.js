import { round2, CURRENCIES } from '../money.js';
import { matchService, coversDate } from '../catalogue.js';

/**
 * Validation and staging.
 *
 * Nothing an administrator uploads is written anywhere near live pricing.
 * A file becomes a batch of staged rows, each classified and each carrying its
 * own line number, and only rows a person has approved are ever published.
 *
 * The reason is not tidiness. A tariff file decides what every patient on that
 * scheme is charged; a single mis-mapped column applied straight to production
 * would silently re-price a whole practice, and the first person to notice
 * would be a patient at the desk.
 */

export const ROW_STATUS = { VALID: 'VALID', WARNING: 'WARNING', ERROR: 'ERROR' };

export const BATCH_STATUS = {
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  READY: 'READY',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  ROLLED_BACK: 'ROLLED_BACK',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts the handful of date spellings a schedule actually arrives in. */
export function parseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (ISO_DATE.test(text)) return text;

  // dd/mm/yyyy and dd-mm-yyyy. Day-first because these are Zimbabwean and
  // South African schedules; guessing month-first would silently move a rate
  // by up to eleven months rather than failing loudly.
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return undefined;   // distinct from null: present but unreadable
}

/** Money as written in a spreadsheet — thousands separators, symbols, blanks. */
export function parseRate(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;

  const text = raw.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  // A cell with something in it that leaves no digits behind — "n/a", "TBC",
  // "on application" — is an unreadable rate, not an absent one. The two get
  // different messages because they need different fixes: one is a missing
  // value, the other is a column mapped to the wrong thing.
  if (text === '') return undefined;

  const number = Number(text);
  return Number.isFinite(number) ? round2(number) : undefined;
}

/**
 * Validate and resolve one tariff row.
 *
 * Every failure is recorded against the row rather than thrown, so one bad
 * line in three hundred does not cost an administrator the whole upload.
 */
export function stageTariffRow(row, {
  catalogue, payer, plans, existing, defaultCurrency, resolution,
}) {
  const issues = [];
  const fail = (message) => issues.push({ level: ROW_STATUS.ERROR, message });
  const warn = (message) => issues.push({ level: ROW_STATUS.WARNING, message });

  const code = String(row.tariffCode ?? '').trim();
  if (!code) fail('No tariff code');

  const rate = parseRate(row.rate);
  if (rate === null) fail('No rate');
  else if (rate === undefined) fail(`Rate "${row.rate}" is not a number`);
  else if (rate < 0) fail('Rate is negative');

  const currency = String(row.currency ?? '').trim().toUpperCase() || defaultCurrency;
  if (!CURRENCIES.includes(currency)) fail(`Unknown currency "${currency}"`);

  const from = parseDate(row.effectiveFrom);
  const to = parseDate(row.effectiveTo);
  if (from === undefined) fail(`Effective from "${row.effectiveFrom}" is not a date`);
  if (to === undefined) fail(`Effective to "${row.effectiveTo}" is not a date`);
  if (from && to && to < from) fail('Effective to is before effective from');

  const effectiveFrom = from ?? new Date().toISOString().slice(0, 10);
  const effectiveTo = to ?? null;
  if (!from) warn('No effective date in the file — will apply from today');

  // Plan is optional: a schedule that does not distinguish plans becomes a
  // payer-wide rate, which the resolver already understands.
  let planId = null;
  const planText = String(row.plan ?? '').trim();
  if (planText) {
    const plan = plans.find((p) => p.name.toLowerCase() === planText.toLowerCase()
      || p.id.toLowerCase() === planText.toLowerCase());
    if (!plan) fail(`Unknown plan "${planText}"`);
    else planId = plan.id;
  } else {
    warn('No plan named — applies to every plan on this payer');
  }

  /*
   * Service matching is deterministic; anything else is a person's decision.
   *
   * `resolution` is that decision, taken on the review screen: a service the
   * administrator picked for this row, or an instruction to skip it. It is
   * applied here rather than by editing the row, so the file on disk and the
   * decision about it stay separate and the decision is attributable.
   */
  const match = matchService(catalogue, row.serviceName);
  let serviceId = match?.service?.id ?? null;
  let resolvedBy = null;

  if (resolution?.ignore) {
    return {
      line: row.__line,
      status: ROW_STATUS.WARNING,
      ignored: true,
      issues: [{ level: ROW_STATUS.WARNING, message: 'Skipped by reviewer' }],
      matchedVia: null,
      resolved: { serviceName: row.serviceName ?? '', code, rate, currency, planId, payerId: payer?.id ?? null, effectiveFrom, effectiveTo, serviceId: null, description: '' },
    };
  }

  if (resolution?.serviceId) {
    serviceId = resolution.serviceId;
    resolvedBy = 'reviewer';
  } else if (!match) {
    fail(`No service matches "${row.serviceName ?? ''}" — choose one, create it, or skip the row`);
  }

  if (serviceId && rate !== null && rate !== undefined) {
    const clash = existing.find(
      (t) => t.serviceId === serviceId
        && t.payerId === payer?.id
        && (t.planId ?? null) === planId
        && coversDate(t, effectiveFrom)
    );
    if (clash) {
      if (round2(clash.rate) === rate && clash.code === code) {
        warn('Identical to the rate already in force — no change');
      } else {
        // Not an error. Superseding is the normal way a schedule updates; the
        // preview shows it as a change and publishing closes the old period.
        warn(`Supersedes ${clash.currency} ${clash.rate} in force from ${clash.effectiveFrom}`);
      }
    }
  }

  const level = issues.some((i) => i.level === ROW_STATUS.ERROR)
    ? ROW_STATUS.ERROR
    : issues.length ? ROW_STATUS.WARNING : ROW_STATUS.VALID;

  return {
    line: row.__line,
    status: level,
    issues,
    matchedVia: resolvedBy ?? match?.via ?? null,
    resolved: {
      code,
      serviceId,
      serviceName: row.serviceName ?? '',
      description: String(row.description ?? '').trim() || match?.service?.billingDescription || '',
      rate,
      currency,
      planId,
      payerId: payer?.id ?? null,
      effectiveFrom,
      effectiveTo,
    },
  };
}

/** Duplicate rows inside one file, which a schedule surprisingly often has. */
export function flagDuplicates(staged) {
  const seen = new Map();
  staged.forEach((row) => {
    const { serviceId, planId, effectiveFrom } = row.resolved;
    if (!serviceId) return;
    const key = `${serviceId}|${planId ?? 'any'}|${effectiveFrom}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, row.line);
      return;
    }
    row.status = ROW_STATUS.ERROR;
    row.issues.push({
      level: ROW_STATUS.ERROR,
      message: `Duplicate of line ${first} — same service, plan and start date`,
    });
  });
  return staged;
}

/** Headline counts for the preview screen. */
export function summariseBatch(staged = []) {
  return staged.reduce((acc, row) => {
    acc.total += 1;
    if (row.status === ROW_STATUS.ERROR) acc.errors += 1;
    else if (row.status === ROW_STATUS.WARNING) acc.warnings += 1;
    else acc.valid += 1;
    if (row.ignored) { acc.ignored += 1; return acc; }
    if (row.status !== ROW_STATUS.ERROR) {
      const supersedes = row.issues.some((i) => i.message.startsWith('Supersedes'));
      const identical = row.issues.some((i) => i.message.startsWith('Identical'));
      if (identical) acc.unchanged += 1;
      else if (supersedes) acc.changed += 1;
      else acc.created += 1;
    }
    return acc;
  }, { total: 0, valid: 0, warnings: 0, errors: 0, created: 0, changed: 0, unchanged: 0, ignored: 0 });
}

/**
 * Turn approved rows into tariff records.
 *
 * Rows in error are dropped and rows identical to what is already in force are
 * skipped, so republishing the same file is a no-op rather than a pile of
 * duplicate periods. Nothing is deleted here: superseding happens at publish
 * time by closing the previous period, never by removing it.
 */
export function buildTariffRecords(staged, { batchId, practiceId, source }) {
  return staged
    .filter((row) => !row.ignored)
    .filter((row) => row.status !== ROW_STATUS.ERROR)
    .filter((row) => !row.issues.some((i) => i.message.startsWith('Identical')))
    .map((row, index) => ({
      id: `TRF-${batchId}-${String(index + 1).padStart(4, '0')}`,
      practiceId,
      payerId: row.resolved.payerId,
      planId: row.resolved.planId,
      serviceId: row.resolved.serviceId,
      code: row.resolved.code,
      description: row.resolved.description,
      rate: row.resolved.rate,
      currency: row.resolved.currency,
      effectiveFrom: row.resolved.effectiveFrom,
      effectiveTo: row.resolved.effectiveTo,
      active: true,
      source,
      importBatchId: batchId,
    }));
}

/**
 * Publish a batch: supersede rather than overwrite.
 *
 * A rate that a new one replaces has its period closed the day before the new
 * one opens. It stays in the table, still resolvable, so an invoice raised
 * under it can always explain itself. This is also what makes rollback safe —
 * there is nothing to restore because nothing was destroyed.
 */
export function publishTariffs(current = [], incoming = []) {
  const closed = current.map((existing) => {
    const replacement = incoming.find(
      (row) => row.serviceId === existing.serviceId
        && row.payerId === existing.payerId
        && (row.planId ?? null) === (existing.planId ?? null)
        && coversDate(existing, row.effectiveFrom)
        && existing.active !== false
    );
    if (!replacement) return existing;

    const closeOn = new Date(new Date(`${replacement.effectiveFrom}T00:00:00Z`).getTime() - 86400000)
      .toISOString().slice(0, 10);
    return { ...existing, effectiveTo: closeOn, supersededBy: replacement.id };
  });

  return [...closed, ...incoming];
}

/**
 * Undo a batch without destroying history.
 *
 * The batch's own rows are deactivated and the periods they closed are
 * reopened. Financial records already raised against those rates are left
 * exactly as they are: an invoice is a statement of what was charged at the
 * time, and re-pricing history to match a corrected schedule would be
 * falsifying the books rather than fixing them.
 */
export function rollbackBatch(tariffs = [], batchId) {
  const introduced = new Set(
    tariffs.filter((t) => t.importBatchId === batchId).map((t) => t.id)
  );

  return tariffs.map((tariff) => {
    if (tariff.importBatchId === batchId) {
      return { ...tariff, active: false, rolledBackAt: new Date().toISOString() };
    }
    if (tariff.supersededBy && introduced.has(tariff.supersededBy)) {
      // Drops `supersededBy` along with reopening the period: the row that
      // superseded it is being deactivated, so the reference would dangle.
      const reopened = { ...tariff, effectiveTo: null };
      delete reopened.supersededBy;
      return reopened;
    }
    return tariff;
  });
}

/* ------------------------------------------------------------------ *
 * Service catalogue import.
 *
 * The practice's own price list rather than a payer's. Same pipeline, same
 * staging discipline: a file that would silently re-price every service in the
 * building is exactly as dangerous as one that mis-states what a scheme pays.
 * ------------------------------------------------------------------ */

const TRIGGERS = ['ON_ORDER', 'ON_COMPLETION', 'MANUAL'];

const slug = (value) =>
  String(value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

export function stageServiceRow(row, { catalogue, defaultCurrency }) {
  const issues = [];
  const fail = (message) => issues.push({ level: ROW_STATUS.ERROR, message });
  const warn = (message) => issues.push({ level: ROW_STATUS.WARNING, message });

  const name = String(row.serviceName ?? '').trim();
  if (!name) fail('No service name');

  const price = parseRate(row.practicePrice);
  if (price === null) warn('No practice price - service can be ordered, but billing will need a price or manual line');
  else if (price === undefined) fail(`Price "${row.practicePrice}" is not a number`);
  else if (price < 0) fail('Price is negative');

  const currency = String(row.currency ?? '').trim().toUpperCase() || defaultCurrency;
  if (!CURRENCIES.includes(currency)) fail(`Unknown currency "${currency}"`);

  const trigger = String(row.billingTrigger ?? '').trim().toUpperCase() || 'ON_COMPLETION';
  if (!TRIGGERS.includes(trigger)) {
    fail(`Unknown billing trigger "${trigger}" — use ${TRIGGERS.join(', ')}`);
  }

  // An existing service is updated rather than duplicated. Two services with
  // the same name is how a practice ends up billing the same thing two ways.
  const match = matchService(catalogue, name);
  if (match) warn(`Updates the existing "${match.service.displayName}"`);

  const level = issues.some((i) => i.level === ROW_STATUS.ERROR)
    ? ROW_STATUS.ERROR
    : issues.length ? ROW_STATUS.WARNING : ROW_STATUS.VALID;

  return {
    line: row.__line,
    status: level,
    issues,
    matchedVia: match?.via ?? null,
    resolved: {
      serviceId: match?.service?.id ?? null,
      serviceName: name,
      billingDescription: String(row.billingDescription ?? '').trim() || name,
      category: String(row.category ?? '').trim() || 'Consultation',
      department: String(row.department ?? '').trim() || 'General Practice',
      code: String(row.tariffCode ?? '').trim(),
      rate: price,
      currency,
      billingTrigger: trigger,
      orderable: !/^(false|no|0|inactive)$/i.test(String(row.orderable ?? 'true').trim()),
      active: !/^(false|no|0|inactive)$/i.test(String(row.active ?? 'true').trim()),
      effectiveFrom: parseDate(row.effectiveFrom) ?? new Date().toISOString().slice(0, 10),
      effectiveTo: null,
    },
  };
}

/**
 * Turn approved rows into catalogue services.
 *
 * An update carries the existing service's id so publishing re-prices it —
 * through the same effective-dated mechanism the settings screen uses — rather
 * than replacing it and orphaning every tariff mapped to it.
 */
export function buildServiceRecords(staged, { batchId, currency }) {
  return staged
    .filter((row) => !row.ignored && row.status !== ROW_STATUS.ERROR)
    .map((row, index) => ({
      id: row.resolved.serviceId ?? `SVC-${batchId}-${String(index + 1).padStart(3, '0')}`,
      isUpdate: Boolean(row.resolved.serviceId),
      internalCode: slug(row.resolved.serviceName),
      displayName: row.resolved.serviceName,
      clinicalName: row.resolved.serviceName,
      billingDescription: row.resolved.billingDescription,
      category: row.resolved.category,
      department: row.resolved.department,
      serviceType: 'service',
      defaultDuration: 15,
      defaultQuantity: 1,
      active: row.resolved.active,
      billable: true,
      orderable: row.resolved.orderable,
      billingTrigger: row.resolved.billingTrigger,
      defaultTariffCode: row.resolved.code,
      price: row.resolved.rate === null || row.resolved.rate === undefined ? [] : [{
        amount: row.resolved.rate,
        currency: row.resolved.currency || currency,
        effectiveFrom: row.resolved.effectiveFrom,
        effectiveTo: null,
      }],
      visitTypes: [],
      aliases: [],
      notes: '',
      importBatchId: batchId,
    }));
}
