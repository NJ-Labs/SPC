import type { ControlLimits, RuleViolation, RuleSet } from '../../types/DataTypes';
import { finiteExtent } from '../charts/chartSeries';

/** `signalCount` is optional until every engine build emits it; see `groupRuleViolations`. */
type CountedViolation = RuleViolation & { signalCount?: number };

export interface RuleWindow {
  /** One-based, inclusive. */
  start: number;
  end: number;
  signalAt: number;
}

export interface RuleGroup {
  ruleNumber: number;
  /**
   * Exact number of signals for this rule. Summed from each record's `signalCount` when the engine
   * provides it; otherwise the distinct windows seen, which can undercount if `signals` is a sample.
   */
  signalTotal: number;
  signalTotalIsExact: boolean;
  /** One-based point numbers, ascending and unique. */
  points: number[];
  windows: RuleWindow[];
}

const windowsOf = (violation: RuleViolation): RuleWindow[] => {
  const signals = violation.signals?.length
    ? violation.signals
    : violation.windowStart !== undefined && violation.windowEnd !== undefined
      ? [{ windowStart: violation.windowStart, windowEnd: violation.windowEnd, signalIndex: violation.signalIndex ?? violation.windowEnd }]
      : [];
  return signals.map((signal) => ({
    start: signal.windowStart + 1,
    end: signal.windowEnd + 1,
    signalAt: signal.signalIndex + 1,
  }));
};

/** Display cap per rule; matches the engine's evidence cap so the panel never re-expands it. */
export const MAX_RULE_WINDOWS = 200;

/** Groups flagged points by rule number. Windows are a bounded preview; totals come from `signalCount`. */
export const groupRuleViolations = (violations: readonly RuleViolation[]): RuleGroup[] => {
  const groups = new Map<number, {
    points: number[];
    windows: Map<string, RuleWindow>;
    counted: number;
    uncountedRecords: number;
    hasCount: boolean;
  }>();
  for (const violation of violations as readonly CountedViolation[]) {
    const group = groups.get(violation.ruleNumber) ?? {
      points: [],
      windows: new Map<string, RuleWindow>(),
      counted: 0,
      uncountedRecords: 0,
      hasCount: false,
    };
    group.points.push(violation.index + 1);
    // Once the cap is reached, windows are neither built nor keyed: a long drift would otherwise
    // retain hundreds of thousands of them just to show the first few.
    if (group.windows.size < MAX_RULE_WINDOWS) {
      for (const window of windowsOf(violation)) {
        if (group.windows.size >= MAX_RULE_WINDOWS) break;
        group.windows.set(`${window.start}-${window.end}-${window.signalAt}`, window);
      }
    }
    if (typeof violation.signalCount === "number" && Number.isFinite(violation.signalCount) && violation.signalCount >= 0) {
      group.counted += violation.signalCount;
      group.hasCount = true;
    } else {
      group.uncountedRecords += 1;
    }
    groups.set(violation.ruleNumber, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ruleNumber, group]) => {
      const windows = [...group.windows.values()].sort((a, b) => a.signalAt - b.signalAt || a.start - b.start);
      const points = group.points.sort((a, b) => a - b).filter((point, index, all) => index === 0 || point !== all[index - 1]);
      const exact = group.hasCount && group.uncountedRecords === 0;
      return {
        ruleNumber,
        signalTotal: exact
          ? group.counted
          : group.hasCount
            ? group.counted + group.uncountedRecords
            : windows.length > 0 ? windows.length : points.length,
        signalTotalIsExact: exact,
        points,
        windows,
      };
    });
};

/** The rule set the violations were actually computed with, falling back to the selected one. */
export const activeRuleSet = (violations: readonly RuleViolation[], selected: RuleSet | undefined): RuleSet => (
  violations.find((violation) => violation.ruleSet)?.ruleSet ?? selected ?? 'nelson'
);

export interface SigmaZone {
  key: 'zoneC' | 'zoneB' | 'zoneA';
  /** Distance from the center line, in σ. */
  from: number;
  to: number;
  lower: [number, number];
  upper: [number, number];
}

/** Zone bounds for the plotted statistic at the shared σ. Non-finite when σ is unusable. */
export const sigmaZones = (centerLine: number, sigma: number): SigmaZone[] => (
  [
    { key: 'zoneC' as const, from: 0, to: 1 },
    { key: 'zoneB' as const, from: 1, to: 2 },
    { key: 'zoneA' as const, from: 2, to: 3 },
  ].map((zone) => ({
    ...zone,
    lower: [centerLine - zone.to * sigma, centerLine - zone.from * sigma] as [number, number],
    upper: [centerLine + zone.from * sigma, centerLine + zone.to * sigma] as [number, number],
  }))
);

export const sigmaRange = (limits: Pick<ControlLimits, 'sigma' | 'sigmaSeries'>): { min: number; max: number; varies: boolean } => {
  const extent = finiteExtent(limits.sigmaSeries ?? []);
  if (!extent) return { min: limits.sigma, max: limits.sigma, varies: false };
  return { ...extent, varies: extent.max - extent.min > 1e-12 };
};
