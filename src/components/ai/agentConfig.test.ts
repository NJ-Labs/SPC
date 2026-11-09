import { describe, expect, it } from 'vitest';
import type { AiChatMessage } from '../../types/AiTypes';
import {
  buildAgentConfigState,
  buildEvidenceTrailer,
  buildRequestHistory,
  evaluateEvidenceCurrentness,
  resolveAgentControlPatch,
  sampleSizeRule,
  type AgentConfigState,
} from './agentConfig';
import { formatAgentConfigValue } from './agentConfigFormat';

const HEADERS = ['A', 'B', 'Date', 'Defects', 'Opportunities'];

const baseState = (overrides: Partial<AgentConfigState> = {}): AgentConfigState => ({
  ...buildAgentConfigState({
    chartType: 'individual',
    chartOptions: {
      title: 'SPC Analysis Chart',
      xAxisLabel: 'Sample',
      yAxisLabel: 'Value',
      showControlLimits: true,
      showCenterLine: true,
      showRuleViolations: true,
      colorScheme: 'default',
      showSigma1: true,
      showSigma2: true,
      showSigma3: true,
    },
    selectedColumns: ['A'],
    xAxisColumn: 'Date',
    denominatorColumn: null,
    sampleSize: 3,
  }),
  ...overrides,
});

const resolve = (patch: Record<string, unknown> | null, state = baseState(), extra = {}) => (
  resolveAgentControlPatch(patch, state, { headers: HEADERS, now: 1, ...extra })
);

const change = (result: ReturnType<typeof resolve>, field: string) => result.evidence.changes.find((entry) => entry.field === field);

