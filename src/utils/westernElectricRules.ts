import { ControlLimits, DataPoint, RuleSet, RuleSignal, RuleViolation } from '../types/DataTypes';

type RuleKind = 'limit' | 'sameSide' | 'trend' | 'alternating' | 'zone2' | 'zone1' | 'within1' | 'outside1';
export interface RuleMetadata {
  ruleNumber: number;
  description: string;
  windowSize: number;
  kind: RuleKind;
}

// The historical default was the eight Nelson tests, despite the old function name.
export const RULE_SETS: Record<RuleSet, readonly RuleMetadata[]> = {
  nelson: [
    { ruleNumber: 1, kind: 'limit', windowSize: 1, description: 'One point beyond a control limit' },
    { ruleNumber: 2, kind: 'sameSide', windowSize: 9, description: '9 consecutive points on the same side of the centerline' },
    { ruleNumber: 3, kind: 'trend', windowSize: 6, description: '6 consecutive points all increasing or all decreasing' },
    { ruleNumber: 4, kind: 'alternating', windowSize: 14, description: '14 consecutive points alternating up and down' },
    { ruleNumber: 5, kind: 'zone2', windowSize: 3, description: '2 out of 3 consecutive points beyond 2σ on the same side' },
    { ruleNumber: 6, kind: 'zone1', windowSize: 5, description: '4 out of 5 consecutive points beyond 1σ on the same side' },
    { ruleNumber: 7, kind: 'within1', windowSize: 15, description: '15 consecutive points within 1σ of the centerline' },
    { ruleNumber: 8, kind: 'outside1', windowSize: 8, description: '8 consecutive points beyond 1σ, with points on both sides' },
  ],
  westernElectric: [
    { ruleNumber: 1, kind: 'limit', windowSize: 1, description: 'One point beyond a control limit' },
    { ruleNumber: 2, kind: 'zone2', windowSize: 3, description: '2 out of 3 consecutive points beyond 2σ on the same side' },
    { ruleNumber: 3, kind: 'zone1', windowSize: 5, description: '4 out of 5 consecutive points beyond 1σ on the same side' },
    { ruleNumber: 4, kind: 'sameSide', windowSize: 8, description: '8 consecutive points on the same side of the centerline' },
  ],
};

export const getRuleDescriptions = (ruleSet: RuleSet = 'nelson'): RuleMetadata[] =>
  RULE_SETS[ruleSet].map(rule => ({ ...rule }));

// Kept for existing callers; pass westernElectric explicitly for the four WE rules.
export const getWesternElectricRulesDescription = (ruleSet: RuleSet = 'nelson'): RuleMetadata[] =>
  getRuleDescriptions(ruleSet);

const parseValue = (value: unknown): number => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/** Returns each participating point once per rule, exact counts, and bounded window evidence. */
export const detectRuleViolations = (
  data: DataPoint[],
  column: string,
  controlLimits: ControlLimits,
  ruleSet: RuleSet = 'nelson',
  options: { ruleNumbers?: readonly number[]; maxEvidenceWindows?: number } = {},
): RuleViolation[] => {
  const values = data.map(row => parseValue(row[column]));
  const { centerLine } = controlLimits;
  const violations: RuleViolation[] = [];
  let points = new Map<number, RuleViolation>();
  let evidenceWindows = 0;
  const maxEvidenceWindows = Math.max(0, Math.floor(options.maxEvidenceWindows ?? 200));
  // If a pointwise series exists, a missing/invalid entry is a gap, never a global fallback.
  const at = (series: number[] | undefined, fallback: number, index: number): number =>
    series === undefined ? fallback : series[index];
  const sigmaAt = (index: number) => at(controlLimits.sigmaSeries, controlLimits.sigma, index);

  const addSignal = (rule: RuleMetadata, start: number, end: number, participatingIndices: number[]) => {
    const keepEvidence = evidenceWindows++ < maxEvidenceWindows;
    const signal: RuleSignal | undefined = keepEvidence ? { windowStart: start, windowEnd: end, signalIndex: end, participatingIndices } : undefined;
    for (const index of participatingIndices) {
      const existing = points.get(index);
      if (existing) {
        if (signal) existing.signals?.push(signal);
      } else {
        points.set(index, {
          index, pointValue: values[index], ruleNumber: rule.ruleNumber, description: rule.description,
          ruleSet, windowStart: start, windowEnd: end, signalIndex: end, signalCount: 0,
          ...(signal ? { participatingIndices, signals: [signal] } : {}),
        });
      }
    }
    const owner = points.get(participatingIndices[participatingIndices.length - 1]);
    if (owner) owner.signalCount = (owner.signalCount ?? 0) + 1;
  };

  for (const rule of RULE_SETS[ruleSet]) {
    if (options.ruleNumbers && !options.ruleNumbers.includes(rule.ruleNumber)) continue;
    points = new Map();
    evidenceWindows = 0;
    for (let end = rule.windowSize - 1; end < values.length; end++) {
      const start = end - rule.windowSize + 1;
      const indices = Array.from({ length: rule.windowSize }, (_, offset) => start + offset);
      if (!indices.every(index => Number.isFinite(values[index]))) continue;

      if (rule.kind === 'limit') {
        const ucl = at(controlLimits.uclSeries, controlLimits.ucl, end);
        const lcl = at(controlLimits.lclSeries, controlLimits.lcl, end);
        if ((Number.isFinite(ucl) && values[end] > ucl) || (Number.isFinite(lcl) && values[end] < lcl)) {
          addSignal(rule, start, end, indices);
        }
        continue;
      }
      if (rule.kind === 'trend' || rule.kind === 'alternating') {
        const differences = indices.slice(1).map(index => values[index] - values[index - 1]);
        const match = rule.kind === 'trend'
          ? differences.every(d => d > 0) || differences.every(d => d < 0)
          : differences.every((d, i) => d !== 0 && (i === 0 || Math.sign(d) !== Math.sign(differences[i - 1])));
        if (match) addSignal(rule, start, end, indices);
        continue;
      }
      if (!Number.isFinite(centerLine)) continue;
      if (rule.kind === 'sameSide') {
        if (indices.every(i => values[i] > centerLine) || indices.every(i => values[i] < centerLine)) {
          addSignal(rule, start, end, indices);
        }
        continue;
      }
      if (!indices.every(i => Number.isFinite(sigmaAt(i)) && sigmaAt(i) > 0)) continue;
      const z = indices.map(i => (values[i] - centerLine) / sigmaAt(i));
      if (rule.kind === 'zone2' || rule.kind === 'zone1') {
        const threshold = rule.kind === 'zone2' ? 2 : 1;
        const required = rule.kind === 'zone2' ? 2 : 4;
        const above = indices.filter((_, i) => z[i] > threshold);
        const below = indices.filter((_, i) => z[i] < -threshold);
        if (above.length >= required) addSignal(rule, start, end, above);
        if (below.length >= required) addSignal(rule, start, end, below);
      } else if (rule.kind === 'within1') {
        if (z.every(value => Math.abs(value) < 1)) addSignal(rule, start, end, indices);
      } else if (rule.kind === 'outside1') {
        if (z.every(value => Math.abs(value) > 1) && z.some(value => value > 1) && z.some(value => value < -1)) {
          addSignal(rule, start, end, indices);
        }
      }
    }
    for (const violation of points.values()) violations.push(violation);
  }
  return violations;
};
