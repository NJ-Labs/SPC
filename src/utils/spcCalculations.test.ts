import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AppContextProvider, useAppContext } from '../context/AppContext';
import { describe, expect, it } from 'vitest';
import {
  calculateCapabilityIndices,
  calculateCapabilityStatus,
  calculateControlLimits,
  getControlChartConstants,
  calculateEWMALimits,
  calculatePChartLimits,
  calculateUChartLimits,
} from './spcCalculations';

describe('calculateCapabilityIndices', () => {
  it('uses specification limits rather than control limits', () => {
    const result = calculateCapabilityIndices(10, 1, {
      lowerSpecLimit: 6,
      upperSpecLimit: 15,
    });

    expect(result.cp).toBeCloseTo(1.5, 6);
    expect(result.cpl).toBeCloseTo(1.333333, 6);
    expect(result.cpu).toBeCloseTo(1.666667, 6);
    expect(result.cpk).toBeCloseTo(1.333333, 6);
  });

  it('returns one-sided capability when only one spec limit is set', () => {
    const result = calculateCapabilityIndices(10, 1, {
      upperSpecLimit: 14,
    });

    expect(result.cp).toBeNaN();
    expect(result.cpl).toBeNaN();
    expect(result.cpu).toBeCloseTo(1.333333, 6);
    expect(result.cpk).toBeCloseTo(1.333333, 6);
  });

  it('does not calculate capability for invalid sigma or reversed spec limits', () => {
    expect(calculateCapabilityIndices(10, 0, {
      lowerSpecLimit: 6,
      upperSpecLimit: 15,
    }).cp).toBeNaN();

    expect(calculateCapabilityIndices(10, 1, {
      lowerSpecLimit: 15,
      upperSpecLimit: 6,
    }).cpk).toBeNaN();
  });
});

describe('attribute and EWMA limits', () => {
  it('calculates pointwise P chart limits when denominators vary', () => {
    const limits = calculatePChartLimits([5, 10], 100, [100, 200]);

    expect(limits.centerLine).toBeCloseTo(0.05, 6);
    expect(limits.chartValues).toEqual([0.05, 0.05]);
    expect(limits.uclSeries).toHaveLength(2);
    expect(limits.lclSeries).toHaveLength(2);
    expect(limits.uclSeries?.[0]).toBeGreaterThan(limits.uclSeries?.[1] ?? 0);
  });

  it('calculates pointwise U chart limits from defect counts and opportunities', () => {
    const limits = calculateUChartLimits([4, 10], 5, [2, 5]);

    expect(limits.centerLine).toBeCloseTo(2, 6);
    expect(limits.chartValues).toEqual([2, 2]);
    expect(limits.sigmaSeries?.[0]).toBeGreaterThan(limits.sigmaSeries?.[1] ?? 0);
  });

  it('uses startup EWMA limits before asymptotic limits', () => {
    const limits = calculateEWMALimits([10, 11, 12, 13, 14], 0.2);

    expect(limits.chartValues).toHaveLength(5);
    expect(limits.uclSeries).toHaveLength(5);
    expect(limits.uclSeries?.[0]).toBeLessThan(limits.ucl);
    expect(limits.lclSeries?.[0]).toBeGreaterThan(limits.lcl);
  });
});

describe('calculateCapabilityStatus', () => {
  it('marks attribute chart capability as not applicable', () => {
    const status = calculateCapabilityStatus([0.1, 0.2, 0.3], 0.2, 0.05, {
      lowerSpecLimit: 0,
      upperSpecLimit: 1,
    }, {
      chartType: 'pChart',
      ruleViolations: [],
    });

    expect(status.readiness).toBe('notApplicable');
    expect(status.indices.cpk).toBeNaN();
  });

  it('marks unstable continuous capability as preliminary', () => {
    const values = Array.from({ length: 40 }, (_, index) => 10 + Math.sin(index));
    const status = calculateCapabilityStatus(values, 10, 1, {
      lowerSpecLimit: 6,
      upperSpecLimit: 14,
      targetValue: 10,
    }, {
      chartType: 'individual',
      ruleViolations: [{ index: 3, pointValue: 15, ruleNumber: 1, description: 'Above UCL' }],
    });

    expect(status.readiness).toBe('preliminary');
    expect(status.indices.cpk).toBeCloseTo(1.333333, 6);
    expect(status.indices.ppk).toBeGreaterThan(0);
    expect(status.reasons.some((reason) => reason.includes('instability'))).toBe(true);
  });
});

