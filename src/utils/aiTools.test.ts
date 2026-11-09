import { describe, expect, it } from 'vitest';
import type { ChartOptions, DataSet, ProcessedData, RuleViolation } from '../types/DataTypes';
import { buildAssistantSystemPrompt, summarizeDatasetForAi } from './aiHelpers';
import {
  buildAgentTurnRequest,
  buildColumnProfiles,
  buildControlsSnapshot,
  selectControlsSnapshotSections,
  summarizeRuleViolations,
} from './aiTools';

const chartOptions: ChartOptions = {
  title: 'Chart',
  xAxisLabel: 'X',
  yAxisLabel: 'Y',
  showControlLimits: true,
  showCenterLine: true,
  showRuleViolations: true,
  colorScheme: 'default',
  lowerSpecLimit: 9.5,
  upperSpecLimit: 10.5,
  targetValue: Number.NaN,
  ruleSet: 'westernElectric',
};

const rows = Array.from({ length: 200 }, (_, index) => ({
  A: 10 + (index % 7) * 0.01,
  Defects: String(index % 4),
  Offset: index % 2 ? -1 : 2,
  Note: index === 0 ? 'x'.repeat(500) : '',
}));

const rawData: DataSet = {
  data: rows,
  headers: ['A', 'Defects', 'Offset', 'Note'],
  fileName: 'sample.csv',
  fileType: 'csv',
};

const violation = (ruleNumber: number, index: number, extra: Partial<RuleViolation> & { signalCount?: number } = {}) => ({
  ruleNumber,
  index,
  pointValue: 1,
  description: `rule ${ruleNumber}`,
  ...extra,
});

const longSeries = Array.from({ length: 5000 }, (_, index) => index);

const processedData = {
  data: rows,
  controlLimits: {
    ucl: 10.3,
    lcl: 9.7,
    centerLine: 10,
    sigma: 0.1,
    processSigma: 0.1,
    sigmaMethod: 'MR-bar/d2 (n=2)',
    chartValues: longSeries,
    capabilityValues: longSeries,
    uclSeries: [10.3, 10.4, Number.NaN],
    lclSeries: [9.7, 9.6, 9.65],
    variationChart: { ucl: 0.37, lcl: 0, centerLine: 0.11, sigma: 0.08, chartValues: longSeries },
  },
  ruleViolations: [
    violation(4, 1, { ruleSet: 'westernElectric', signalCount: 0 }),
    violation(4, 8, { ruleSet: 'westernElectric', signalCount: 1 }),
    violation(4, 9, { ruleSet: 'westernElectric', signalCount: 2 }),
  ],
  variationRuleViolations: [violation(1, 12, { signalCount: 1 })],
  statistics: { mean: 10, standardDeviation: 0.1, min: 9.7, max: Number.NaN, count: 200 },
  capabilityStatus: {
    readiness: 'preliminary',
    indices: { cp: 1.6, cpl: 1.5, cpu: 1.7, cpk: 1.5, pp: 1.4, ppl: 1.3, ppu: 1.5, ppk: 1.3, cpm: Number.NaN },
    reasons: ['Capability is preliminary with fewer than 30 usable observations.'],
    sigmaEstimate: { within: 0.1, overall: 0.12, method: 'MR-bar/d2 (n=2)', observationCount: 200 },
  },
} as ProcessedData;

const snapshotInput = {
  rawData,
  selectedChartType: 'individual' as const,
  chartOptions,
  selectedColumns: ['A'],
  xAxisColumn: null,
  denominatorColumn: null,
  sampleSize: 5,
  language: 'en' as const,
  agentModeEnabled: true,
  selectedAiSheetIndex: null,
};

