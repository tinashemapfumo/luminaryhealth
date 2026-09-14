/**
 * Payers, plans, and what they pay.
 *
 * Kept apart from the service catalogue on purpose. What the practice charges
 * is the practice's decision; what a scheme reimburses is the scheme's, it
 * arrives as a spreadsheet several times a year, and the two must be able to
 * change independently. Folding a payer rate into the service would mean a
 * tariff update rewriting the practice's own price list.
 *
 * Every rate is effective-dated and nothing is ever overwritten. When NH263
 * raises the ECG rate from 24 to 27 in October, the 24 stays — an encounter in
 * September has to keep resolving September's rate for as long as anyone can
 * still query it, which is for ever.
 */

export const initialPayers = [
  {
    id: 'PAY-NH263',
    name: 'NH263',
    practiceId: 'PRC-001',
    plans: [
      { id: 'PLN-A', name: 'NH263 Plan A', reimbursePercent: 90, requiresPreAuth: false, active: true },
      { id: 'PLN-B', name: 'NH263 Plan B', reimbursePercent: 80, requiresPreAuth: true, active: true },
      { id: 'PLN-C', name: 'NH263 Plan C', reimbursePercent: 80, requiresPreAuth: false, active: true },
    ],
  },
  {
    id: 'PAY-NH263-BYO',
    name: 'NH263',
    practiceId: 'PRC-002',
    plans: [
      { id: 'PLN-A', name: 'NH263 Plan A', reimbursePercent: 90, requiresPreAuth: false, active: true },
    ],
  },
];

/**
 * Negotiated per-service rates.
 *
 * Sparse by design, and that is the important part. A practice will never have
 * a tariff row for everything it does — schedules cover the common procedures
 * and say nothing about the rest. So this is an override on top of the plan's
 * percentage, not a replacement for it: where a row exists the scheme pays
 * that amount, and where none does the plan percentage still prices the line.
 *
 * A system that could only bill what had been imported would be unusable until
 * the import was perfect, which is never.
 */
export const initialTariffs = [
  // ECG — the worked example. Two plans, two rates, one code.
  {
    id: 'TRF-0001', practiceId: 'PRC-001', payerId: 'PAY-NH263', planId: 'PLN-A',
    serviceId: 'SVC-004', code: '93000', description: '12 lead resting ECG',
    rate: 24, currency: 'USD',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    active: true, source: 'NH263 January schedule', importBatchId: null,
  },
  {
    id: 'TRF-0002', practiceId: 'PRC-001', payerId: 'PAY-NH263', planId: 'PLN-B',
    serviceId: 'SVC-004', code: '93000', description: '12 lead resting ECG',
    rate: 16, currency: 'USD',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    active: true, source: 'NH263 January schedule', importBatchId: null,
  },
  // A rate that has already been superseded once, so the historical path is
  // exercised by the seed rather than only by a test.
  {
    id: 'TRF-0003', practiceId: 'PRC-001', payerId: 'PAY-NH263', planId: 'PLN-A',
    serviceId: 'SVC-002', code: '99203', description: 'New patient consultation',
    rate: 28, currency: 'USD',
    effectiveFrom: '2026-01-01', effectiveTo: '2026-08-31',
    active: true, source: 'NH263 January schedule', importBatchId: null,
  },
  {
    id: 'TRF-0004', practiceId: 'PRC-001', payerId: 'PAY-NH263', planId: 'PLN-A',
    serviceId: 'SVC-002', code: '99203', description: 'New patient consultation',
    rate: 30, currency: 'USD',
    effectiveFrom: '2026-09-01', effectiveTo: null,
    active: true, source: 'NH263 September schedule', importBatchId: null,
  },
  {
    id: 'TRF-0005', practiceId: 'PRC-001', payerId: 'PAY-NH263', planId: 'PLN-A',
    serviceId: 'SVC-001', code: '99213', description: 'Office visit, established patient',
    rate: 34, currency: 'USD',
    effectiveFrom: '2026-01-01', effectiveTo: null,
    active: true, source: 'NH263 January schedule', importBatchId: null,
  },
];

/** The scheme name recorded on a patient record, resolved to a plan. */
export function planByName(payers, practiceId, name) {
  for (const payer of payers) {
    if (payer.practiceId !== practiceId) continue;
    const plan = payer.plans.find((p) => p.name === name);
    if (plan) return { payer, plan };
  }
  return null;
}