describe('within and overall process estimates', () => {
  it('uses complete sequential subgroups without bridging invalid rows', () => {
    const rows = [0, 2, '', 4, 100, 102, 999].map(v => ({ v }));
    const limits = calculateControlLimits(rows, 'v', 'xBarR', 2);
    expect(limits.chartValues).toEqual([1, NaN, 101]);
    expect(limits.capabilityValues).toEqual([0, 2, 100, 102]);
    expect(limits.centerLine).toBe(51);
    expect(limits.processSigma).toBeCloseTo(2 / 1.128, 8);
    expect(limits.sigma).toBeCloseTo((2 / 1.128) / Math.sqrt(2), 8);
  });

  it('uses all selected columns in row subgroups for both X-bar methods', () => {
    const rows = [{ a: 0, b: 2 }, { a: 50, b: null }, { a: 100, b: 102 }];
    const r = calculateControlLimits(rows, 'a', 'xBarR', 2, null, ['a', 'b']);
    const s = calculateControlLimits(rows, 'a', 'xBarS', 2, null, ['a', 'b']);
    expect(r.chartValues).toEqual([1, NaN, 101]);
    expect(s.chartValues).toEqual([1, NaN, 101]);
    expect(r.capabilityValues).toEqual([0, 2, 100, 102]);
    expect(s.processSigma).toBeCloseTo(Math.SQRT2 / 0.7979, 8);
    expect(s.sigma).toBeCloseTo((Math.SQRT2 / 0.7979) / Math.sqrt(2), 8);
  });

  it('calculates Cp from within variation and Pp/Cpm from raw overall variation', () => {
    const values = [0, 2, 100, 102];
    const limits = calculateControlLimits(values.map(v => ({ v })), 'v', 'xBarR', 2);
    const status = calculateCapabilityStatus(values, 51, limits.processSigma!, { lowerSpecLimit: -10, upperSpecLimit: 110, targetValue: 50 }, { chartType: 'xBarR', sigmaMethod: limits.sigmaMethod });
    const overall = Math.sqrt((51 ** 2 + 49 ** 2 + 49 ** 2 + 51 ** 2) / 3);
    expect(status.indices.cp).toBeCloseTo(120 / (6 * (2 / 1.128)), 8);
    expect(status.indices.pp).toBeCloseTo(120 / (6 * overall), 8);
    expect(status.indices.cpm).toBeCloseTo(120 / (6 * Math.sqrt(overall ** 2 + 1)), 8);
    expect(status.sigmaEstimate).toMatchObject({ observationCount: 4, method: 'R-bar/d2' });
  });

  it('keeps overall performance when within sigma is zero, and declines all-zero variation', () => {
    const shifted = calculateCapabilityStatus([0, 0, 10, 10], 5, 0, { lowerSpecLimit: -5, upperSpecLimit: 15 }, { chartType: 'xBarR' });
    expect(shifted.indices.cpk).toBeNaN();
    expect(shifted.indices.ppk).toBeGreaterThan(0);
    expect(shifted.readiness).toBe('preliminary');
    const constant = calculateCapabilityStatus([5, 5], 5, 0, { lowerSpecLimit: 0, upperSpecLimit: 10, targetValue: 5 }, { chartType: 'individual' });
    expect(constant.readiness).toBe('notApplicable');
    expect(constant.indices.cpm).toBeNaN();
  });

  it('does not claim readiness without a stability assessment or with subgroup warnings', () => {
    const values = Array.from({ length: 40 }, (_, i) => 10 + Math.sin(i));
    const missingCheck = calculateCapabilityStatus(values, 10, 1, { lowerSpecLimit: 5, upperSpecLimit: 15 }, { chartType: 'individual' });
    expect(missingCheck.readiness).toBe('preliminary');
    expect(missingCheck.reasons.some(reason => reason.includes('not been evaluated'))).toBe(true);
    const incomplete = calculateCapabilityStatus(values, 10, 1, { lowerSpecLimit: 5, upperSpecLimit: 15 }, { chartType: 'xBarR', ruleViolations: [], diagnostics: [{ severity: 'warning', code: 'small-subgroup-baseline', message: 'Small baseline' }] });
    expect(incomplete.readiness).toBe('preliminary');
  });

  it('handles one-sided and outside-spec performance, invalid specs, and unsupported charts', () => {
    const result = calculateCapabilityStatus([11, 12, 13], 12, 1, { upperSpecLimit: 10 }, { chartType: 'individual' });
    expect(result.indices.cpk).toBeCloseTo(-2 / 3);
    expect(result.indices.ppk).toBeCloseTo(-2 / 3);
    expect(result.indices.cp).toBeNaN();
    expect(calculateCapabilityIndices(10, 1, { lowerSpecLimit: NaN, upperSpecLimit: 15 }).cpk).toBeNaN();
    expect(calculateCapabilityStatus([1, 2], 1.5, 1, { upperSpecLimit: 3 }, { chartType: 'histogram' }).readiness).toBe('notApplicable');
  });

  it('does not silently substitute constants or bridge moving ranges', () => {
    expect(getControlChartConstants(26).d2).toBeNaN();
    expect(getControlChartConstants(1).a2).toBeNaN();
    const invalid = calculateControlLimits([{ v: 1 }, { v: 2 }], 'v', 'xBarR', 0);
    expect(invalid.sigma).toBeNaN();
    const individual = calculateControlLimits([{ v: 1 }, { v: '' }, { v: 100 }, { v: 102 }], 'v', 'individual', 2);
    expect(individual.processSigma).toBeCloseTo(2 / 1.128);
    expect(individual.chartValues).toEqual([1, NaN, 100, 102]);
  });

  it('preserves EWMA history and observation age across a gap', () => {
    const result = calculateEWMALimits([2, 6, NaN, 2, 6], 0.5);
    expect(result.chartValues).toEqual([3, 4.5, NaN, 3.25, 4.625]);
    expect(result.sigmaSeries![3]).toBeGreaterThan(result.sigmaSeries![0]);
    expect(result.sigmaSeries?.[2]).toBeNaN();
  });

  it('excludes invalid P/U pairs and never invents missing denominators', () => {
    const p = calculatePChartLimits([2, 12, 1], 10, [10, 10, null]);
    expect(p.centerLine).toBeCloseTo(0.2);
    expect(p.chartValues).toEqual([0.2, NaN, NaN]);
    expect(calculatePChartLimits([2, 3], 10, [null, null]).centerLine).toBeNaN();
    const u = calculateUChartLimits([4, -1, 2.5], 2, [2, 2, 2]);
    expect(u.chartValues).toEqual([2, NaN, NaN]);
  });
});


