export const REPORTING_PERIODS = [
  'today', 'yesterday', 'this_week', 'last_week', 'this_month',
  'last_month', 'last_30_days', 'this_quarter', 'last_quarter',
] as const;

export const COMPARISON_MODES = [
  'none', 'previous_period', 'previous_week', 'previous_month',
  'previous_quarter', 'year_over_year',
] as const;

export type ReportingPeriod = (typeof REPORTING_PERIODS)[number];
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export interface DateRange { from: string; to: string; toExclusive: string }
export interface ResolvedReportingPeriod extends DateRange {
  requested: ReportingPeriod;
  compare: ComparisonMode;
  comparisonFrom: string | null;
  comparisonTo: string | null;
  comparisonToExclusive: string | null;
}

const parseDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const formatDate = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (value: Date, days: number) => {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};
const startOfWeek = (value: Date) => addDays(value, -((value.getUTCDay() + 6) % 7));
const startOfMonth = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
const startOfQuarter = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), Math.floor(value.getUTCMonth() / 3) * 3, 1));
const endInclusive = (exclusive: Date) => formatDate(addDays(exclusive, -1));

function range(period: ReportingPeriod, today: Date): { start: Date; end: Date } {
  switch (period) {
    case 'today': return { start: today, end: addDays(today, 1) };
    case 'yesterday': return { start: addDays(today, -1), end: today };
    case 'this_week': return { start: startOfWeek(today), end: addDays(today, 1) };
    case 'last_week': { const end = startOfWeek(today); return { start: addDays(end, -7), end }; }
    case 'this_month': return { start: startOfMonth(today), end: addDays(today, 1) };
    case 'last_month': { const end = startOfMonth(today); return { start: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1)), end }; }
    case 'last_30_days': return { start: addDays(today, -29), end: addDays(today, 1) };
    case 'this_quarter': return { start: startOfQuarter(today), end: addDays(today, 1) };
    case 'last_quarter': { const end = startOfQuarter(today); return { start: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 3, 1)), end }; }
  }
}

const shiftYear = (value: Date) => {
  const targetYear = value.getUTCFullYear() - 1;
  const month = value.getUTCMonth();
  const day = value.getUTCDate();
  const shifted = new Date(Date.UTC(targetYear, month, day));
  return shifted.getUTCMonth() === month ? shifted : new Date(Date.UTC(targetYear, month + 1, 0));
};

function comparison(mode: ComparisonMode, current: { start: Date; end: Date }, today: Date) {
  if (mode === 'none') return null;
  if (mode === 'previous_period') {
    const days = Math.round((current.end.getTime() - current.start.getTime()) / 86_400_000);
    return { start: addDays(current.start, -days), end: current.start };
  }
  if (mode === 'year_over_year') {
    return { start: shiftYear(current.start), end: shiftYear(current.end) };
  }
  if (mode === 'previous_week') {
    const end = startOfWeek(today);
    return { start: addDays(end, -7), end };
  }
  if (mode === 'previous_month') {
    const end = startOfMonth(today);
    return { start: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1)), end };
  }
  const end = startOfQuarter(today);
  return { start: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 3, 1)), end };
}

export function resolveReportingPeriod(requested: ReportingPeriod, compare: ComparisonMode, localToday: string): ResolvedReportingPeriod {
  const current = range(requested, parseDate(localToday));
  const prior = comparison(compare, current, parseDate(localToday));
  return {
    requested,
    from: formatDate(current.start),
    to: endInclusive(current.end),
    toExclusive: formatDate(current.end),
    compare,
    comparisonFrom: prior ? formatDate(prior.start) : null,
    comparisonTo: prior ? endInclusive(prior.end) : null,
    comparisonToExclusive: prior ? formatDate(prior.end) : null,
  };
}
