import assert from 'node:assert/strict';
import test from 'node:test';
import { buildComparisonMetric, rate } from './metrics.js';
import { resolveReportingPeriod } from './reporting-period.js';
import { reportingRequestSchema } from './reporting-request.js';

void test('last_30_days includes today and resolves thirty calendar days', () => {
  const period = resolveReportingPeriod('last_30_days', 'none', '2026-09-21');
  assert.deepEqual(period, {
    requested: 'last_30_days', from: '2026-08-23', to: '2026-09-21', toExclusive: '2026-09-22',
    compare: 'none', comparisonFrom: null, comparisonTo: null, comparisonToExclusive: null,
  });
});

void test('previous_period is the immediately preceding equivalent duration', () => {
  const period = resolveReportingPeriod('last_30_days', 'previous_period', '2026-09-21');
  assert.equal(period.comparisonFrom, '2026-07-24');
  assert.equal(period.comparisonTo, '2026-08-22');
});

void test('comparison fixtures and zero denominators are deliberate', () => {
  assert.deepEqual(buildComparisonMetric(428, 391), {
    current: 428, previous: 391, change: 37, changePercent: 9.46,
  });
  assert.deepEqual(buildComparisonMetric(22180, 19410), {
    current: 22180, previous: 19410, change: 2770, changePercent: 14.27,
  });
  assert.equal(buildComparisonMetric(10, 0).changePercent, null);
  assert.equal(rate(0, 0), null);
});

void test('all normalized reporting periods resolve in the practice calendar', () => {
  const expected = {
    today: ['2026-09-21', '2026-09-21'],
    yesterday: ['2026-09-20', '2026-09-20'],
    this_week: ['2026-09-21', '2026-09-21'],
    last_week: ['2026-09-14', '2026-09-20'],
    this_month: ['2026-09-01', '2026-09-21'],
    last_month: ['2026-08-01', '2026-08-31'],
    last_30_days: ['2026-08-23', '2026-09-21'],
    this_quarter: ['2026-07-01', '2026-09-21'],
    last_quarter: ['2026-04-01', '2026-06-30'],
  } as const;
  for (const [period, dates] of Object.entries(expected)) {
    const resolved = resolveReportingPeriod(period as keyof typeof expected, 'none', '2026-09-21');
    assert.deepEqual([resolved.from, resolved.to], dates, period);
  }
});

void test('explicit comparison modes resolve stable calendar ranges', () => {
  const expected = {
    previous_week: ['2026-09-14', '2026-09-20'],
    previous_month: ['2026-08-01', '2026-08-31'],
    previous_quarter: ['2026-04-01', '2026-06-30'],
    year_over_year: ['2025-08-23', '2025-09-21'],
  } as const;
  for (const [mode, dates] of Object.entries(expected)) {
    const resolved = resolveReportingPeriod('last_30_days', mode as keyof typeof expected, '2026-09-21');
    assert.deepEqual([resolved.comparisonFrom, resolved.comparisonTo], dates, mode);
  }
});

void test('request validation rejects unsupported values and tenant selectors', () => {
  assert.equal(reportingRequestSchema.safeParse({ period: 'next_century', compare: 'none' }).success, false);
  assert.equal(reportingRequestSchema.safeParse({ period: 'today', compare: 'best_month' }).success, false);
  assert.equal(reportingRequestSchema.safeParse({ period: 'today', compare: 'none', practiceId: crypto.randomUUID() }).success, false);
  assert.deepEqual(reportingRequestSchema.parse({ period: 'today', compare: 'none' }), { period: 'today', compare: 'none' });
});

void test('comparison metrics cover negative, unchanged, absent, and zero baselines', () => {
  assert.deepEqual(buildComparisonMetric(80, 100), { current: 80, previous: 100, change: -20, changePercent: -20 });
  assert.deepEqual(buildComparisonMetric(100, 100), { current: 100, previous: 100, change: 0, changePercent: 0 });
  assert.deepEqual(buildComparisonMetric(100, null), { current: 100, previous: null, change: null, changePercent: null });
  const zero = buildComparisonMetric(100, 0);
  assert.equal(zero.changePercent, null);
  assert.equal(JSON.stringify(zero).includes('Infinity'), false);
  assert.equal(JSON.stringify(zero).includes('NaN'), false);
});