describe('context SPC pipeline', () => {
  it('uses moving-range limit signals when judging individuals capability', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(AppContextProvider, null, children);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    const rows = [...Array(19).fill(0), 10].map(v => ({ v }));
    act(() => {
      result.current.setRawData({ data: rows, headers: ['v'], fileName: 'test', fileType: 'csv' });
      result.current.setSelectedColumns(['v']);
      result.current.setChartOptions({ ...result.current.chartOptions, lowerSpecLimit: -5, upperSpecLimit: 15 });
    });
    await waitFor(() => expect(result.current.processedData?.variationRuleViolations).toHaveLength(1));
    expect(result.current.processedData?.variationRuleViolations?.[0]).toMatchObject({ ruleNumber: 1, index: 19 });
    expect(result.current.processedData?.capabilityStatus?.reasons.some(reason => reason.includes('instability'))).toBe(true);
    const withGap = calculateControlLimits([{ v: 0 }, { v: null }, { v: 10 }], 'v', 'individual', 2);
    expect(withGap.variationChart?.chartValues).toEqual([NaN, NaN, NaN]);
  });

  it('uses R/S limit signals when judging capability stability', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(AppContextProvider, null, children);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    const rows = [...Array.from({ length: 11 }, () => ({ a: 5, b: 5 })), { a: 0, b: 10 }];
    act(() => {
      result.current.setRawData({ data: rows, headers: ['a', 'b'], fileName: 'test', fileType: 'csv' });
      result.current.setSelectedColumns(['a', 'b']);
      result.current.setSelectedChartType('xBarR');
      result.current.setChartOptions({ ...result.current.chartOptions, lowerSpecLimit: 0, upperSpecLimit: 10 });
    });
    await waitFor(() => expect(result.current.processedData?.variationRuleViolations).toHaveLength(1));
    expect(result.current.processedData?.variationRuleViolations?.[0]).toMatchObject({ ruleNumber: 1, index: 11 });
    expect(result.current.processedData?.ruleViolations).toHaveLength(0);
    expect(result.current.processedData?.capabilityStatus?.reasons.some(reason => reason.includes('instability'))).toBe(true);
    const limits = calculateControlLimits(rows, 'a', 'xBarS', 2, null, ['a', 'b']);
    expect(limits.variationChart?.chartValues[11]).toBeGreaterThan(limits.variationChart!.ucl);
  });

  it('uses the same multi-column observations for subgroup limits, rules and capability', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(AppContextProvider, null, children);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    act(() => {
      result.current.setRawData({ data: [{ a: 0, b: 2 }, { a: 50, b: null }, { a: 100, b: 102 }], headers: ['a', 'b'], fileName: 'test', fileType: 'csv' });
      result.current.setSelectedColumns(['a', 'b']);
      result.current.setSelectedChartType('xBarR');
      result.current.setChartOptions({ ...result.current.chartOptions, lowerSpecLimit: -10, upperSpecLimit: 110 });
    });
    await waitFor(() => expect(result.current.processedData?.capabilityStatus?.indices.cp).toBeCloseTo(120 / (6 * (2 / 1.128)), 7));
    const processed = result.current.processedData!;
    expect(processed.controlLimits.chartValues).toEqual([1, NaN, 101]);
    expect(processed.controlLimits.processSigma).toBeCloseTo(2 / 1.128);
    expect(processed.capabilityStatus?.sigmaEstimate?.observationCount).toBe(4);
    expect(processed.ruleViolations.some(v => v.index === 1)).toBe(false);
  });
});


