/**
 * Verification for the catalogue, tariff and funder rules.
 *
 * These three layers decide what a patient is charged, so they are asserted
 * the same way the money rules are: every case that would change a figure on
 * an invoice, written down, run on every build.
 *
 * The cases that matter most are the dated ones. A price or a tariff is not a
 * number but a number with a period attached, and the failure mode — an
 * historical invoice silently re-pricing when someone edits today's rate — is
 * invisible until an auditor asks why the books moved.
 *
 *     npm run verify:catalogue
 */
import { initialCatalogue } from '../src/data/catalogue.js';
import { initialTariffs, initialPayers, planByName } from '../src/data/tariffs.js';
import {
  priceOn, repriceService, serviceForVisitType, serviceByCode, matchService, coversDate,
} from '../src/lib/catalogue.js';
import { createTariffProvider, priceLine, TARIFF_SOURCES } from '../src/lib/tariffs.js';
import {
  summariseLines, applyAdjudication, funderShare, patientShare, isAdjudicated,
} from '../src/lib/money.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const catalogue = initialCatalogue['PRC-001'];
const provider = createTariffProvider({
  tariffs: initialTariffs, payers: initialPayers, practiceId: 'PRC-001',
});
const svc = (id) => catalogue.find((s) => s.id === id);
const on = (planName, serviceId, date, quantity = 1) => {
  const found = planByName(initialPayers, 'PRC-001', planName);
  return priceLine({
    service: svc(serviceId), quantity, payer: found?.payer, plan: found?.plan, provider, on: date,
  });
};

console.log('\nEffective periods');
check('a period with no end is still current', coversDate({ effectiveFrom: '2026-01-01', effectiveTo: null }, '2030-06-01'), true);
check('the first day of a period is inside it', coversDate({ effectiveFrom: '2026-09-01', effectiveTo: null }, '2026-09-01'), true);
check('the last day of a period is inside it', coversDate({ effectiveFrom: '2026-01-01', effectiveTo: '2026-08-31' }, '2026-08-31'), true);
check('the day after is outside it', coversDate({ effectiveFrom: '2026-01-01', effectiveTo: '2026-08-31' }, '2026-09-01'), false);
check('the day before is outside it', coversDate({ effectiveFrom: '2026-09-01', effectiveTo: null }, '2026-08-31'), false);

console.log('\nPractice price is dated, not a number');
check('ECG resolved 20 in August', priceOn(svc('SVC-004'), '2026-08-15').amount, 20);
check('ECG resolves 35 from September', priceOn(svc('SVC-004'), '2026-09-15').amount, 35);
const repriced = repriceService(svc('SVC-001'), { amount: 50, currency: 'USD', effectiveFrom: '2026-10-01' });
check('re-pricing does not disturb the old price', priceOn(repriced, '2026-09-30').amount, 40);
check('re-pricing applies from its own start date', priceOn(repriced, '2026-10-01').amount, 50);
check('re-pricing closes the previous period rather than deleting it', repriced.price.length, 2);
check('exactly one period is ever in force', repriced.price.filter((p) => coversDate(p, '2026-10-01')).length, 1);

console.log('\nResolving a service');
check('a booking resolves the service it is billed under', serviceForVisitType(catalogue, 'New patient consult').id, 'SVC-002');
check('an unknown visit type falls back to the cheapest consultation', serviceForVisitType(catalogue, 'Nonsense').internalCode, 'CONS-EST');
check('a tariff code resolves its service', serviceByCode(catalogue, '93000').id, 'SVC-004');

console.log('\nMatching external descriptions — deterministic, never fuzzy');
check('exact name', matchService(catalogue, 'ECG').via, 'name');
check('clinical name', matchService(catalogue, 'Electrocardiogram').via, 'clinical name');
check('billing description', matchService(catalogue, '12 lead resting ECG').via, 'billing description');
check('a payer alias', matchService(catalogue, 'ECG REST').via, 'alias');
check('case and punctuation are ignored', matchService(catalogue, '  12-LEAD  ECG ').via, 'alias');
check('a near miss is refused rather than guessed', matchService(catalogue, 'ECG stress test'), null);
check('empty text matches nothing', matchService(catalogue, '   '), null);

console.log('\nTariff precedence');
check('a plan-specific rate wins', on('NH263 Plan A', 'SVC-004', '2026-09-15').tariffVia, TARIFF_SOURCES.PLAN_TARIFF);
check('a plan with no row falls back to its percentage', on('NH263 Plan C', 'SVC-004', '2026-09-15').tariffVia, TARIFF_SOURCES.PLAN_PERCENT);
check('self-pay attracts nothing', on('Self-pay', 'SVC-004', '2026-09-15').tariffVia, TARIFF_SOURCES.UNCOVERED);
check('an unknown plan attracts nothing', on('Not a plan', 'SVC-004', '2026-09-15').tariffVia, TARIFF_SOURCES.UNCOVERED);

