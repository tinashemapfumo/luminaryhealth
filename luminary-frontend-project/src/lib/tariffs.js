import { round2 } from './money.js';
import { coversDate, priceOn } from './catalogue.js';

/**
 * Tariff resolution.
 *
 * The seam a future NH263 integration replaces. Everything that needs to know
 * what a scheme will pay asks `getTariff` and gets the same shape back
 * regardless of whether the answer came from a locally imported schedule or,
 * one day, from the payer's own service. Nothing upstream of this file knows
 * which.
 *
 * Two rules matter more than the rest:
 *
 * **An estimate is not an approval.** Everything this returns is what the
 * practice *expects* the scheme to pay. It is never presented as adjudicated,
 * and the invoice keeps estimated and actual figures in separate fields, so
 * confirmation from the switch overwrites the actual and never the estimate.
 *
 * **Precedence is explicit, and the answer says which rule applied.** A biller
 * asked "why is this line 24 and that one 90%?" needs the reason on the line,
 * not a re-derivation. Every result carries `via`.
 */

export const TARIFF_SOURCES = {
  PLAN_TARIFF: 'plan tariff',
  PAYER_TARIFF: 'payer tariff',
  PLAN_PERCENT: 'plan percentage',
  UNCOVERED: 'no cover',
};

/**
 * Build a provider over local data.
 *
 * Deliberately a factory rather than a module of free functions: it is the
 * shape a remote provider would also take, so swapping the implementation is a
 * change at one call site rather than everywhere a tariff is needed.
 */
export function createTariffProvider({ tariffs = [], practiceId }) {
  const mine = tariffs.filter((t) => t.practiceId === practiceId && t.active !== false);

  /** The row in force for this service, payer and plan on a given date. */
  const rowFor = ({ serviceId, payerId, planId, on }) => {
    const candidates = mine.filter(
      (t) => t.serviceId === serviceId
        && t.payerId === payerId
        && coversDate(t, on)
    );
    // A plan-specific rate beats a payer-wide one; a payer-wide row is a
    // schedule that did not distinguish plans, which is common and useful.
    return (
      candidates.find((t) => t.planId === planId)
      ?? candidates.find((t) => !t.planId)
      ?? null
    );
  };

  return {
    /**
     * What the scheme is expected to pay for one unit of this service.
     *
     * `charge` is what the practice is billing — needed because the percentage
     * fallback is a share of the practice's own price, not of a tariff.
     */
    getTariff({ service, payer, plan, charge, on = new Date() }) {
      const gross = round2(charge);

      if (!plan || !payer || plan.reimbursePercent === 0) {
        return {
          via: TARIFF_SOURCES.UNCOVERED,
          code: service?.defaultTariffCode ?? null,
          funder: 0,
          patient: gross,
        };
      }

      const row = rowFor({ serviceId: service?.id, payerId: payer.id, planId: plan.id, on });
      if (row) {
        // A negotiated rate above the practice's own charge does not hand the
        // practice a profit on the difference; the scheme pays the lesser of
        // the two and the patient owes nothing. Billing a shortfall of less
        // than zero is how credit balances appear from nowhere.
        const funder = round2(Math.min(row.rate, gross));
        return {
          via: row.planId ? TARIFF_SOURCES.PLAN_TARIFF : TARIFF_SOURCES.PAYER_TARIFF,
          code: row.code ?? service?.defaultTariffCode ?? null,
          rate: row.rate,
          tariffId: row.id,
          source: row.source,
          funder,
          patient: round2(gross - funder),
        };
      }

      // No negotiated row: the plan's headline percentage still prices it.
      const funder = round2(gross * (plan.reimbursePercent / 100));
      return {
        via: TARIFF_SOURCES.PLAN_PERCENT,
        code: service?.defaultTariffCode ?? null,
        percent: plan.reimbursePercent,
        funder,
        patient: round2(gross - funder),
      };
    },

    /** Every rate ever recorded for a service, newest period first. */
    history(serviceId) {
      return mine
        .filter((t) => t.serviceId === serviceId)
        .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));
    },

    /** Rows in force right now, for the tariff management screens. */
    current(on = new Date()) {
      return mine.filter((t) => coversDate(t, on));
    },
  };
}

/**
 * Price one line of an invoice.
 *
 * The single place that turns "this service, for this patient, on this date"
 * into money. Quantity is applied to the practice charge before the tariff is
 * resolved, because a scheme pays per unit and rounding a per-unit share then
 * multiplying it drifts by a cent per line at volume.
 */
export function priceLine({ service, quantity = 1, payer, plan, provider, on = new Date() }) {
  const price = priceOn(service, on);
  if (!price) return null;

  const gross = round2(price.amount * quantity);
  const tariff = provider.getTariff({ service, payer, plan, charge: gross, on });

  return {
    serviceId: service.id,
    code: tariff.code,
    desc: service.billingDescription,
    quantity,
    unitPrice: price.amount,
    currency: price.currency,
    gross,
    // Estimated, and named so. These are what the practice expects, not what
    // the scheme has agreed — see the note at the top of this file.
    estimatedFunder: tariff.funder,
    estimatedPatient: tariff.patient,
    tariffVia: tariff.via,
    tariffId: tariff.tariffId ?? null,
    tariffRate: tariff.rate ?? null,
    tariffPercent: tariff.percent ?? null,
    // Filled in by adjudication, never by an estimate.
    actualFunderApproved: null,
    actualFunderPaid: null,
  };
}
