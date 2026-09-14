/**
 * Verification for the orders, billing-trigger and import rules.
 *
 * The import path decides what every patient on a scheme is charged, so it is
 * asserted against the files practices actually send: differently named
 * columns, day-first dates, thousands separators, quoted descriptions with
 * commas in them, and rows that duplicate each other.
 *
 *     npm run verify:import
 */
import {
  parseDelimited, splitRow, detectDelimiter, fromMatrix, cellToText,
} from '../src/lib/import/parse.js';
import { guessMapping, applyMapping, missingRequired, TARIFF_FIELDS } from '../src/lib/import/profiles.js';
import {
  stageTariffRow, flagDuplicates, summariseBatch, buildTariffRecords,
  publishTariffs, rollbackBatch, parseDate, parseRate, ROW_STATUS,
} from '../src/lib/import/stage.js';
import { initialCatalogue } from '../src/data/catalogue.js';
import { initialTariffs, initialPayers } from '../src/data/tariffs.js';
import { createTariffProvider, priceLine } from '../src/lib/tariffs.js';
import { serviceById } from '../src/lib/catalogue.js';
import {
  billingDecision, billingKey, ordersAwaitingBilling, billedKeysFrom, nextOrderStatus,
} from '../src/lib/orders.js';
import { initialOrders, ORDER_STATUS } from '../src/data/orders.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`  x ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ✓ ${label}`);
};

const catalogue = initialCatalogue['PRC-001'];
const payer = initialPayers.find((p) => p.practiceId === 'PRC-001');
const service = (id) => serviceById(catalogue, id);
const svcFor = (order) => service(order.serviceId);

console.log('\nOrders — clinical intent is not a charge');
check('a completed order bills', billingDecision(initialOrders[1], svcFor(initialOrders[1])).bill, true);
check('an order in progress does not', billingDecision(initialOrders[2], svcFor(initialOrders[2])).bill, false);
check('and says what it is waiting for', billingDecision(initialOrders[2], svcFor(initialOrders[2])).reason, 'Waiting for completion');
check('a cancelled order never bills', billingDecision(initialOrders[3], svcFor(initialOrders[3])).bill, false);
check('and says why', billingDecision(initialOrders[3], svcFor(initialOrders[3])).reason, 'Cancelled — never charge for work not done');
check('a declined order never bills', billingDecision({ ...initialOrders[1], status: ORDER_STATUS.DECLINED }, service('SVC-005')).bill, false);
check('a non-billable service never bills', billingDecision(initialOrders[1], { ...service('SVC-005'), billable: false }).bill, false);
check('a manual service is not billed automatically', billingDecision(initialOrders[1], { ...service('SVC-005'), billingTrigger: 'MANUAL' }).bill, false);
check('an ON_ORDER service bills before completion', billingDecision(initialOrders[2], { ...service('SVC-004'), billingTrigger: 'ON_ORDER' }).bill, true);

console.log('\nIdempotency — a repeated completion event is not a second charge');
check('the key names the order and the trigger', billingKey(initialOrders[1], 'ON_COMPLETION'), 'ORD-2026-0044:ON_COMPLETION');
check('an order already billed is skipped', billingDecision(initialOrders[0], svcFor(initialOrders[0])).reason, 'Already billed');
const invoices = [{ services: [{ billingKey: 'ORD-2026-0044:ON_COMPLETION' }] }];
check('a key already on an invoice blocks a repeat', ordersAwaitingBilling(initialOrders, svcFor, billedKeysFrom(invoices)).length, 0);
check('and without it the order is owed a charge', ordersAwaitingBilling(initialOrders, svcFor, new Set()).map((e) => e.order.id), ['ORD-2026-0044']);
check('the status flow ends at completed', nextOrderStatus(ORDER_STATUS.COMPLETED), null);

console.log('\nParsing files as practices actually send them');
check('a comma inside a quoted field is data', splitRow('93000,"ECG, 12 lead",24', ','), ['93000', 'ECG, 12 lead', '24']);
check('a doubled quote is a literal quote', splitRow('a,"say ""hi""",c', ','), ['a', 'say "hi"', 'c']);
check('tab-separated exports are detected', detectDelimiter('Code\tDescription\tRate'), '\t');
check('a byte order mark is not a column name', parseDelimited('﻿Code,Rate\n93000,24').headers, ['Code', 'Rate']);
check('short rows are padded, not rejected', parseDelimited('a,b,c\n1,2').rows[0], { a: '1', b: '2', c: '', __line: 2 });
check('blank lines are ignored', parseDelimited('a\n\n1\n\n2').rows.length, 2);

