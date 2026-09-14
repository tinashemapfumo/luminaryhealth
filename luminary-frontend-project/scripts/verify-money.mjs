/**
 * Verification for the money rules.
 *
 * `lib/money.js` mirrors `billing.service.ts` on the server: the client copy
 * previews what will be applied, the server copy decides what is recorded.
 * Every case below is one the server enforces, asserted here so the two cannot
 * quietly diverge — a preview that disagrees with the server is worse than no
 * preview, because it promises the desk something the API will then refuse.
 *
 *     npm run verify:money
 */
import {
  applyRate, paidSoFar, outstandingOn, checkPayment, buildReceipt, round2, format,
  checkAdjustment, daysOverdue, agingBucket, buildAging,
  statementFor, checkStatementPayment, allocateAcrossInvoices,
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
const refuses = (label, result, fragment) => {
  const ok = result.ok === false && result.message.includes(fragment);
  if (!ok) {
    failures += 1;
    console.error(`  ✗ ${label}\n      expected a refusal mentioning "${fragment}"\n      actual   ${JSON.stringify(result)}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const invoice = (over = {}) => ({
  id: 'INV-TEST-001',
  patient: 'Test Patient',
  currency: 'ZWL',
  patientResponsibility: 500,
  payments: [],
  ...over,
});

console.log('\nArithmetic');
check('rounds to two places without float drift', round2(0.1 + 0.2), 0.3);
check('a same-currency tender applies at 1', applyRate(250, 1), 250);
check('a USD tender applies at the stored rate', applyRate(10, 32.5), 325);
check('formats code-first with two decimals', format(1234.5, 'USD'), 'USD 1,234.50');

console.log('\nBalances');
check('nothing paid means nothing collected', paidSoFar([]), 0);
check(
  'a reversal is a counter-entry, not a deletion',
  paidSoFar([
    { amount: 200, fxRate: 1 },
    { amount: -200, fxRate: 1 },
  ]),
  0,
);
check(
  'mixed currencies sum in the invoice currency',
  paidSoFar([
    { amount: 100, fxRate: 1 },
    { amount: 10, fxRate: 32.5 },
  ]),
  425,
);
check('outstanding is responsibility less collected', outstandingOn(invoice({ payments: [{ amount: 200, fxRate: 1 }] })), 300);

console.log('\nRefusals the server also makes');
refuses('zero is refused', checkPayment(invoice(), { amount: 0, currency: 'ZWL' }), 'greater than zero');
refuses('negative is refused', checkPayment(invoice(), { amount: -50, currency: 'ZWL' }), 'greater than zero');
refuses(
  'a foreign tender with no rate is refused',
  checkPayment(invoice(), { amount: 10, currency: 'USD' }),
  'needs an exchange rate',
);
refuses(
  'overpayment is refused rather than held as credit',
  checkPayment(invoice(), { amount: 600, currency: 'ZWL' }),
  'more than the ZWL 500.00 outstanding',
);
refuses(
  'overpayment is caught after conversion, not before',
  // 20 USD at 32.5 is ZWL 650 — under the cap in the tendered number, over it
  // in the applied one. Checking the wrong one accepts an overpayment.
  checkPayment(invoice(), { amount: 20, currency: 'USD', fxRate: 32.5 }),
  'more than the ZWL 500.00 outstanding',
);
refuses(
  'a settled invoice takes nothing further',
  checkPayment(invoice({ payments: [{ amount: 500, fxRate: 1 }] }), { amount: 10, currency: 'ZWL' }),
  'already settled',
);

console.log('\nAcceptances');
check('an exact settlement is allowed', checkPayment(invoice(), { amount: 500, currency: 'ZWL' }).ok, true);
check('a part payment is allowed', checkPayment(invoice(), { amount: 120, currency: 'ZWL' }).ok, true);
check(
  'a foreign tender under the balance is allowed and converted',
  checkPayment(invoice(), { amount: 10, currency: 'USD', fxRate: 32.5 }).applied,
  325,
);
check(
  'a same-currency tender ignores any rate supplied',
  checkPayment(invoice(), { amount: 100, currency: 'ZWL', fxRate: 99 }).rate,
  1,
);

console.log('\nReceipt');
const settled = invoice({ payments: [{ amount: 10, fxRate: 32.5 }] });
const receipt = buildReceipt(
  settled,
  { amount: 10, currency: 'USD', fxRate: 32.5, method: 'cash', receivedAt: '2026-08-27T09:00:00Z', receivedBy: 'R. Chikafu' },
  175,
);
check('states what was tendered, not what it became', receipt.tendered, { amount: 10, currency: 'USD' });
check('states what was applied, and at what rate', receipt.appliedToInvoice, { amount: 325, currency: 'ZWL', rateUsed: 32.5 });
check('states the balance left', receipt.balanceRemaining, 175);
check('a settled receipt says so', buildReceipt(settled, { amount: 500, currency: 'ZWL', fxRate: 1 }, 0).status, 'Paid');
check(
  'a same-currency receipt carries no rate to be misread',
  Object.hasOwn(buildReceipt(invoice(), { amount: 100, currency: 'ZWL', fxRate: 1 }, 400).appliedToInvoice, 'rateUsed'),
  false,
);


console.log('\nAdjustments');
check(
  'an adjustment discharges a balance the way a payment does',
  outstandingOn(invoice({ adjustments: [{ amount: 200 }] })),
  300,
);
check(
  'payments and adjustments both count against the same balance',
  outstandingOn(invoice({ payments: [{ amount: 100, fxRate: 1 }], adjustments: [{ amount: 150 }] })),
  250,
);
refuses('a write-off of zero is refused', checkAdjustment(invoice(), { amount: 0, reason: 'membership lapsed entirely' }), 'greater than zero');
refuses(
  'a write-off larger than the balance is refused',
  checkAdjustment(invoice(), { amount: 600, reason: 'membership lapsed entirely' }),
  'more than the ZWL 500.00 outstanding',
);
refuses(
  'a write-off with no real reason is refused',
  checkAdjustment(invoice(), { amount: 100, reason: 'n/a' }),
  'fuller reason',
);
refuses(
  'nothing can be written off an already settled invoice',
  checkAdjustment(invoice({ payments: [{ amount: 500, fxRate: 1 }] }), { amount: 10, reason: 'membership lapsed entirely' }),
  'Nothing is outstanding',
);
check(
  'a part write-off leaves the rest collectable',
  checkAdjustment(invoice(), { amount: 200, reason: 'NH263 rejected R204, member left' }).remaining,
  300,
);
check(
  'a written-off invoice takes no further payment',
  checkPayment(invoice({ adjustments: [{ amount: 500 }] }), { amount: 10, currency: 'ZWL' }).ok,
  false,
);

console.log('\nAging — the same boundaries as agingReport in billing.repository.ts');
const on = (dueOn) => ({ dueOn });
const TODAY = new Date('2026-09-01T00:00:00Z');
check('days past due is a whole number of days', daysOverdue(on('2026-08-20'), TODAY), 12);
check('a future due date is negative, not zero', daysOverdue(on('2026-09-13'), TODAY), -12);
check('an invoice with no due date cannot be aged', daysOverdue(on(undefined), TODAY), null);
check('not yet due is current', agingBucket(-1), 'current');
check('due today is still current', agingBucket(0), 'current');
check('one day past due leaves current', agingBucket(1), '1-30');
check('day 30 is the last of the first bucket', agingBucket(30), '1-30');
check('day 31 crosses into 31-60', agingBucket(31), '31-60');
check('day 60 is the last of 31-60', agingBucket(60), '31-60');
check('day 61 crosses into 61-90', agingBucket(61), '61-90');
check('day 90 is the last of 61-90', agingBucket(90), '61-90');
check('day 91 is bad debt', agingBucket(91), '90+');
check('an undated invoice is reported as current rather than guessed at', agingBucket(null), 'current');

const cohort = [
  invoice({ id: 'A', dueOn: '2026-09-13', patientResponsibility: 440 }),
  invoice({ id: 'B', dueOn: '2026-08-20', patientResponsibility: 1240 }),
  invoice({ id: 'C', dueOn: '2026-07-28', patientResponsibility: 480 }),
  invoice({ id: 'D', dueOn: '2026-05-02', patientResponsibility: 980 }),
  invoice({ id: 'E', dueOn: '2026-05-02', patientResponsibility: 100, payments: [{ amount: 100, fxRate: 1 }] }),
];
const aged = buildAging(cohort, TODAY);
check('a settled invoice is not aged at all', aged.buckets.flatMap((b) => b.invoices).some((i) => i.id === 'E'), false);
check('each open invoice lands in exactly one bucket', aged.buckets.reduce((n, b) => n + b.count, 0), 4);
check('the buckets sum to the whole receivable', aged.total, 3140);
check('current is excluded from the overdue figure', aged.overdue, 2700);
check(
  'the bucket order is the order a manager chases in',
  aged.buckets.map((b) => b.key),
  ['current', '1-30', '31-60', '61-90', '90+'],
);

console.log('\nStatements');
const account = [
  invoice({ id: 'INV-1', patient: 'Erin Shah', dueOn: '2026-08-20', patientResponsibility: 1240 }),
  invoice({ id: 'INV-2', patient: 'Erin Shah', dueOn: '2026-07-28', patientResponsibility: 480 }),
  invoice({ id: 'INV-3', patient: 'Someone Else', dueOn: '2026-07-01', patientResponsibility: 900 }),
];
const statement = statementFor('Erin Shah', account, TODAY);
check('a statement covers one patient and no one else', statement.open.length, 2);
check('it totals what that patient owes', statement.outstanding, 1720);
check('the oldest open invoice sets the age of the account', statement.oldestDays, 35);
check('open invoices are listed oldest first', statement.open.map((i) => i.id), ['INV-2', 'INV-1']);

check(
  'a tender clears the oldest invoice before it touches the newest',
  checkStatementPayment(statement, { amount: 600, currency: 'ZWL' }).allocations,
  [
    { invoiceId: 'INV-2', amount: 480, remaining: 0 },
    { invoiceId: 'INV-1', amount: 120, remaining: 1120 },
  ],
);
check(
  'settling the account in full leaves nothing on any invoice',
  checkStatementPayment(statement, { amount: 1720, currency: 'ZWL' }).allocations.every((a) => a.remaining === 0),
  true,
);
refuses(
  'paying more than the account owes is refused, not held as credit',
  checkStatementPayment(statement, { amount: 2000, currency: 'ZWL' }),
  'more than the ZWL 1,720.00 owed',
);
refuses(
  'a foreign tender against an account still needs a rate',
  checkStatementPayment(statement, { amount: 50, currency: 'USD' }),
  'needs an exchange rate',
);
check(
  'a foreign tender is allocated by what it converts to, not what was handed over',
  checkStatementPayment(statement, { amount: 20, currency: 'USD', fxRate: 32.5 }).allocations,
  [{ invoiceId: 'INV-2', amount: 480, remaining: 0 }, { invoiceId: 'INV-1', amount: 170, remaining: 1070 }],
);
refuses(
  'a settled account takes nothing further',
  checkStatementPayment(statementFor('Nobody', account, TODAY), { amount: 10, currency: 'ZWL' }),
  'settled in full',
);
check(
  'a surplus that cannot be allocated is reported rather than absorbed',
  allocateAcrossInvoices(statement.open, 2000).unallocated,
  280,
);

if (failures > 0) {
  console.error(`\n✗ ${failures} money rule(s) broken\n`);
  process.exit(1);
}
console.log('\n✓ money rules hold\n');