describe('resolveAgentControlPatch: real before/after evidence', () => {
  it('derives before and after from the app state, not from the patch', () => {
    const result = resolve({ chartType: 'xBarR', yColumns: ['A', 'B'], chartLabel: 'XBar-R by Date', sampleSize: 4 });

    expect(change(result, 'chartType')).toMatchObject({ status: 'applied', before: 'individual', after: 'xBarR' });
    expect(change(result, 'yColumns')).toMatchObject({ status: 'applied', before: ['A'], after: ['A', 'B'] });
    expect(change(result, 'chartLabel')).toMatchObject({ status: 'applied', before: 'SPC Analysis Chart', after: 'XBar-R by Date' });
    // Two Y columns lock the X-bar subgroup size, so the model's 4 is not what ends up in the app.
    expect(change(result, 'sampleSize')).toMatchObject({ status: 'applied', before: 3, after: 2, requested: 4, note: 'lockedToYColumns' });
    expect(result.evidence.outcome).toBe('applied');
    expect(result.updates).toEqual({
      chartType: 'xBarR',
      selectedColumns: ['A', 'B'],
      sampleSize: 2,
      chartOptions: { title: 'XBar-R by Date' },
    });
    expect(result.next.chartType).toBe('xBarR');
  });

  it('preserves false, zero, empty string and null instead of treating them as "missing"', () => {
    const result = resolve(
      { showSigma1: false, showCenterLine: false, chartLabel: '', xAxisColumn: null, sampleSize: 0 },
    );
    expect(change(result, 'showSigma1')).toMatchObject({ status: 'applied', before: true, after: false });
    expect(change(result, 'showCenterLine')).toMatchObject({ status: 'applied', before: true, after: false });
    expect(change(result, 'chartLabel')).toMatchObject({ status: 'applied', before: 'SPC Analysis Chart', after: '' });
    expect(change(result, 'xAxisColumn')).toMatchObject({ status: 'applied', before: 'Date', after: null });
    // Zero is a request, not an absence: it is clamped and reported as such.
    expect(change(result, 'sampleSize')).toMatchObject({ status: 'applied', before: 3, after: 2, requested: 0, note: 'clamped' });
    expect(result.updates.chartOptions).toMatchObject({ showSigma1: false, showCenterLine: false, title: '' });
    expect(result.updates.xAxisColumn).toBeNull();
    expect('xAxisColumn' in result.updates).toBe(true);
  });

  it('detects no-ops and requests no store writes for them', () => {
    const result = resolve({
      chartType: 'individual',
      yColumns: ['A'],
      xAxisColumn: 'Date',
      denominatorColumn: null,
      showSigma1: true,
      chartLabel: 'SPC Analysis Chart',
      sampleSize: 3,
    });
    expect(result.evidence.changes.every((entry) => entry.status === 'unchanged')).toBe(true);
    expect(result.evidence.outcome).toBe('unchanged');
    expect(result.evidence.counts).toEqual({ applied: 0, unchanged: 7, rejected: 0 });
    expect(result.updates).toEqual({});
  });

  it('reports a patch with no recognised fields as nothing requested', () => {
    expect(resolve({}).evidence.outcome).toBe('none');
    expect(resolve(null).evidence.outcome).toBe('none');
    expect(resolve({ chartType: null, chartLabel: null, showSigma1: null }).evidence.changes).toEqual([]);
  });

  it('rejects invalid values with a reason and leaves the setting at its real value', () => {
    const result = resolve({
      chartType: 'pie',
      yColumns: ['Nope', 'Missing'],
      xAxisColumn: 'NoSuchColumn',
      denominatorColumn: 7,
      showSigma2: 'false',
      chartLabel: 12,
      ruleSet: 'six-sigma',
    });
    expect(change(result, 'chartType')).toMatchObject({ status: 'rejected', reason: 'unknownChartType', before: 'individual', after: 'individual', requested: 'pie' });
    expect(change(result, 'yColumns')).toMatchObject({ status: 'rejected', reason: 'noValidColumns', before: ['A'], after: ['A'], detail: ['Nope', 'Missing'] });
    expect(change(result, 'xAxisColumn')).toMatchObject({ status: 'rejected', reason: 'unknownColumn', after: 'Date' });
    expect(change(result, 'denominatorColumn')).toMatchObject({ status: 'rejected', reason: 'invalidValue' });
    expect(change(result, 'showSigma2')).toMatchObject({ status: 'rejected', reason: 'invalidValue', requested: 'false', after: true });
    expect(change(result, 'chartLabel')).toMatchObject({ status: 'rejected', reason: 'invalidValue' });
    expect(change(result, 'ruleSet')).toMatchObject({ status: 'rejected', reason: 'unknownRuleSet', after: 'nelson' });
    expect(result.evidence.outcome).toBe('rejected');
    expect(result.updates).toEqual({});
    expect(result.next).toEqual(baseState());
  });

  it('applies the valid part of a column list and names what it ignored', () => {
    const result = resolve({ yColumns: ['B', 'Ghost', 'B', 42] });
    expect(change(result, 'yColumns')).toMatchObject({
      status: 'applied',
      after: ['B'],
      note: 'ignoredColumns',
      detail: ['Ghost', '42'],
      requested: ['B', 'Ghost', 'B', '42'],
    });
    expect(result.updates.selectedColumns).toEqual(['B']);
  });

  it('allows an explicit empty column list but not a list of unknown names', () => {
    expect(change(resolve({ yColumns: [] }), 'yColumns')).toMatchObject({ status: 'applied', after: [] });
  });

  it('marks a mixed patch partial', () => {
    const result = resolve({ chartType: 'xBarS', showSigma3: false, colorScheme: 99 });
    expect(result.evidence.outcome).toBe('partial');
    expect(result.evidence.counts).toEqual({ applied: 2, unchanged: 0, rejected: 1 });
  });

  it('ignores the model\'s and gateway\'s own claims about what was applied', () => {
    const result = resolve({ chartType: 'pie', applied: ['chartType', 'yColumns'], skipped: [], reason: 'because' });
    expect(result.evidence.outcome).toBe('rejected');
    expect(change(result, 'yColumns')).toBeUndefined();
    expect(result.evidence.agentReason).toBe('because');
  });

  it('lists changes in the app\'s field order regardless of the patch\'s key order', () => {
    const result = resolve({ showSigma3: false, chartLabel: 'T', yColumns: ['B'], chartType: 'cChart' });
    expect(result.evidence.changes.map((entry) => entry.field)).toEqual(['chartType', 'yColumns', 'chartLabel', 'showSigma3']);
  });

  it('treats a missing sigma flag as off, matching what the charts draw', () => {
    const state = baseState();
    expect(buildAgentConfigState({
      chartType: 'individual',
      chartOptions: { title: 't', xAxisLabel: 'x', yAxisLabel: 'y', showControlLimits: true, showCenterLine: true, showRuleViolations: true, colorScheme: 'default' },
      selectedColumns: [],
      xAxisColumn: null,
      denominatorColumn: null,
      sampleSize: 5,
    })).toMatchObject({ showSigma1: false, showSigma2: false, showSigma3: false, ruleSet: 'nelson' });
    expect(state.showSigma1).toBe(true);
  });
});

