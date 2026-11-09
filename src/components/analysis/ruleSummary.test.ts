import { describe, expect, it } from 'vitest';
import type { RuleViolation } from '../../types/DataTypes';
import {
  MAX_RULE_WINDOWS,
  activeRuleSet,
  groupRuleViolations,
  sigmaRange,
  sigmaZones,
} from './ruleSummary';

type Counted = RuleViolation & { signalCount?: number };

const violation = (index: number, ruleNumber: number, extra: Partial<Counted> = {}): Counted => ({
  index,
  pointValue: 0,
  ruleNumber,
  description: `rule ${ruleNumber}`,
  ...extra,
});

describe('groupRuleViolations', () => {
  it('sums signalCount for the exact number of signals, independent of sampled windows', () => {
    const groups = groupRuleViolations([
      violation(9, 2, { signalCount: 2, signals: [{ windowStart: 1, windowEnd: 9, signalIndex: 9, participatingIndices: [] }] }),
      violation(10, 2, { signalCount: 0 }),
      violation(11, 2, { signalCount: 3 }),
      violation(4, 1, { signalCount: 1 }),
    ]);
    expect(groups.map((group) => group.ruleNumber)).toEqual([1, 2]);
    const rule2 = groups[1];
    expect(rule2.signalTotal).toBe(5);
    expect(rule2.signalTotalIsExact).toBe(true);
    expect(rule2.points).toEqual([10, 11, 12]);
    // One window was supplied; the total is not derived from it.
    expect(rule2.windows).toEqual([{ start: 2, end: 10, signalAt: 10 }]);
  });

  it('falls back to counted windows, and says the total is not exact, when the engine gives no counts', () => {
    const group = groupRuleViolations([
      violation(5, 3, { windowStart: 0, windowEnd: 5, signalIndex: 5 }),
      violation(6, 3, { windowStart: 1, windowEnd: 6, signalIndex: 6 }),
      violation(6, 3, { windowStart: 1, windowEnd: 6, signalIndex: 6 }),
    ])[0];
    expect(group.signalTotal).toBe(2);
    expect(group.signalTotalIsExact).toBe(false);
    expect(group.points).toEqual([6, 7]);
  });

  it('counts uncounted records individually when counts are only partly present', () => {
    const group = groupRuleViolations([violation(1, 1, { signalCount: 4 }), violation(2, 1)])[0];
    expect(group.signalTotal).toBe(5);
    expect(group.signalTotalIsExact).toBe(false);
  });

  it('bounds retained windows per rule while keeping exact counts and every point', () => {
    const records = Array.from({ length: 5000 }, (_, i) => violation(i + 14, 2, {
      signalCount: 1,
      signals: [{ windowStart: i, windowEnd: i + 8, signalIndex: i + 8, participatingIndices: [] }],
    }));
    const group = groupRuleViolations(records)[0];
    expect(group.windows).toHaveLength(MAX_RULE_WINDOWS);
    expect(MAX_RULE_WINDOWS).toBe(200);
    expect(group.signalTotal).toBe(5000);
    expect(group.signalTotalIsExact).toBe(true);
    expect(group.points).toHaveLength(5000);
  });

  it('does not rebuild windows from per-record fields once the cap is reached', () => {
    const records = Array.from({ length: 2000 }, (_, i) => violation(i, 5, { windowStart: i, windowEnd: i + 2, signalIndex: i + 2, signalCount: 1 }));
    const group = groupRuleViolations(records)[0];
    expect(group.windows).toHaveLength(MAX_RULE_WINDOWS);
    expect(group.signalTotal).toBe(2000);
  });

  it('copes with a long drift without recursion limits', () => {
    const records = Array.from({ length: 150_000 }, (_, i) => violation(i, 3, { signalCount: 1 }));
    const group = groupRuleViolations(records)[0];
    expect(group.signalTotal).toBe(150_000);
    expect(group.points).toHaveLength(150_000);
  });
});

describe('activeRuleSet', () => {
  it('prefers the set the violations were computed with over the current selection', () => {
    expect(activeRuleSet([violation(1, 1, { ruleSet: 'westernElectric' })], 'nelson')).toBe('westernElectric');
    expect(activeRuleSet([], 'westernElectric')).toBe('westernElectric');
    expect(activeRuleSet([], undefined)).toBe('nelson');
  });
});

describe('sigma helpers', () => {
  it('lays zones out in σ from the center line', () => {
    const [c, b, a] = sigmaZones(10, 2);
    expect(c).toMatchObject({ key: 'zoneC', lower: [8, 10], upper: [10, 12] });
    expect(b).toMatchObject({ key: 'zoneB', lower: [6, 8], upper: [12, 14] });
    expect(a).toMatchObject({ key: 'zoneA', lower: [4, 6], upper: [14, 16] });
  });

  it('reports a varying σ range without spreading a huge series into Math.min', () => {
    const series = Array.from({ length: 300_000 }, (_, i) => (i === 7 ? Number.NaN : 1 + (i % 10) / 10));
    expect(sigmaRange({ sigma: 1.5, sigmaSeries: series })).toEqual({ min: 1, max: 1.9, varies: true });
    expect(sigmaRange({ sigma: 1.5 })).toEqual({ min: 1.5, max: 1.5, varies: false });
    expect(sigmaRange({ sigma: 1.5, sigmaSeries: [Number.NaN] })).toEqual({ min: 1.5, max: 1.5, varies: false });
  });
});
