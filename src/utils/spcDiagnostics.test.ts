import { describe, expect, it } from 'vitest';
import { buildSpcDiagnostics } from './spcDiagnostics';

describe('buildSpcDiagnostics', () => {
  it('profiles count data and recommends U chart with varying denominators', () => {
    const result = buildSpcDiagnostics({
      rows: [
        { defects: 3, opportunities: 100 },
        { defects: 4, opportunities: 120 },
        { defects: 1, opportunities: 80 },
      ],
      column: 'defects',
      denominatorColumn: 'opportunities',
      chartType: 'uChart',
      sampleSize: 5,
      selectedColumns: ['defects'],
    });

    expect(result.profile.dataKind).toBe('count');
    expect(result.profile.hasVaryingDenominator).toBe(true);
    expect(result.recommendations[0].chartType).toBe('uChart');
  });

  it('blocks a P chart when counts lack a denominator', () => {
    const result = buildSpcDiagnostics({
      rows: [
        { failed: 3 },
        { failed: 4 },
        { failed: 5 },
      ],
      column: 'failed',
      chartType: 'pChart',
      sampleSize: 50,
      selectedColumns: ['failed'],
    });

    expect(result.profile.dataKind).toBe('count');
    expect(result.diagnostics.some((item) => item.code === 'p-chart-needs-proportions')).toBe(true);
  });

  it('warns about autocorrelation and high tie rates for continuous data', () => {
    const rows = Array.from({ length: 24 }, (_, index) => ({
      value: index < 12 ? 10 : 10.1,
    }));

    const result = buildSpcDiagnostics({
      rows,
      column: 'value',
      chartType: 'individual',
      sampleSize: 5,
      selectedColumns: ['value'],
    });

    expect(result.profile.dataKind).toBe('continuous');
    expect(result.diagnostics.some((item) => item.code === 'high-tie-rate')).toBe(true);
    expect(result.recommendations.some((item) => item.chartType === 'individual')).toBe(true);
  });
});

describe('validation at row and subgroup boundaries', () => {
  it('checks paired denominators even when total valid counts match', () => {
    const result = buildSpcDiagnostics({
      rows: [{ value: 1, n: null }, { value: null, n: 10 }, { value: 2, n: 10 }],
      column: 'value', denominatorColumn: 'n', chartType: 'pChart', sampleSize: 10, selectedColumns: ['value'],
    });
    expect(result.diagnostics.some(d => d.code === 'invalid-denominators')).toBe(true);
  });

  it('validates P/NP counts and unsupported subgroup sizes', () => {
    const p = buildSpcDiagnostics({ rows: [{ v: 11, n: 10 }, { v: 1, n: 10 }], column: 'v', denominatorColumn: 'n', chartType: 'pChart', sampleSize: 10, selectedColumns: ['v'] });
    expect(p.diagnostics.some(d => d.code === 'invalid-p-count')).toBe(true);
    const np = buildSpcDiagnostics({ rows: [{ v: 11 }, { v: 1 }], column: 'v', chartType: 'npChart', sampleSize: 10, selectedColumns: ['v'] });
    expect(np.diagnostics.some(d => d.code === 'invalid-np-count')).toBe(true);
    const invalid = buildSpcDiagnostics({ rows: [{ v: 1 }, { v: 2 }], column: 'v', chartType: 'xBarR', sampleSize: 26, selectedColumns: ['v'] });
    expect(invalid.diagnostics.some(d => d.code === 'invalid-subgroup-size')).toBe(true);
    expect(invalid.recommendations.some(r => r.chartType === 'xBarR' || r.chartType === 'xBarS')).toBe(false);
  });

  it('counts valid multi-column subgroups and profiles all observations', () => {
    const result = buildSpcDiagnostics({
      rows: [{ a: 1, b: 2 }, { a: 3, b: null }, { a: 4, b: 5 }],
      column: 'a', chartType: 'xBarR', sampleSize: 2, selectedColumns: ['a', 'b'],
    });
    expect(result.profile.numericCount).toBe(5);
    expect(result.profile.missingCount).toBe(1);
    expect(result.diagnostics.some(d => d.code === 'incomplete-subgroups')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'too-few-subgroups')).toBe(false);
  });
});