describe('sample size rules by chart type', () => {
  it('keeps X-bar subgroups within 2..25', () => {
    const result = resolve({ chartType: 'xBarR', sampleSize: 99 });
    expect(change(result, 'sampleSize')).toMatchObject({ after: 25, requested: 99, note: 'clamped' });
    expect(result.updates.sampleSize).toBe(25);
  });

  it('lets P and NP charts take a fixed sample far above 25', () => {
    const p = resolve({ chartType: 'pChart', sampleSize: 500 });
    expect(change(p, 'sampleSize')).toMatchObject({ status: 'applied', after: 500 });
    expect(change(p, 'sampleSize')?.note).toBeUndefined();
    expect(p.updates.sampleSize).toBe(500);
    expect(sampleSizeRule('npChart')).toEqual({ kind: 'integerRange', min: 1, max: Number.MAX_SAFE_INTEGER });
    expect(change(resolve({ chartType: 'npChart', sampleSize: 0 }), 'sampleSize')).toMatchObject({ after: 1, note: 'clamped' });
  });

  it('treats U-chart opportunities as any positive real', () => {
    const accepted = resolve({ chartType: 'uChart', sampleSize: 12.5 });
    expect(change(accepted, 'sampleSize')).toMatchObject({ status: 'applied', after: 12.5 });
    expect(accepted.updates.sampleSize).toBe(12.5);
    expect(change(resolve({ chartType: 'uChart', sampleSize: 0 }), 'sampleSize')).toMatchObject({ status: 'rejected', reason: 'invalidValue' });
    expect(change(resolve({ chartType: 'uChart', sampleSize: -3 }), 'sampleSize')).toMatchObject({ status: 'rejected' });
  });

  it('does not rewrite a hidden stored size when a locked X-bar value does not move', () => {
    const state = baseState({ chartType: 'xBarR', yColumns: ['A', 'B'], sampleSize: 3 });
    const result = resolve({ sampleSize: 9 }, state);
    expect(change(result, 'sampleSize')).toMatchObject({ status: 'unchanged', before: 2, after: 2, requested: 9, note: 'lockedToYColumns' });
    expect(result.updates.sampleSize).toBeUndefined();
    expect(result.next.sampleSize).toBe(3);
  });
});