describe('aiTools', () => {
  it('builds a controls snapshot with current values and available options', () => {
    const snapshot = buildControlsSnapshot({
      rawData: {
        data: [{ A: 1, B: 2 }],
        headers: ['A', 'B'],
        fileName: 'sample.xlsx',
        fileType: 'xlsx',
        sheets: [
          { name: 'Sheet1', data: [{ A: 1, B: 2 }], headers: ['A', 'B'] },
        ],
        activeSheetIndex: 0,
      },
      selectedChartType: 'xBarR',
      chartOptions: {
        title: 'X-bar R',
        xAxisLabel: 'Date',
        yAxisLabel: 'Value',
        showControlLimits: true,
        showCenterLine: true,
        showRuleViolations: true,
        colorScheme: 'default',
        showSigma1: true,
        showSigma2: false,
        showSigma3: true,
      },
      selectedColumns: ['A', 'B'],
      xAxisColumn: null,
      denominatorColumn: 'B',
      sampleSize: 3,
      language: 'en',
      agentModeEnabled: true,
      selectedAiSheetIndex: 0,
    });

    expect(snapshot.current.chartType).toBe('xBarR');
    expect(snapshot.current.yColumns).toEqual(['A', 'B']);
    expect(snapshot.current.denominatorColumn).toBe('B');
    expect(snapshot.current.effectiveSampleSize).toBe(2);
    expect(snapshot.available.headers).toEqual(['A', 'B']);
    expect(snapshot.available.sampleSize.lockedToYColumns).toBe(true);
    expect(snapshot.assistant.tools).toEqual(['list-tools', 'read_controls', 'read_spc_diagnostics', 'update_controls']);
  });

  it('returns only the requested snapshot sections', () => {
    const snapshot = buildControlsSnapshot({
      rawData: null,
      selectedChartType: 'individual',
      chartOptions: {
        title: 'Chart',
        xAxisLabel: 'X',
        yAxisLabel: 'Y',
        showControlLimits: true,
        showCenterLine: true,
        showRuleViolations: true,
        colorScheme: 'default',
      },
      selectedColumns: [],
      xAxisColumn: null,
      sampleSize: 5,
      language: 'he',
      agentModeEnabled: true,
      selectedAiSheetIndex: null,
    });

    expect(selectControlsSnapshotSections(snapshot, ['assistant', 'current'])).toEqual({
      assistant: snapshot.assistant,
      current: snapshot.current,
    });
  });

  it('counts exact rule signals from signalCount instead of flagged points', () => {
    const summary = summarizeRuleViolations(processedData.ruleViolations);

    expect(summary.ruleSet).toBe('westernElectric');
    expect(summary.signalCount).toBe(3);
    expect(summary.flaggedPointCount).toBe(3);
    expect(summary.exactSignalCounts).toBe(true);
    expect(summary.rules[0]).toMatchObject({ ruleNumber: 4, signalCount: 3, pointCount: 3, signalIndices: [8, 9] });
  });

  it('falls back to distinct window endpoints, and marks point-only data as approximate', () => {
    const windows = summarizeRuleViolations([
      { ...violation(2, 0), signals: [{ windowStart: 0, windowEnd: 8, signalIndex: 8, participatingIndices: [] }] },
      { ...violation(2, 8), signalIndex: 8 },
      { ...violation(2, 9), signalIndex: 9 },
    ]);
    expect(windows.rules[0].signalCount).toBe(2);
    expect(windows.exactSignalCounts).toBe(true);

    const pointsOnly = summarizeRuleViolations([violation(1, 3), violation(1, 7)], 'nelson');
    expect(pointsOnly.exactSignalCounts).toBe(false);
    expect(pointsOnly.rules[0].signalCount).toBe(2);
  });

  it('profiles columns for gateway validation', () => {
    const [a, defects, offset, note] = buildColumnProfiles(rawData);

    expect(a).toMatchObject({ numeric: 200, integerLike: false, nonNegative: true });
    expect(defects).toMatchObject({ numeric: 200, integerLike: true, nonNegative: true, min: 0, max: 3 });
    expect(offset).toMatchObject({ integerLike: true, nonNegative: false, min: -1 });
    expect(note).toMatchObject({ numeric: 0, nonNumeric: 1, missing: 199, min: null });
  });

  it('builds a bounded agent request without large arrays and with read-only spec context', () => {
    const request = buildAgentTurnRequest(snapshotInput, [], {
      model: 'm',
      systemPrompt: 'system',
      datasetSummary: null,
      processedData,
    });
    const serialized = JSON.stringify(request);
    const processed = request.processed!;

    expect(serialized.length).toBeLessThan(8000);
    expect(processed.controlLimits).not.toHaveProperty('chartValues');
    expect(processed.controlLimits).not.toHaveProperty('capabilityValues');
    expect(processed.controlLimits).not.toHaveProperty('uclSeries');
    expect(processed.controlLimits?.variableLimits).toEqual({ ucl: { min: 10.3, max: 10.4 }, lcl: { min: 9.6, max: 9.7 } });
    expect(processed.controlLimits?.variationChart).toEqual({ centerLine: 0.11, ucl: 0.37, lcl: 0, sigma: 0.08 });
    expect(processed.variationRuleSummary?.signalCount).toBe(1);
    expect(processed.statistics.max).toBeNull();
    expect(processed.capabilityStatus?.indices.cpm).toBeNull();
    expect(processed.specLimits).toEqual({ lowerSpecLimit: 9.5, upperSpecLimit: 10.5, targetValue: null });
    expect(request.controls).toMatchObject({ ruleSet: 'westernElectric', lowerSpecLimit: 9.5, targetValue: null });
    expect(request.dataset.previewRows).toHaveLength(5);
    expect(String(request.dataset.previewRows[0].Note).length).toBeLessThanOrEqual(81);
    expect(request.dataset.columnProfiles).toHaveLength(4);
  });

  it('labels the active rule set and signal counts in the dataset summary', () => {
    const summary = summarizeDatasetForAi(rawData, processedData, ['A'], null, null, 5)!;

    expect(summary).toContain('Rule signals (Western Electric rules (4)): 3 signal(s) involving 3 point(s) [rule 4 x3]');
    expect(summary).toContain('Variation chart (MR/R/S) limit signals: 1 signal(s)');
    expect(summary).toContain('within-process σ=0.100000 (MR-bar/d2 (n=2))');
    expect(summary).toContain('Cpm=n/a');
    expect(summary).not.toContain('Detected Western Electric rule signals');
  });

  it('keeps agent-mode markers and adds grounding rules to the system prompt', () => {
    const english = buildAssistantSystemPrompt('en', true);
    expect(english).toContain('Additional Agent Mode tool requirement');
    expect(english).toContain('Never calculate statistics yourself');
    expect(english).toContain('```html');
    expect(buildAssistantSystemPrompt('he', true)).toContain('במצב Agent');
  });
});


