export interface ComparisonMetric {
  current: number | null;
  previous: number | null;
  change: number | null;
  changePercent: number | null;
}

const rounded = (value: number) => Math.round(value * 100) / 100;

export function buildComparisonMetric(current: number | null, previous: number | null): ComparisonMetric {
  if (current === null || previous === null) return { current, previous, change: null, changePercent: null };
  const change = rounded(current - previous);
  return {
    current,
    previous,
    change,
    changePercent: previous === 0 ? null : rounded((change / previous) * 100),
  };
}

export function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : rounded((numerator / denominator) * 100);
}