describe('staleness', () => {
  it('rejects every touched field and writes nothing when the dataset changed during the request', () => {
    const result = resolve(
      { chartType: 'xBarR', yColumns: ['A', 'B'], xAxisColumn: null, showSigma1: false },
      baseState(),
      { staleDataset: true },
    );
    expect(result.evidence.outcome).toBe('stale');
    expect(result.evidence.changes.every((entry) => entry.status === 'rejected' && entry.reason === 'staleDataset')).toBe(true);
    expect(result.evidence.changes.map((entry) => entry.field)).toEqual(['chartType', 'yColumns', 'xAxisColumn', 'showSigma1']);
    expect(result.updates).toEqual({});
    expect(result.next).toEqual(baseState());
  });

  it('keeps a setting the user edited while the request ran and rejects a differing proposal for it', () => {
    const atRequest = baseState();
    const now = baseState({ chartLabel: 'My own title', showSigma1: false });
    const result = resolve(
      { chartLabel: 'Assistant title', showSigma1: false, colorScheme: 'default', yAxisLabel: 'Assistant Y' },
      now,
      { requestSnapshot: atRequest },
    );
    expect(change(result, 'chartLabel')).toMatchObject({
      status: 'rejected',
      reason: 'editedDuringRequest',
      before: 'My own title',
      after: 'My own title',
      requested: 'Assistant title',
    });
    // Already what the user set (or never touched): nothing to override and nothing to warn about.
    expect(change(result, 'showSigma1')).toMatchObject({ status: 'unchanged' });
    expect(change(result, 'colorScheme')).toMatchObject({ status: 'unchanged' });
    expect(change(result, 'yAxisLabel')).toMatchObject({ status: 'applied', after: 'Assistant Y' });
    expect(result.evidence.outcome).toBe('partial');
    // The title is not written; the independent label still is.
    expect(result.updates).toEqual({ chartOptions: { yAxisLabel: 'Assistant Y' } });
    expect(result.next.chartLabel).toBe('My own title');
    expect(result.next.yAxisLabel).toBe('Assistant Y');
  });

  it('writes nothing when the only proposal is for a setting the user edited', () => {
    const result = resolve(
      { chartLabel: 'Assistant title' },
      baseState({ chartLabel: 'My own title' }),
      { requestSnapshot: baseState() },
    );
    expect(result.evidence.outcome).toBe('rejected');
    expect(result.updates).toEqual({});
    expect(result.next).toEqual(baseState({ chartLabel: 'My own title' }));
  });

  it('rejects a proposal that restores the old value the user moved away from', () => {
    const result = resolve(
      { chartLabel: 'SPC Analysis Chart' },
      baseState({ chartLabel: 'Mine' }),
      { requestSnapshot: baseState() },
    );
    expect(change(result, 'chartLabel')).toMatchObject({ status: 'rejected', reason: 'editedDuringRequest', after: 'Mine' });
    expect(result.updates).toEqual({});
  });

  it('treats a setting edited and then put back as untouched', () => {
    const result = resolve({ chartLabel: 'Assistant title' }, baseState(), { requestSnapshot: baseState() });
    expect(change(result, 'chartLabel')).toMatchObject({ status: 'applied' });
  });

  it('keeps a concurrent edit that already matches the proposal as a harmless no-op', () => {
    // The user made the same switch the assistant is proposing, by hand, while it ran.
    const now = baseState({ chartType: 'xBarR', yColumns: ['A', 'B'], chartLabel: 'Same title' });
    const result = resolve(
      { chartType: 'xBarR', yColumns: ['A', 'B'], chartLabel: 'Same title', sampleSize: 2 },
      now,
      { requestSnapshot: baseState() },
    );
    expect(result.evidence.changes.map((entry) => [entry.field, entry.status])).toEqual([
      ['chartType', 'unchanged'],
      ['yColumns', 'unchanged'],
      ['sampleSize', 'unchanged'],
      ['chartLabel', 'unchanged'],
    ]);
    expect(result.evidence.outcome).toBe('unchanged');
    expect(result.updates).toEqual({});
  });

  it('does not apply the rest of an analytical selection once the user changed part of it', () => {
    // The user switched to a P chart while the assistant was proposing an X-bar R setup.
    const result = resolve(
      { chartType: 'xBarR', yColumns: ['A', 'B'], sampleSize: 4, xAxisColumn: null, chartLabel: 'XBar-R' },
      baseState({ chartType: 'pChart' }),
      { requestSnapshot: baseState() },
    );
    expect(change(result, 'chartType')).toMatchObject({ status: 'rejected', reason: 'editedDuringRequest', after: 'pChart', requested: 'xBarR' });
    expect(change(result, 'yColumns')).toMatchObject({ status: 'rejected', reason: 'dependsOnEditedSetting', detail: ['chartType'], after: ['A'], requested: ['A', 'B'] });
    expect(change(result, 'sampleSize')).toMatchObject({ status: 'rejected', reason: 'dependsOnEditedSetting', detail: ['chartType'], after: 3, requested: 4 });
    // The X axis and the title do not feed the statistics, so they still apply.
    expect(change(result, 'xAxisColumn')).toMatchObject({ status: 'applied', after: null });
    expect(change(result, 'chartLabel')).toMatchObject({ status: 'applied' });
    expect(result.updates).toEqual({ xAxisColumn: null, chartOptions: { title: 'XBar-R' } });
    expect(result.next).toMatchObject({ chartType: 'pChart', yColumns: ['A'], sampleSize: 3 });
  });

  it('keeps the user\'s Y columns and does not auto-lock the subgroup size around them', () => {
    const result = resolve(
      { chartType: 'xBarS', yColumns: ['A', 'B'] },
      baseState({ yColumns: ['B'] }),
      { requestSnapshot: baseState() },
    );
    expect(change(result, 'yColumns')).toMatchObject({ status: 'rejected', reason: 'editedDuringRequest', after: ['B'] });
    expect(change(result, 'chartType')).toMatchObject({ status: 'rejected', reason: 'dependsOnEditedSetting', detail: ['yColumns'] });
    expect(change(result, 'sampleSize')).toBeUndefined();
    expect(result.updates).toEqual({});
  });

  it('keeps an edited sample size and the chart type that was proposed around the old one', () => {
    const result = resolve(
      { chartType: 'pChart', sampleSize: 25 },
      baseState({ sampleSize: 40 }),
      { requestSnapshot: baseState() },
    );
    expect(change(result, 'sampleSize')).toMatchObject({ status: 'rejected', reason: 'editedDuringRequest', before: 40, after: 40, requested: 25 });
    expect(change(result, 'chartType')).toMatchObject({ status: 'rejected', reason: 'dependsOnEditedSetting', detail: ['sampleSize'] });
    expect(result.updates).toEqual({});
  });

  it('calls a derived sample size dependent, not hand-edited', () => {
    // Leaving X-bar R un-locks the subgroup size without anyone touching the sample-size control.
    const atRequest = baseState({ chartType: 'xBarR', yColumns: ['A', 'B'], sampleSize: 3 });
    const now = baseState({ chartType: 'individual', yColumns: ['A', 'B'], sampleSize: 3 });
    const result = resolve({ sampleSize: 7 }, now, { requestSnapshot: atRequest });
    expect(change(result, 'sampleSize')).toMatchObject({ status: 'rejected', reason: 'dependsOnEditedSetting', detail: ['chartType'] });
    expect(result.updates).toEqual({});
  });

  it('never applies anything for a stale dataset even with edits and server rejections', () => {
    const result = resolve(
      { chartType: 'xBarR', chartLabel: 'X', rejected: [{ field: 'ruleSet', value: 'six', reason: 'Use nelson or westernElectric.' }] },
      baseState({ chartLabel: 'Mine' }),
      { staleDataset: true, requestSnapshot: baseState() },
    );
    expect(result.evidence.outcome).toBe('stale');
    expect(result.evidence.changes.every((entry) => entry.reason === 'staleDataset')).toBe(true);
    expect(result.updates).toEqual({});
    expect(result.evidence.serverRejections).toHaveLength(1);
    expect(result.evidence.counts.rejected).toBe(3);
  });

  it('notices when an applied value has since been changed, and feeds that back to the model', () => {
    const evidence = resolve({ chartType: 'xBarR', yColumns: ['A', 'B'], showSigma1: 5 }).evidence;
    expect(evaluateEvidenceCurrentness(evidence, baseState({ chartType: 'xBarR', yColumns: ['A', 'B'] })).supersededFields).toEqual([]);
    const later = baseState({ chartType: 'pChart', yColumns: ['A', 'B'] });
    // Leaving X-bar also un-locks the subgroup size, so that applied value has moved too.
    expect(evaluateEvidenceCurrentness(evidence, later).supersededFields).toEqual(['chartType', 'sampleSize']);

    const trailer = buildEvidenceTrailer(evidence, later);
    expect(trailer).toContain('[App verification:');
    expect(trailer).toContain('applied chartType individual -> xBarR');
    expect(trailer).toContain('rejected showSigma1 (invalidValue)');
    expect(trailer).toContain('since changed: chartType, sampleSize');
    expect(trailer.length).toBeLessThanOrEqual(420);
  });

  it('annotates a copy of the history for the request and never the displayed messages', () => {
    const evidence = resolve({ chartType: 'xBarR' }).evidence;
    const history: AiChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'Switched chart.', createdAt: 2, configEvidence: evidence },
      { id: 'a2', role: 'assistant', content: 'No evidence here.', createdAt: 3 },
    ];
    const request = buildRequestHistory(history, baseState());
    expect(request[1].content).toContain('Switched chart.');
    expect(request[1].content).toContain('[App verification:');
    expect(request[2]).toBe(history[2]);
    expect(history[1].content).toBe('Switched chart.');
  });
});