it('reports when gaps leave no adjacent moving-range pairs', () => {
  const result = buildSpcDiagnostics({ rows: [{ v: 1 }, { v: null }, { v: 2 }], column: 'v', chartType: 'individual', sampleSize: 2, selectedColumns: ['v'] });
  expect(result.diagnostics.some(d => d.code === 'no-moving-ranges')).toBe(true);
});


describe('large dataset diagnostics', () => {
  it('profiles large measurement and opportunity series without argument-stack overflow', () => {
    const rows = Array.from({ length: 150_000 }, (_, i) => ({ value: i + 0.5, n: i + 1 }));
    const result = buildSpcDiagnostics({ rows, column: 'value', denominatorColumn: 'n', chartType: 'individual', sampleSize: 5, selectedColumns: ['value'] });
    expect(result.profile.numericCount).toBe(150_000);
    expect(result.profile.min).toBe(0.5);
    expect(result.profile.max).toBe(149_999.5);
    expect(result.profile.denominatorMin).toBe(1);
    expect(result.profile.denominatorMax).toBe(150_000);
  });
});


it('recognizes numeric sample order and compares subgroup means in either layout', () => {
  const ordered = buildSpcDiagnostics({ rows: Array.from({ length: 50 }, (_, i) => ({ x: i + 1, v: 10 + Math.sin(i) })), column: 'v', xAxisColumn: 'x', chartType: 'individual', sampleSize: 5, selectedColumns: ['v'] });
  expect(ordered.profile.timeOrdered).toBe(true);
  const groups = Array.from({ length: 30 }, (_, i) => ({ a: Math.sin(i) * 0.01, b: 0.6 + Math.sin(i) * 0.01, c: 0, d: 0.6 }));
  const wide = buildSpcDiagnostics({ rows: groups, column: 'a', chartType: 'xBarR', sampleSize: 4, selectedColumns: ['a', 'b', 'c', 'd'] });
  const tall = buildSpcDiagnostics({ rows: groups.flatMap(row => Object.values(row).map(v => ({ v }))), column: 'v', chartType: 'xBarR', sampleSize: 4, selectedColumns: ['v'] });
  expect(tall.profile.lag1Autocorrelation).toBeCloseTo(wide.profile.lag1Autocorrelation!, 10);
});

describe('one measurement per sample', () => {
  it.each([null, 'Sample'])('does not infer subgroups from the default size with X axis %s', (xAxisColumn) => {
    const result = buildSpcDiagnostics({
      rows: Array.from({ length: 30 }, (_, index) => ({ Sample: index + 1, Measurement: 12 + Math.sin(index) })),
      column: 'Measurement', xAxisColumn, chartType: 'individual', sampleSize: 5, selectedColumns: ['Measurement'],
    });
    expect(result.recommendations[0].chartType).toBe('individual');
    expect(result.recommendations.some(item => item.chartType === 'xBarR' || item.chartType === 'xBarS')).toBe(false);
  });

  it('does not infer subgroups in the minimal four-observation case', () => {
    const result = buildSpcDiagnostics({
      rows: [{ v: 10.1 }, { v: 10.2 }, { v: 10.3 }, { v: 10.4 }],
      column: 'v', chartType: 'individual', sampleSize: 2, selectedColumns: ['v'],
    });
    expect(result.recommendations[0].chartType).toBe('individual');
    expect(result.recommendations.some(item => item.chartType === 'xBarR' || item.chartType === 'xBarS')).toBe(false);
  });

  it('retains explicitly selected consecutive-row subgrouping', () => {
    const result = buildSpcDiagnostics({
      rows: Array.from({ length: 30 }, (_, index) => ({ Measurement: 12 + Math.sin(index) })),
      column: 'Measurement', chartType: 'xBarR', sampleSize: 5, selectedColumns: ['Measurement'],
    });
    expect(result.recommendations[0].chartType).toBe('xBarR');
  });
});
