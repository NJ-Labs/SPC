import { describe, expect, it } from 'vitest';
import { calculateControlLimits } from './spcCalculations';
import { detectRuleViolations, getRuleDescriptions, getWesternElectricRulesDescription } from './westernElectricRules';
import type { ControlLimits, RuleSet } from '../types/DataTypes';

const limits: ControlLimits = { centerLine: 0, sigma: 1, ucl: 3, lcl: -3 };
const detect = (values: Array<number | string | null>, ruleSet: RuleSet = 'nelson', control = limits) =>
  detectRuleViolations(values.map(v => ({ v })), 'v', control, ruleSet);
const rule = (values: Array<number | string | null>, number: number, ruleSet: RuleSet = 'nelson', control = limits) =>
  detect(values, ruleSet, control).filter(v => v.ruleNumber === number);

describe('SPC correctness regression', () => {
  it('uses subgroup-mean sigma for X-bar zones', () => {
    const result = calculateControlLimits([0, 2, 2, 4].map(v => ({ v })), 'v', 'xBarR', 2);
    expect(result.sigma).toBeCloseTo((2 / 1.128) / Math.sqrt(2), 8);
    expect(result.processSigma).toBeCloseTo(2 / 1.128, 8);
  });

  it('finds overlapping windows, deduplicating points but retaining every signal', () => {
    const violations = rule(Array(10).fill(0.5), 2);
    expect(violations.map(v => v.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(violations.find(v => v.index === 1)?.signals?.map(s => s.signalIndex)).toEqual([8, 9]);
    expect(violations[9]).toMatchObject({ windowStart: 1, windowEnd: 9, signalIndex: 9 });
  });
});

describe('Nelson and Western Electric rules', () => {
  it('keeps Nelson IDs by default and offers explicit four-rule WE metadata', () => {
    expect(getWesternElectricRulesDescription()).toEqual(getRuleDescriptions('nelson'));
    expect(getRuleDescriptions('westernElectric').map(r => r.ruleNumber)).toEqual([1, 2, 3, 4]);
    expect(rule(Array(8).fill(0.5), 2)).toHaveLength(0);
    expect(rule(Array(8).fill(0.5), 4, 'westernElectric')).toHaveLength(8);
    expect(rule([2.5, 0, 2.5], 2, 'westernElectric').map(v => v.index)).toEqual([0, 2]);
  });

  it('requires strict trends and alternation, breaking windows at ties or gaps', () => {
    expect(rule([1, 2, 3, 4, 5, 6, 7], 3).map(v => v.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rule([1, 2, 3, 3, 4, 5], 3)).toHaveLength(0);
    expect(rule(Array.from({ length: 14 }, (_, i) => i % 2), 4)).toHaveLength(14);
    expect(rule([1, 1, 1, 1, null, 1, 1, 1, 1, 1], 2)).toHaveLength(0);
    expect(rule([1, 1, 1, 1, '1bad', 1, 1, 1, 1, 1], 2)).toHaveLength(0);
  });

  it('reports zone participants separately from the triggering window endpoint', () => {
    const violations = rule([2.5, 2.5, 0], 5);
    expect(violations.map(v => v.index)).toEqual([0, 1]);
    expect(violations[0]).toMatchObject({ windowStart: 0, windowEnd: 2, signalIndex: 2, participatingIndices: [0, 1] });
    expect(rule([1.5, 1.5, 0, 1.5, 1.5, 1.5], 6).map(v => v.index)).toEqual([0, 1, 3, 4, 5]);
    expect(rule([2, 2, 0], 5)).toHaveLength(0);
    expect(rule([2.5, -2.5, 0], 5)).toHaveLength(0);
  });

  it('detects a 15-point central run and the WE 4-of-5 rule', () => {
    expect(rule(Array(15).fill(0.5), 7)).toHaveLength(15);
    expect(rule([1.5, 1.5, 0, 1.5, 1.5], 3, 'westernElectric').map(v => v.index)).toEqual([0, 1, 3, 4]);
  });

  it('requires both sides for rule 8 and does not use zero or invalid sigma for zones', () => {
    expect(rule(Array(8).fill(1.5), 8)).toHaveLength(0);
    expect(rule([1.5, -1.5, 1.5, -1.5, 1.5, -1.5, 1.5, -1.5], 8)).toHaveLength(8);
    expect(rule(Array(15).fill(0), 7, 'nelson', { ...limits, sigma: 0 })).toHaveLength(0);
    expect(rule(Array(8).fill(2), 8, 'nelson', { ...limits, sigma: NaN })).toHaveLength(0);
    expect(rule(Array(15).fill(1), 7)).toHaveLength(0);
  });

  it('uses pointwise limits and sigmas without falling back for missing entries', () => {
    const pointwise = { ...limits, uclSeries: [4, 2, NaN], lclSeries: [-4, -2, NaN], sigmaSeries: [1, 0.5, NaN] };
    expect(rule([3.5, 2.5, 10], 1, 'nelson', pointwise).map(v => v.index)).toEqual([1]);
    expect(rule([1.2, 1.2, 1.2], 5, 'nelson', pointwise)).toHaveLength(0);
    expect(rule([1.2, 1.2, 0], 5, 'nelson', { ...limits, sigmaSeries: [0.5, 0.5, 1] })).toHaveLength(2);
  });
});


it('bounds retained evidence while preserving every detected window count', () => {
  const violations = rule(Array(2000).fill(0.5), 2);
  expect(violations).toHaveLength(2000);
  expect(violations.reduce((count, violation) => count + (violation.signalCount ?? 0), 0)).toBe(1992);
  expect(new Set(violations.flatMap(violation => violation.signals ?? [])).size).toBeLessThanOrEqual(200);
});