describe('gateway rejection metadata', () => {
  const rejection = (field: string, value: unknown, reason: string) => ({ field, value, reason });

  it('surfaces a patch that carries only rejections, without claiming anything applied', () => {
    const result = resolve({
      applied: [],
      skipped: ['chartType'],
      changes: [],
      reason: 'A pie chart would show the split.',
      rejected: [rejection('chartType', 'pie', 'Unknown chart type. Use one of: individual, xBarR.')],
    });
    expect(result.evidence.outcome).toBe('rejected');
    expect(result.evidence.counts).toEqual({ applied: 0, unchanged: 0, rejected: 1 });
    expect(result.evidence.changes).toEqual([]);
    expect(result.evidence.serverRejections).toEqual([
      { field: 'chartType', name: 'chartType', requested: 'pie', message: 'Unknown chart type. Use one of: individual, xBarR.' },
    ]);
    expect(result.evidence.agentReason).toBe('A pie chart would show the split.');
    expect(result.updates).toEqual({});
    expect(result.next).toEqual(baseState());
  });

  it('keeps real changes and refusals apart in a mixed patch', () => {
    const result = resolve({
      showSigma2: false,
      rejected: [rejection('chartType', 'pie', 'Unknown chart type.')],
    });
    expect(result.evidence.outcome).toBe('partial');
    expect(result.evidence.counts).toEqual({ applied: 1, unchanged: 0, rejected: 1 });
    expect(result.evidence.changes.map((entry) => [entry.field, entry.status])).toEqual([['showSigma2', 'applied']]);
    expect(result.evidence.serverRejections?.map((entry) => entry.field)).toEqual(['chartType']);
    expect(result.updates).toEqual({ chartOptions: { showSigma2: false } });
    expect(result.next.chartType).toBe('individual');
  });

  it('ignores applied, skipped and changes claims: only validated fields can ever apply', () => {
    const claims = {
      applied: ['chartType', 'yColumns'],
      skipped: [],
      changes: [{ field: 'chartType', from: 'individual', to: 'xBarR' }],
      rejected: [],
      unchanged: [],
    };
    const bare = resolve(claims);
    expect(bare.evidence.outcome).toBe('none');
    expect(bare.evidence.changes).toEqual([]);
    expect(bare.evidence.serverRejections).toBeUndefined();
    expect(bare.updates).toEqual({});

    // Claiming a field applied does not stop the server's refusal of it from being shown as one.
    const contradicted = resolve({ ...claims, rejected: [rejection('chartType', 'xBarR', 'No.')] });
    expect(contradicted.evidence.changes).toEqual([]);
    expect(contradicted.evidence.outcome).toBe('rejected');
    expect(contradicted.updates).toEqual({});
  });

  it('does not repeat a refusal the app already explained itself', () => {
    const result = resolve({ chartType: 'pie', rejected: [rejection('chartType', 'pie', 'Unknown chart type.')] });
    expect(change(result, 'chartType')).toMatchObject({ status: 'rejected', reason: 'unknownChartType' });
    expect(result.evidence.serverRejections).toBeUndefined();
    expect(result.evidence.counts).toEqual({ applied: 0, unchanged: 0, rejected: 1 });
  });

  it('shows a later refusal next to an earlier value that did apply', () => {
    // The gateway keeps the first accepted title in the patch and reports a second, refused one.
    const result = resolve({ chartLabel: 'First title', rejected: [rejection('chartLabel', 12, 'Expected text.')] });
    expect(change(result, 'chartLabel')).toMatchObject({ status: 'applied', after: 'First title' });
    expect(result.evidence.serverRejections).toEqual([
      { field: 'chartLabel', name: 'chartLabel', requested: 12, message: 'Expected text.' },
    ]);
    expect(result.evidence.outcome).toBe('partial');
  });

  it('shows unknown settings generically and keeps the message that explains them', () => {
    const result = resolve({
      rejected: [rejection('lowerSpecLimit', 5, 'Specification limits come from requirements; ask the user to enter them in the app.')],
    });
    expect(result.evidence.serverRejections).toEqual([
      { name: 'lowerSpecLimit', requested: 5, message: 'Specification limits come from requirements; ask the user to enter them in the app.' },
    ]);
    expect(result.evidence.serverRejections?.[0].field).toBeUndefined();
    expect(result.evidence.outcome).toBe('rejected');
  });

  it('drops unsafe names and internal-looking messages instead of showing them', () => {
    const result = resolve({
      rejected: [
        rejection('x'.repeat(200), 'y'.repeat(500), 'Traceback (most recent call last):\n  File "/app/main.py", line 10\nValueError'),
        rejection('<script>alert(1)</script>', { deep: { a: 1 } }, 'See https://internal.example/debug?token=abc'),
        rejection('chartType', 'pie', `${'Long explanation. '.repeat(40)}`),
        rejection('showSigma1', 'yes', 'Use true‮ or\u0007 false.'),
        'not an object',
        null,
        {},
        { field: 5 },
      ],
    });
    const shown = result.evidence.serverRejections ?? [];
    // The two nameless, message-less entries collapse into one generic row.
    expect(shown.map((entry) => entry.field ?? entry.name)).toEqual(['', 'chartType', 'showSigma1']);
    expect(shown[0].message).toBeUndefined();
    expect((shown[0].requested as string).length).toBeLessThanOrEqual(121);
    expect(shown[1].message?.length).toBeLessThanOrEqual(201);
    expect(shown[2].message).toBe('Use true or false.');
    expect(result.evidence.counts.rejected).toBe(3);
    const serialized = JSON.stringify(result.evidence);
    for (const junk of ['Traceback', 'main.py', 'internal.example', '<script>', '‮']) {
      expect(serialized).not.toContain(junk);
    }
  });

  it('bounds how many refusals are kept', () => {
    const many = Array.from({ length: 30 }, (_, index) => rejection(`setting${index}`, index, 'No.'));
    const result = resolve({ rejected: many });
    expect(result.evidence.serverRejections).toHaveLength(12);
    expect(result.evidence.counts.rejected).toBe(12);
  });

  it('ignores a rejected field that is not a list', () => {
    expect(resolve({ rejected: 'chartType' }).evidence.outcome).toBe('none');
    expect(resolve({ rejected: { field: 'chartType' } }).evidence.outcome).toBe('none');
  });

  it('feeds refusals back to the model without implying they applied', () => {
    const result = resolve({ rejected: [rejection('chartType', 'pie', 'Unknown chart type.'), rejection('foo', 1, 'No.')] });
    const trailer = buildEvidenceTrailer(result.evidence, baseState());
    expect(trailer).toContain('rejected chartType (declined by the service), foo (declined by the service)');
    expect(trailer).not.toContain('applied');
  });
});