console.log('\nWorkbooks arrive as typed cells and must end up looking like CSV');
check('a date cell is an ISO date, not a locale sentence', cellToText(new Date('2026-10-01T00:00:00Z')), '2026-10-01');
check('float noise never reaches the validators', cellToText(0.1 + 0.2), '0.3');
check('a numeric rate becomes plain text', cellToText(27), '27');
check('an empty cell is an empty string', cellToText(null), '');
check('a boolean becomes text', cellToText(false), 'false');
const grid = fromMatrix([
  ['Tariff No.', 'Procedure', 'Award'],
  ['93000', 'ECG', '27'],
  ['', '', ''],
]);
check('a blank spreadsheet row is dropped', grid.rows.length, 1);
check(
  'a workbook and a CSV of the same data parse identically',
  grid.rows[0],
  parseDelimited('Tariff No.,Procedure,Award\n93000,ECG,27').rows[0],
);

console.log('\nColumn mapping');
const fileA = parseDelimited('Tariff No.,Procedure,Award\n93000,ECG,24');
const fileB = parseDelimited('Code,Description,Rate,Plan\n93000,ECG,24,NH263 Plan A');
check('one payer spelling maps', guessMapping(fileA.headers), { tariffCode: 'Tariff No.', serviceName: 'Procedure', rate: 'Award' });
check('another payer spelling maps too', guessMapping(fileB.headers).tariffCode, 'Code');
check('a header is claimed once, by the more specific field', guessMapping(fileB.headers).serviceName, 'Description');
check('unmapped required fields are reported', missingRequired({ tariffCode: 'Code' }, TARIFF_FIELDS), ['Service name', 'Rate']);
check('mapping renames the columns', applyMapping(fileA.rows[0], guessMapping(fileA.headers)).serviceName, 'ECG');

console.log('\nReading the values inside');
check('day-first dates, as the schedules are written', parseDate('01/09/2026'), '2026-09-01');
check('ISO dates pass through', parseDate('2026-09-01'), '2026-09-01');
check('an empty date is absent, not invalid', parseDate(''), null);
check('an unreadable date is distinguishable from an absent one', parseDate('next Tuesday'), undefined);
check('thousands separators and symbols are stripped', parseRate('$1,234.50'), 1234.5);
check('an empty rate is absent', parseRate(''), null);
check('a non-numeric rate is invalid', parseRate('n/a'), undefined);

console.log('\nStaging — nothing reaches live pricing unreviewed');
const stage = (row) => stageTariffRow(row, {
  catalogue, payer, plans: payer.plans, existing: initialTariffs, defaultCurrency: 'USD',
});
const supersede = { tariffCode: '93000', serviceName: 'ECG', rate: '27', plan: 'NH263 Plan A', effectiveFrom: '01/10/2026', __line: 2 };
check('a row that supersedes is a warning, not an error', stage(supersede).status, ROW_STATUS.WARNING);
check('and the warning says what it replaces', stage(supersede).issues[0].message.startsWith('Supersedes'), true);
check('a missing code is an error', stage({ serviceName: 'ECG', rate: '27', plan: 'NH263 Plan A', __line: 2 }).status, ROW_STATUS.ERROR);
check('a negative rate is an error', stage({ tariffCode: '93000', serviceName: 'ECG', rate: '-5', plan: 'NH263 Plan A', __line: 2 }).status, ROW_STATUS.ERROR);
check('an unknown currency is an error', stage({ tariffCode: '93000', serviceName: 'ECG', rate: '27', currency: 'GBP', plan: 'NH263 Plan A', __line: 2 }).status, ROW_STATUS.ERROR);
check('an unknown plan is an error', stage({ tariffCode: '93000', serviceName: 'ECG', rate: '27', plan: 'Platinum', __line: 2 }).status, ROW_STATUS.ERROR);
check('end before start is an error', stage({ tariffCode: '93000', serviceName: 'ECG', rate: '27', plan: 'NH263 Plan A', effectiveFrom: '2026-10-01', effectiveTo: '2026-09-01', __line: 2 }).status, ROW_STATUS.ERROR);
check('an unmatched service is an error, never a guess', stage({ tariffCode: '99999', serviceName: 'Cardiac MRI', rate: '400', plan: 'NH263 Plan A', __line: 2 }).status, ROW_STATUS.ERROR);
check('an alias matches deterministically', stage({ tariffCode: '93000', serviceName: 'ECG REST', rate: '27', plan: 'NH263 Plan A', __line: 2 }).matchedVia, 'alias');
check('no plan named is a warning, not a failure', stage({ tariffCode: '93000', serviceName: 'ECG', rate: '27', __line: 2 }).status, ROW_STATUS.WARNING);
check('an identical rate is reported as no change', stage({ tariffCode: '93000', serviceName: 'ECG', rate: '24', plan: 'NH263 Plan A', effectiveFrom: '2026-06-01', __line: 2 }).issues.some((i) => i.message.startsWith('Identical')), true);

