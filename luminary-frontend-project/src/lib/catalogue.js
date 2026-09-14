import { round2 } from './money.js';

/**
 * Reading the service catalogue.
 *
 * Everything here answers a question of the form "what applied on this date?".
 * That framing is the whole point: a price is not a number, it is a number
 * with a period attached, and an invoice raised in August must keep resolving
 * August's price however many times the practice re-prices afterwards.
 */

/** Midnight UTC, so a period boundary never turns on the time of day. */
const day = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

/**
 * Does a dated period cover this instant?
 *
 * `effectiveFrom` is inclusive and `effectiveTo` is inclusive, because that is
 * how a payer writes a tariff schedule ("1 Sep to 30 Sep") and translating it
 * into a half-open interval on the way in is where off-by-one-day billing
 * errors come from. An open `effectiveTo` means "still current".
 */
export function coversDate(period, on) {
  const at = day(on);
  const from = day(period.effectiveFrom);
  const to = day(period.effectiveTo);
  if (at === null) return false;
  if (from !== null && at < from) return false;
  if (to !== null && at > to) return false;
  return true;
}

/** Latest-starting period that covers the date; null when none does. */
export function periodOn(periods = [], on = new Date()) {
  const covering = periods.filter((period) => coversDate(period, on));
  if (covering.length === 0) return null;
  return covering.reduce((best, period) =>
    (day(period.effectiveFrom) ?? 0) >= (day(best.effectiveFrom) ?? 0) ? period : best);
}

/** What the practice charged for this service on a given date. */
export function priceOn(service, on = new Date()) {
  const period = periodOn(service?.price ?? [], on);
  return period ? { amount: round2(period.amount), currency: period.currency } : null;
}

/**
 * Re-price a service without destroying what it used to cost.
 *
 * The previous period is closed the day before the new one opens rather than
 * being edited, so every invoice ever raised can still resolve the price that
 * was in force when it was raised. A catalogue that overwrites its own prices
 * cannot answer "why was this invoice $40?" six months later, which is the
 * question an auditor actually asks.
 */
export function repriceService(service, { amount, currency, effectiveFrom }) {
  const from = day(effectiveFrom);
  const closeOn = new Date(from - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const history = (service.price ?? []).map((period) => {
    if (!coversDate(period, effectiveFrom)) return period;
    return { ...period, effectiveTo: closeOn };
  });

  return {
    ...service,
    price: [...history, { amount: round2(amount), currency, effectiveFrom, effectiveTo: null }],
    updatedAt: new Date().toISOString(),
  };
}

export const activeServices = (catalogue = []) => catalogue.filter((s) => s.active);

export const serviceById = (catalogue = [], id) => catalogue.find((s) => s.id === id) ?? null;

export const serviceByCode = (catalogue = [], code) =>
  activeServices(catalogue).find((s) => s.defaultTariffCode === code) ?? null;

/**
 * The service a booking of this kind is normally billed under.
 *
 * Replaces a hardcoded visit-type-to-tariff table that used to live in
 * application code. The mapping now belongs to the service, so a practice can
 * change what a "Follow up" bills as without a deployment.
 */
export function serviceForVisitType(catalogue = [], visitType) {
  return (
    activeServices(catalogue).find((s) => (s.visitTypes ?? []).includes(visitType))
    // Established-patient consultation is the safest fallback: it is the
    // cheapest consultation, so an unrecognised visit type under-bills rather
    // than over-bills, and under-billing is the error a biller notices.
    ?? activeServices(catalogue).find((s) => s.internalCode === 'CONS-EST')
    ?? activeServices(catalogue)[0]
    ?? null
  );
}

const normalise = (value) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Resolve free text from an external schedule to a service in this catalogue.
 *
 * Deliberately tiered and deliberately not fuzzy. Each tier is a rule a person
 * can check — "it matched the alias 'ECG REST'" — rather than a similarity
 * score. A percentage would invite a biller to accept a 92% match without
 * reading it, and a mis-mapped tariff silently mis-prices every invoice for
 * that service until someone notices.
 *
 * Anything that does not match exactly under one of these rules returns
 * `null`, which means the row goes to a human.
 */
export function matchService(catalogue = [], text) {
  const term = normalise(text);
  if (!term) return null;
  const services = activeServices(catalogue);

  const byName = services.find((s) => normalise(s.displayName) === term);
  if (byName) return { service: byName, via: 'name' };

  const byBilling = services.find((s) => normalise(s.billingDescription) === term);
  if (byBilling) return { service: byBilling, via: 'billing description' };

  const byClinical = services.find((s) => normalise(s.clinicalName) === term);
  if (byClinical) return { service: byClinical, via: 'clinical name' };

  const byAlias = services.find((s) => (s.aliases ?? []).some((a) => normalise(a) === term));
  if (byAlias) return { service: byAlias, via: 'alias' };

  return null;
}