describe('formatAgentConfigValue', () => {
  const t = (key: string) => key;
  it('formats a value for a setting the app does not know', () => {
    expect(formatAgentConfigValue(undefined, false, t)).toBe('ai.value.off');
    expect(formatAgentConfigValue(undefined, null, t)).toBe('ai.value.none');
    expect(formatAgentConfigValue(undefined, 'abc', t)).toBe('abc');
  });
  it('gives every falsy value explicit text', () => {
    expect(formatAgentConfigValue('showSigma1', false, t)).toBe('ai.value.off');
    expect(formatAgentConfigValue('sampleSize', 0, t)).toBe('0');
    expect(formatAgentConfigValue('chartLabel', '', t)).toBe('ai.value.empty');
    expect(formatAgentConfigValue('xAxisColumn', null, t)).toBe('ai.value.rowIndex');
    expect(formatAgentConfigValue('denominatorColumn', null, t)).toBe('ai.value.fixedSample');
    expect(formatAgentConfigValue('yColumns', [], t)).toBe('ai.value.noColumns');
    expect(formatAgentConfigValue('ruleSet', 'westernElectric', t)).toBe('rules.set.westernElectric');
    expect(formatAgentConfigValue('chartType', 'xBarR', t)).toMatch(/X-bar/i);
  });
});