it('advertises chart-specific sample bounds without changing the current value', () => {
  const np = buildControlsSnapshot({ ...snapshotInput, selectedChartType: 'npChart', sampleSize: 500 });
  expect(np.available.sampleSize).toMatchObject({ min: 1, max: Number.MAX_SAFE_INTEGER, current: 500, effective: 500 });
  const u = buildControlsSnapshot({ ...snapshotInput, selectedChartType: 'uChart', sampleSize: 0.5 });
  expect(u.available.sampleSize).toMatchObject({ min: 0, exclusiveMin: true, integer: false, current: 0.5 });
});


it('profiles later measurements and every available header without treating samples as complete', () => {
  const data = [...Array.from({ length: 5000 }, () => ({ Late: '', Last: 'text' })), { Late: '3.5', Last: 'text' }];
  const headers = [...Array.from({ length: 65 }, (_, i) => 'C' + i), 'Late', 'Last'];
  const profiles = buildColumnProfiles({ data, headers, fileName: 'wide.csv', fileType: 'csv' });
  expect(profiles.find(profile => profile.name === 'Late')).toMatchObject({ numeric: 1, missing: 5000, sampled: false, min: 3.5 });
  expect(profiles.find(profile => profile.name === 'Last')).toMatchObject({ numeric: 0, nonNumeric: 5001, sampled: false });
});


it('validates candidate columns against the rows and columns actually selected for analysis', () => {
  const request = buildAgentTurnRequest({ ...snapshotInput, rawData: { data: [{ A: -1, B: 'bad' }, { A: 2, B: 3 }], headers: ['A', 'B'], fileName: 'scoped.csv', fileType: 'csv' }, selectedDataRange: { startRow: 1, endRow: 1, startCol: 0, endCol: 0 } }, [], { model: 'm', systemPrompt: 's', datasetSummary: null, processedData: null });
  expect(request.availableHeaders).toEqual(['A']);
  expect(request.dataset.rowCount).toBe(1);
  expect(request.dataset.columnProfiles).toEqual([expect.objectContaining({ name: 'A', min: 2, max: 2, nonNegative: true, sampled: false })]);
  expect(request.dataset.analysisScope).toMatchObject({ startRow: 1, endRow: 1, startCol: 0, endCol: 0 });
});

describe('subgroup evidence sent to the assistant', () => {
  it('does not present an unused stored size as a preferred subgroup size', () => {
    const summary = summarizeDatasetForAi(rawData, processedData, ['A'], null, null, 5, { chartType: 'individual' })!;
    expect(summary).not.toContain('Preferred subgroup/sample size');
    expect(summary).toContain('Stored sample-size setting: 5');
    expect(summary).toContain('one observation per row (n=1)');
    expect(summary).toContain('not evidence of rational subgrouping');
  });

  it('describes the effective multi-column layout rather than the stored size', () => {
    const summary = summarizeDatasetForAi(rawData, null, ['A', 'Offset'], null, null, 5, { chartType: 'xBarR' })!;
    expect(summary).toContain('Configured subgroup size: 2');
    expect(summary).toContain('one subgroup per row');
    expect(summary).toContain('Confirm rational subgrouping');
  });

  it('describes consecutive-row grouping as a configuration that requires confirmation', () => {
    const summary = summarizeDatasetForAi(rawData, null, ['A'], null, null, 5, { chartType: 'xBarR' })!;
    expect(summary).toContain('Configured subgroup size: 5');
    expect(summary).toContain('consecutive rows');
    expect(summary).toContain('Confirm rational subgrouping');
  });

  it('marks whether the current chart actually uses the stored size', () => {
    expect(buildControlsSnapshot(snapshotInput).available.sampleSize.usedByChart).toBe(false);
    expect(buildControlsSnapshot({ ...snapshotInput, selectedChartType: 'xBarR' }).available.sampleSize.usedByChart).toBe(true);
    expect(buildControlsSnapshot({ ...snapshotInput, selectedChartType: 'xBarR', selectedColumns: ['A', 'Offset'] }).available.sampleSize.usedByChart).toBe(false);
    expect(buildControlsSnapshot({ ...snapshotInput, selectedChartType: 'pChart', denominatorColumn: 'Defects' }).available.sampleSize.usedByChart).toBe(false);
  });
});
