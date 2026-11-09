import { describe, expect, it } from 'vitest';
import type { RuleViolation } from '../../types/DataTypes';
import {
  buildAxisLabels,
  constantLine,
  describeViolation,
  finiteExtent,
  finiteOrNull,
  formatPlotted,
  groupViolationsByIndex,
  histogramBins,
  pointwiseLine,
  toPlotValues,
  zoneLine,
} from './chartSeries';

describe('plotted series keep their gaps', () => {
  it('maps NaN and non-numbers to null without shifting positions', () => {
    expect(toPlotValues([1, Number.NaN, 3])).toEqual([1, null, 3]);
    expect(finiteOrNull(0)).toBe(0);
    expect(finiteOrNull(undefined)).toBeNull();
    expect(finiteOrNull(Number.POSITIVE_INFINITY)).toBeNull();
    expect(constantLine(3, Number.NaN)).toEqual([null, null, null]);
  });

  it('uses pointwise limits only when they cover every plotted point', () => {
    expect(pointwiseLine([1, 2, Number.NaN], 9, 3)).toEqual([1, 2, null]);
    expect(pointwiseLine([1, 2], 9, 3)).toEqual([9, 9, 9]);
    expect(pointwiseLine(undefined, 9, 2)).toEqual([9, 9]);
  });

  it('draws zones per point and stops lower zones at a floor', () => {
    expect(zoneLine(10, [1, null, 2], 2, 1)).toEqual([12, null, 14]);
    expect(zoneLine(1, [1, 2], 2, -1, 0)).toEqual([0, 0]);
    expect(zoneLine(1, [0.1], 2, -1, 0)).toEqual([0.8]);
    expect(zoneLine(Number.NaN, [1], 1, 1)).toEqual([null]);
  });

  it('labels the axis with positions or the chosen column, never a different length', () => {
    const rows = [{ d: 'Mon' }, { d: 'Tue' }];
    expect(buildAxisLabels(rows, 'd', 2)).toEqual(['Mon', 'Tue']);
    expect(buildAxisLabels(rows, null, 2)).toEqual(['1', '2']);
    // Subgroup series are shorter than the row count: fall back to subgroup numbers.
    expect(buildAxisLabels(rows, 'd', 1)).toEqual(['1']);
  });

  it('formats missing numbers visibly', () => {
    expect(formatPlotted(Number.NaN, 2)).toBe('—');
    expect(formatPlotted(null, 2)).toBe('—');
    expect(formatPlotted(0, 2)).toBe('0.00');
  });
});

describe('violation helpers', () => {
  const base: RuleViolation = { index: 4, pointValue: 1, ruleNumber: 5, description: '2 of 3 beyond 2σ' };

  it('groups by point index', () => {
    const grouped = groupViolationsByIndex([base, { ...base, ruleNumber: 1 }, { ...base, index: 7 }]);
    expect(grouped.get(4)).toHaveLength(2);
    expect(grouped.get(7)).toHaveLength(1);
  });

  it('describes windows with one-based point numbers', () => {
    const text = describeViolation({ ...base, signals: [{ windowStart: 2, windowEnd: 4, signalIndex: 4, participatingIndices: [3, 4] }] });
    expect(text).toBe('Rule 5: 2 of 3 beyond 2σ (points 3–5, signal at 5)');
    expect(describeViolation(base)).toBe('Rule 5: 2 of 3 beyond 2σ');
    expect(describeViolation({ ...base, windowStart: 4, windowEnd: 4 })).toContain('point 5');
  });

  it('shows only a few windows in a tooltip', () => {
    const signals = Array.from({ length: 10 }, (_, i) => ({ windowStart: i, windowEnd: i + 2, signalIndex: i + 2, participatingIndices: [] }));
    expect(describeViolation({ ...base, signals })).toMatch(/; …\)$/);
  });
});

describe('large-series helpers', () => {
  it('computes extents on hundreds of thousands of points without overflowing the stack', () => {
    const values = Array.from({ length: 400_000 }, (_, i) => (i === 3 ? Number.NaN : (i % 1000) - 500));
    expect(finiteExtent(values)).toEqual({ min: -500, max: 499 });
    expect(finiteExtent([Number.NaN])).toBeNull();
    expect(finiteExtent([])).toBeNull();
  });

  it('bins finite values only and handles a constant series', () => {
    const big = Array.from({ length: 400_000 }, (_, i) => i % 100);
    const result = histogramBins(big);
    expect(result?.counts.reduce((a, b) => a + b, 0)).toBe(400_000);
    expect(result?.bins).toHaveLength((result?.counts.length ?? 0) + 1);

    expect(histogramBins([5, 5, Number.NaN, 5])).toEqual({ bins: [4.5, 5.5], counts: [3] });
    expect(histogramBins([Number.NaN])).toBeNull();
    const small = histogramBins([0, 1, 2, 3, 4, 10]);
    expect(small?.counts.reduce((a, b) => a + b, 0)).toBe(6);
    // The maximum lands in the last bin rather than past it.
    expect(small?.counts[small.counts.length - 1]).toBeGreaterThan(0);
  });
});