describe('context rule selection', () => {
  it('propagates the selected Western Electric rule set to the engine', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(AppContextProvider, null, children);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    act(() => {
      result.current.setRawData({ data: [...Array(8).fill(1), -8, -8].map(v => ({ v })), headers: ['v'], fileName: 'test', fileType: 'csv' });
      result.current.setSelectedColumns(['v']);
      result.current.setChartOptions({ ...result.current.chartOptions, ruleSet: 'westernElectric' });
    });
    await waitFor(() => expect(result.current.processedData?.ruleViolations.filter(v => v.ruleNumber === 4)).toHaveLength(8));
    expect(result.current.processedData?.ruleViolations.find(v => v.ruleNumber === 4)?.ruleSet).toBe('westernElectric');
  });
});


it('uses the standard NIST Cpm width for off-center targets and rejects outside targets', () => {
  const options = { chartType: 'individual' as const, ruleViolations: [] };
  const result = calculateCapabilityStatus([7.5, 8, 8.5], 8, 0.5, { lowerSpecLimit: 0, upperSpecLimit: 10, targetValue: 8 }, options);
  expect(result.indices.cpm).toBeCloseTo(10 / (6 * 0.5));
  const outside = calculateCapabilityStatus([7.5, 8, 8.5], 8, 0.5, { lowerSpecLimit: 0, upperSpecLimit: 10, targetValue: 20 }, options);
  expect(outside.indices.cpm).toBeNaN();
  expect(outside.indices.cpk).toBeGreaterThan(0);
  expect(outside.reasons.some(reason => reason.includes('target'))).toBe(true);
});
