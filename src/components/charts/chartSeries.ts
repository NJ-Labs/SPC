import type { DataPoint, RuleViolation } from '../../types/DataTypes';

/** Chart.js draws `null` as a gap; NaN from the shared series maps to it so no point is dropped or shifted. */
export const finiteOrNull = (value: number | null | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const toPlotValues = (series: readonly number[]): Array<number | null> => series.map(finiteOrNull);

export const constantLine = (length: number, value: number): Array<number | null> => (
  Array.from({ length }, () => finiteOrNull(value))
);

/** Pointwise limits when the shared series covers every plotted point, otherwise the single value. */
export const pointwiseLine = (
  series: readonly number[] | undefined,
  fallback: number,
  length: number,
): Array<number | null> => (
  series && series.length === length ? toPlotValues(series) : constantLine(length, fallback)
);

export const zoneLine = (
  centerLine: number,
  sigmaValues: ReadonlyArray<number | null>,
  multiple: number,
  side: 1 | -1,
  lowerFloor?: number,
): Array<number | null> => sigmaValues.map((sigma) => {
  if (sigma === null || !Number.isFinite(centerLine)) return null;
  const level = centerLine + side * multiple * sigma;
  return side === -1 && lowerFloor !== undefined ? Math.max(lowerFloor, level) : level;
});

/** One-based x labels, or the chosen X column, aligned to the plotted series. */
export const buildAxisLabels = (
  rows: readonly DataPoint[],
  xColumn: string | null,
  length: number,
): string[] => Array.from({ length }, (_, index) => (
  xColumn && rows.length === length ? String(rows[index]?.[xColumn] ?? '') : `${index + 1}`
));

export const groupViolationsByIndex = (violations: readonly RuleViolation[]): Map<number, RuleViolation[]> => {
  const byIndex = new Map<number, RuleViolation[]>();
  for (const violation of violations) {
    const existing = byIndex.get(violation.index);
    if (existing) existing.push(violation);
    else byIndex.set(violation.index, [violation]);
  }
  return byIndex;
};

/** Point numbers are one-based to match the axis labels. */
export const describeViolation = (violation: RuleViolation): string => {
  const signals = violation.signals?.length
    ? violation.signals
    : violation.windowStart !== undefined && violation.windowEnd !== undefined
      ? [{ windowStart: violation.windowStart, windowEnd: violation.windowEnd, signalIndex: violation.signalIndex ?? violation.windowEnd }]
      : [];
  const windows = signals
    .slice(0, 3)
    .map((signal) => (signal.windowStart === signal.windowEnd
      ? `point ${signal.windowEnd + 1}`
      : `points ${signal.windowStart + 1}–${signal.windowEnd + 1}, signal at ${signal.signalIndex + 1}`))
    .join('; ');
  return `Rule ${violation.ruleNumber}: ${violation.description}${windows ? ` (${windows}${signals.length > 3 ? '; …' : ''})` : ''}`;
};

export const formatPlotted = (value: number | null | undefined, decimals: number): string => (
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : '—'
);

/** Loop-based so 150k+ points cannot overflow the call stack the way `Math.min(...values)` does. */
export const finiteExtent = (values: readonly number[]): { min: number; max: number } | null => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
};

/** Sturges bins over the finite values; a constant series gets one bin around its value. */
export const histogramBins = (values: readonly number[]): { bins: number[]; counts: number[] } | null => {
  const extent = finiteExtent(values);
  if (!extent) return null;
  const finiteCount = values.reduce((count, value) => count + (Number.isFinite(value) ? 1 : 0), 0);
  if (extent.min === extent.max) {
    return { bins: [extent.min - 0.5, extent.max + 0.5], counts: [finiteCount] };
  }
  const binCount = Math.max(1, Math.ceil(1 + 3.322 * Math.log10(finiteCount)));
  const width = (extent.max - extent.min) / binCount;
  const bins = Array.from({ length: binCount + 1 }, (_, index) => extent.min + index * width);
  const counts = new Array<number>(binCount).fill(0);
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    counts[Math.min(binCount - 1, Math.floor((value - extent.min) / width))] += 1;
  }
  return { bins, counts };
};