console.log('\nResolving a row a person had to decide');
const unmatched = { tariffCode: '99999', serviceName: 'Cardiac MRI', rate: '400', plan: 'NH263 Plan A', __line: 9 };
const resolveWith = (row, resolution) => stageTariffRow(row, {
  catalogue, payer, plans: payer.plans, existing: initialTariffs, defaultCurrency: 'USD', resolution,
});
check('unresolved, it is an error', resolveWith(unmatched).status, ROW_STATUS.ERROR);
check('and it says what a reviewer can do about it', resolveWith(unmatched).issues.some((i) => i.message.includes('choose one, create it, or skip')), true);
check('a reviewer choice resolves it', resolveWith(unmatched, { serviceId: 'SVC-004' }).status !== ROW_STATUS.ERROR, true);
check('and the row records that a person decided', resolveWith(unmatched, { serviceId: 'SVC-004' }).matchedVia, 'reviewer');
check('the chosen service is what gets published', resolveWith(unmatched, { serviceId: 'SVC-004' }).resolved.serviceId, 'SVC-004');
check('skipping is not an error', resolveWith(unmatched, { ignore: true }).status, ROW_STATUS.WARNING);
check('and a skipped row says so', resolveWith(unmatched, { ignore: true }).issues[0].message, 'Skipped by reviewer');
check(
  'a skipped row never reaches production data',
  buildTariffRecords([resolveWith(unmatched, { ignore: true })], { batchId: 'BX', practiceId: 'PRC-001', source: 't' }).length,
  0,
);
check(
  'and is counted apart from changes',
  summariseBatch([resolveWith(unmatched, { ignore: true })]).ignored,
  1,
);

console.log('\nDuplicates inside one file');
const dupes = flagDuplicates([
  stage({ tariffCode: '93000', serviceName: 'ECG', rate: '27', plan: 'NH263 Plan A', effectiveFrom: '2026-10-01', __line: 2 }),
  stage({ tariffCode: '93000', serviceName: 'Electrocardiogram', rate: '29', plan: 'NH263 Plan A', effectiveFrom: '2026-10-01', __line: 7 }),
]);
check('the second occurrence is an error', dupes[1].status, ROW_STATUS.ERROR);
check('and it names the line it duplicates', dupes[1].issues.at(-1).message, 'Duplicate of line 2 — same service, plan and start date');
check('the first is left alone', dupes[0].status, ROW_STATUS.WARNING);

console.log('\nThe preview an administrator approves');
const batch = flagDuplicates([
  stage({ tariffCode: '93000', serviceName: 'ECG', rate: '27', plan: 'NH263 Plan A', effectiveFrom: '2026-10-01', __line: 2 }),
  stage({ tariffCode: '80053', serviceName: 'Metabolic panel', rate: '30', plan: 'NH263 Plan A', effectiveFrom: '2026-10-01', __line: 3 }),
  stage({ tariffCode: '93000', serviceName: 'ECG', rate: '24', plan: 'NH263 Plan A', effectiveFrom: '2026-06-01', __line: 4 }),
  stage({ tariffCode: '99999', serviceName: 'Cardiac MRI', rate: '400', plan: 'NH263 Plan A', __line: 5 }),
]);
const summary = summariseBatch(batch);
check('every row is counted once', summary.total, 4);
check('errors are counted', summary.errors, 1);
check('an unchanged row is not presented as a change', summary.unchanged, 1);

console.log('\nPublishing supersedes, it does not overwrite');
const records = buildTariffRecords(batch, { batchId: 'B1', practiceId: 'PRC-001', source: 'NH263 October' });
check('rows in error are never published', records.some((r) => r.code === '99999'), false);
check('rows identical to the current rate are skipped', records.length, 2);
const published = publishTariffs(initialTariffs, records);
check('nothing is deleted', published.length, initialTariffs.length + records.length);
const oldEcg = published.find((t) => t.id === 'TRF-0001');
check('the previous period is closed the day before the new one', oldEcg.effectiveTo, '2026-09-30');
check('and records what replaced it', Boolean(oldEcg.supersededBy), true);

const after = createTariffProvider({ tariffs: published, practiceId: 'PRC-001' });
const priceAt = (provider, date) => priceLine({
  service: service('SVC-004'), payer, plan: payer.plans[0], provider, on: date,
}).estimatedFunder;
check('September encounters still resolve the old rate', priceAt(after, '2026-09-15'), 24);
check('October encounters resolve the new one', priceAt(after, '2026-10-15'), 27);

console.log('\nRollback restores without destroying');
const rolled = rollbackBatch(published, 'B1');
check('nothing is removed', rolled.length, published.length);
check('the batch rows are deactivated, not deleted', rolled.filter((t) => t.importBatchId === 'B1').every((t) => t.active === false), true);
check('the period it closed is reopened', rolled.find((t) => t.id === 'TRF-0001').effectiveTo, null);
check('and October resolves the old rate again', priceAt(createTariffProvider({ tariffs: rolled, practiceId: 'PRC-001' }), '2026-10-15'), 24);

if (failures > 0) {
  console.error(`\nx ${failures} order/import rule(s) broken\n`);
  process.exit(1);
}
console.log('\n✓ order, trigger and import rules hold\n');
