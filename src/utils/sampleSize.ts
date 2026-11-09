import type { ChartType } from '../types/DataTypes';

export const SAMPLE_SIZE_MIN = 2;
export const SAMPLE_SIZE_MAX = 25;
export type SampleSizeRule = { kind: 'integerRange'; min: number; max: number } | { kind: 'positiveReal' };

export const sampleSizeRule = (chartType: ChartType): SampleSizeRule => {
  if (chartType === 'pChart' || chartType === 'npChart') return { kind: 'integerRange', min: 1, max: Number.MAX_SAFE_INTEGER };
  if (chartType === 'uChart') return { kind: 'positiveReal' };
  return { kind: 'integerRange', min: SAMPLE_SIZE_MIN, max: SAMPLE_SIZE_MAX };
};

export const sampleSizeBounds = (chartType: ChartType) => {
  const rule = sampleSizeRule(chartType);
  return rule.kind === 'positiveReal'
    ? { min: 0, max: null, exclusiveMin: true, integer: false }
    : { min: rule.min, max: rule.max, exclusiveMin: false, integer: true };
};