console.log('\nThe worked example from the specification');
const ecg = on('NH263 Plan A', 'SVC-004', '2026-09-15');
check('practice charge', ecg.gross, 35);
check('estimated medical aid', ecg.estimatedFunder, 24);
check('estimated patient portion', ecg.estimatedPatient, 11);
check('the line records which rule priced it', ecg.tariffVia, TARIFF_SOURCES.PLAN_TARIFF);
check('the line records the tariff it used', ecg.tariffId, 'TRF-0001');

console.log('\nHistorical encounters keep their own tariff');
check('an August consult resolves the August rate', on('NH263 Plan A', 'SVC-002', '2026-08-15').estimatedFunder, 28);
check('a September consult resolves the September rate', on('NH263 Plan A', 'SVC-002', '2026-09-15').estimatedFunder, 30);
check('and the patient portion moves with it', on('NH263 Plan A', 'SVC-002', '2026-08-15').estimatedPatient, 17);

console.log('\nShortfalls');
check('a tariff below the charge leaves the difference with the patient', on('NH263 Plan A', 'SVC-001', '2026-09-15').estimatedPatient, 6);

// A schedule can list a rate above what this practice charges — it is a
// negotiated maximum, not an instruction to bill more. The practice is paid
// what it asked for and the patient owes nothing; a shortfall below zero would
// be a credit balance appearing from nowhere.
const generous = createTariffProvider({
  tariffs: [{
    id: 'TRF-TEST', practiceId: 'PRC-001', payerId: 'PAY-NH263', planId: 'PLN-A',
    serviceId: 'SVC-006', code: '99212', rate: 40, currency: 'USD',
    effectiveFrom: '2026-01-01', effectiveTo: null, active: true,
  }],
  payers: initialPayers, practiceId: 'PRC-001',
});
const over = priceLine({
  service: svc('SVC-006'),                                  // charged at 25
  ...planByName(initialPayers, 'PRC-001', 'NH263 Plan A'),
  provider: generous, on: '2026-09-15',
});
check('a tariff above the charge is capped at the charge', over.estimatedFunder, 25);
check('and never creates a negative shortfall', over.estimatedPatient, 0);
check('quantity multiplies the charge before the tariff applies', on('NH263 Plan C', 'SVC-004', '2026-09-15', 2).gross, 70);
check('a percentage plan splits the whole quantity', on('NH263 Plan C', 'SVC-004', '2026-09-15', 2).estimatedFunder, 56);

console.log('\nEstimated against actual');
const lines = [
  on('NH263 Plan A', 'SVC-004', '2026-09-15'),   // 35 gross, 24 expected
  on('NH263 Plan A', 'SVC-002', '2026-09-15'),   // 45 gross, 30 expected
];
const before = summariseLines(lines);
check('nothing is adjudicated yet', before.fullyAdjudicated, false);
check('gross is the sum of the lines', before.gross, 80);
check('the estimate is reported', before.estimatedFunder, 54);
check('the patient portion follows the estimate until the scheme answers', before.patient, 26);
check('nothing is approved yet', before.funderApproved, 0);

const settled = applyAdjudication(lines, { approved: 40, paid: true });
const after = summariseLines(settled);
check('an approval is split in proportion to what was expected', settled.map((l) => l.actualFunderApproved), [17.78, 22.22]);
check('the parts sum to exactly what was approved', after.funderApproved, 40);
check('the estimate survives the adjudication', after.estimatedFunder, 54);
check('the patient picks up the shortfall the scheme refused', after.patient, 40);
check('every line is now adjudicated', after.fullyAdjudicated, true);

console.log('\nApproved is not paid');
const approvedOnly = applyAdjudication(lines, { approved: 40 });
const chased = summariseLines(approvedOnly);
check('approved money not yet remitted is visible', chased.outstandingFunder, 40);
check('and disappears once it lands', summariseLines(applyAdjudication(lines, { approved: 40, paid: true })).outstandingFunder, 0);

console.log('\nA rejection is an answer, not a missing value');
const rejected = applyAdjudication(lines, { approved: 0, paid: true });
check('a zero approval counts as adjudicated', rejected.every(isAdjudicated), true);
check('the funder share is zero, not the estimate', funderShare(rejected[0]), 0);
check('the whole charge falls to the patient', patientShare(rejected[0]), 35);
check('and the invoice says so', summariseLines(rejected).patient, 80);
check('while still recording what was expected', summariseLines(rejected).estimatedFunder, 54);

if (failures > 0) {
  console.error(`\n✗ ${failures} catalogue/tariff rule(s) broken\n`);
  process.exit(1);
}
console.log('\n✓ catalogue, tariff and funder rules hold\n');
