import { sampleSizeRule } from '../../utils/sampleSize';
import type {
  AgentConfigChange,
  AgentConfigEvidence,
  AgentConfigField,
  AgentConfigOutcome,
  AgentConfigRejectReason,
  AgentConfigValue,
  AgentServerRejection,
  AiChatMessage,
} from '../../types/AiTypes';
import type { ChartOptions, ChartType, RuleSet } from '../../types/DataTypes';
import { AGENT_CHART_TYPES } from '../../utils/aiTools';

/**
 * Local source of truth for "what did the assistant actually change?".
 * Everything here is derived from the validated patch and the app's own state;
 * the model's prose and the gateway's `applied` / `skipped` lists are never read.
 */

export interface AgentConfigState {
  chartType: ChartType;
  yColumns: string[];
  xAxisColumn: string | null;
  denominatorColumn: string | null;
  /** Stored value; the visible value is `effectiveSampleSize`. */
  sampleSize: number;
  chartLabel: string;
  zAxisLabel: string;
  yAxisLabel: string;
  showControlLimits: boolean;
  showCenterLine: boolean;
  showRuleViolations: boolean;
  showSigma1: boolean;
  showSigma2: boolean;
  showSigma3: boolean;
  colorScheme: string;
  ruleSet: RuleSet;
}

export interface AgentConfigStateInput {
  chartType: ChartType;
  chartOptions: ChartOptions;
  selectedColumns: string[];
  xAxisColumn: string | null;
  denominatorColumn: string | null;
  sampleSize: number;
}

/** The store writes the panel has to perform; fields that would not change are absent. */
export interface AgentConfigUpdates {
  chartType?: ChartType;
  selectedColumns?: string[];
  xAxisColumn?: string | null;
  denominatorColumn?: string | null;
  sampleSize?: number;
  chartOptions?: Partial<
    Pick<
      ChartOptions,
      | 'title'
      | 'xAxisLabel'
      | 'yAxisLabel'
      | 'showControlLimits'
      | 'showCenterLine'
      | 'showRuleViolations'
      | 'showSigma1'
      | 'showSigma2'
      | 'showSigma3'
      | 'colorScheme'
      | 'ruleSet'
    >
  >;
}

export interface ResolveAgentPatchOptions {
  headers: readonly string[];
  now?: number;
  /** Controls as they were when the request was sent, to spot edits made while it ran. */
  requestSnapshot?: AgentConfigState;
  /** The dataset or worksheet changed after the request was sent. */
  staleDataset?: boolean;
}

export interface ResolvedAgentPatch {
  next: AgentConfigState;
  evidence: AgentConfigEvidence;
  updates: AgentConfigUpdates;
}

export const AGENT_CONFIG_FIELDS: readonly AgentConfigField[] = [
  'chartType',
  'yColumns',
  'xAxisColumn',
  'denominatorColumn',
  'sampleSize',
  'chartLabel',
  'zAxisLabel',
  'yAxisLabel',
  'showControlLimits',
  'showCenterLine',
  'showRuleViolations',
  'showSigma1',
  'showSigma2',
  'showSigma3',
  'colorScheme',
  'ruleSet',
];

export { sampleSizeRule, SAMPLE_SIZE_MIN, SAMPLE_SIZE_MAX } from '../../utils/sampleSize';

const MAX_TEXT_LENGTH = 300;
const MAX_LIST_ITEMS = 50;
const RULE_SETS: readonly RuleSet[] = ['nelson', 'westernElectric'];

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isString = (value: unknown): value is string => typeof value === 'string';
const isMissing = (value: unknown): value is null | undefined => value === null || value === undefined;

const clip = (text: string): string => (
  text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text
);

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Keeps `false`, `0`, `''` and `null` exactly as received. */
const normalizeRequested = (value: unknown): AgentConfigValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST_ITEMS).map((item) => clip(isString(item) ? item : safeStringify(item)));
  }
  return clip(safeStringify(value));
};

export const isXBarChart = (chartType: ChartType): boolean => chartType === 'xBarS' || chartType === 'xBarR';

export const effectiveSampleSize = (state: Pick<AgentConfigState, 'chartType' | 'yColumns' | 'sampleSize'>): number => (
  isXBarChart(state.chartType) && state.yColumns.length > 1 ? state.yColumns.length : state.sampleSize
);

export const buildAgentConfigState = (input: AgentConfigStateInput): AgentConfigState => ({
  chartType: input.chartType,
  yColumns: [...input.selectedColumns],
  xAxisColumn: input.xAxisColumn,
  denominatorColumn: input.denominatorColumn ?? null,
  sampleSize: input.sampleSize,
  chartLabel: input.chartOptions.title,
  zAxisLabel: input.chartOptions.xAxisLabel,
  yAxisLabel: input.chartOptions.yAxisLabel,
  showControlLimits: input.chartOptions.showControlLimits,
  showCenterLine: input.chartOptions.showCenterLine,
  showRuleViolations: input.chartOptions.showRuleViolations,
  // Charts draw these only when truthy, so a missing flag is "off".
  showSigma1: input.chartOptions.showSigma1 ?? false,
  showSigma2: input.chartOptions.showSigma2 ?? false,
  showSigma3: input.chartOptions.showSigma3 ?? false,
  colorScheme: input.chartOptions.colorScheme,
  ruleSet: input.chartOptions.ruleSet ?? 'nelson',
});

export const agentConfigValue = (state: AgentConfigState, field: AgentConfigField): AgentConfigValue => {
  switch (field) {
    case 'yColumns':
      return [...state.yColumns];
    case 'sampleSize':
      return effectiveSampleSize(state);
    default:
      return state[field] as AgentConfigValue;
  }
};

export const agentConfigValuesEqual = (left: AgentConfigValue, right: AgentConfigValue): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => item === right[index])
    );
  }
  return left === right;
};

/**
 * Settings that changed between two snapshots, compared as the controls store them. The visible
 * sample size is derived (X-bar charts lock it to the Y column count), so the stored number is
 * compared: a derived move is not a hand edit of the sample size.
 */
export const editedAgentConfigFields = (before: AgentConfigState, after: AgentConfigState): AgentConfigField[] => {
  const stored = (state: AgentConfigState, field: AgentConfigField): AgentConfigValue => (
    field === 'sampleSize' ? state.sampleSize : agentConfigValue(state, field)
  );
  return AGENT_CONFIG_FIELDS.filter((field) => !agentConfigValuesEqual(stored(before, field), stored(after, field)));
};

/**
 * What the statistics are computed from. A proposal for any of these was written against the
 * assistant's view of all of them, so once one has moved the rest cannot be applied on their own.
 */
const ANALYTICAL_FIELDS: readonly AgentConfigField[] = ['chartType', 'yColumns', 'denominatorColumn', 'sampleSize'];

const MAX_SERVER_REJECTIONS = 12;
const MAX_SERVER_NAME = 40;
const MAX_SERVER_TEXT = 200;
const MAX_SERVER_VALUE_TEXT = 120;
const MAX_SERVER_VALUE_ITEMS = 10;
const SAFE_SERVER_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
/** Stack traces, file paths, URLs, markup and credential-looking text are not for the chat. */
const INTERNAL_TEXT = /traceback|exception|\bat\s+\S+:\d+|[A-Za-z]:\\|\/(?:usr|app|home|var|etc|opt)\/|https?:\/\/|<\/?[a-z][^>]*>|bearer\s|api[_-]?key|\bsk-[\w-]{8,}/i;

/** Plain, single-line, bounded text from the gateway; undefined when it is empty or looks internal. */
const sanitizeServerText = (value: unknown, max: number): string | undefined => {
  if (!isString(value)) return undefined;
  // A message spread over several lines is a trace or a dump, not an explanation.
  if ((value.match(/\n/g) ?? []).length > 2 || INTERNAL_TEXT.test(value)) return undefined;
  const cleaned = value.replace(CONTROL_AND_BIDI_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
};

const boundServerValue = (value: unknown): AgentConfigValue => {
  const normalized = normalizeRequested(value);
  if (typeof normalized === 'string') {
    return normalized.length > MAX_SERVER_VALUE_TEXT ? `${normalized.slice(0, MAX_SERVER_VALUE_TEXT)}…` : normalized;
  }
  if (Array.isArray(normalized)) {
    return normalized.slice(0, MAX_SERVER_VALUE_ITEMS).map((item) => (
      item.length > MAX_SERVER_VALUE_TEXT ? `${item.slice(0, MAX_SERVER_VALUE_TEXT)}…` : item
    ));
  }
  return normalized;
};

/**
 * Reads the gateway's `rejected` list. These are reasons only: a refused setting is displayed as
 * refused, and nothing in here can mark anything as applied.
 */
const readServerRejections = (raw: unknown, alreadyExplained: ReadonlySet<AgentConfigField>): AgentServerRejection[] => {
  if (!Array.isArray(raw)) return [];
  const found: AgentServerRejection[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (found.length >= MAX_SERVER_REJECTIONS) break;
    if (!isRecord(entry)) continue;
    const rawName = isString(entry.field) ? entry.field.trim() : '';
    const message = sanitizeServerText(entry.reason, MAX_SERVER_TEXT);
    if (!rawName && !message) continue;
    const field = AGENT_CONFIG_FIELDS.find((candidate) => candidate === rawName);
    // The app already says why it refused this one itself.
    if (field && alreadyExplained.has(field)) continue;
    const name = field ?? (rawName.length <= MAX_SERVER_NAME && SAFE_SERVER_NAME.test(rawName) ? rawName : '');
    const key = name || `?${message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      ...(field ? { field } : {}),
      name,
      ...(hasOwn(entry, 'value') ? { requested: boundServerValue(entry.value) } : {}),
      ...(message ? { message } : {}),
    });
  }
  return found;
};

const summarizeOutcome = (
  counts: AgentConfigEvidence['counts'],
  localChanges: number,
  stale: boolean,
): AgentConfigOutcome => {
  if (stale && localChanges > 0) return 'stale';
  if (counts.applied + counts.unchanged + counts.rejected === 0) return 'none';
  if (counts.applied > 0) return counts.rejected > 0 ? 'partial' : 'applied';
  return counts.rejected > 0 ? 'rejected' : 'unchanged';
};

export const resolveAgentControlPatch = (
  patch: Record<string, unknown> | null | undefined,
  current: AgentConfigState,
  options: ResolveAgentPatchOptions,
): ResolvedAgentPatch => {
  const now = options.now ?? Date.now();
  const next: AgentConfigState = { ...current, yColumns: [...current.yColumns] };
  const updates: AgentConfigUpdates = {};
  const changes: AgentConfigChange[] = [];

  const finish = (): ResolvedAgentPatch => {
    const counts = { applied: 0, unchanged: 0, rejected: 0 };
    for (const change of changes) counts[change.status] += 1;
    const explained = new Set(changes.filter((change) => change.status === 'rejected').map((change) => change.field));
    const serverRejections = isRecord(patch) ? readServerRejections(patch.rejected, explained) : [];
    counts.rejected += serverRejections.length;
    const agentReason = isRecord(patch) && isString(patch.reason) && patch.reason.trim()
      ? clip(patch.reason.trim())
      : undefined;
    return {
      next,
      updates,
      evidence: {
        version: 1,
        appliedAt: now,
        outcome: summarizeOutcome(counts, changes.length, options.staleDataset === true),
        changes,
        counts,
        ...(serverRejections.length ? { serverRejections } : {}),
        ...(agentReason ? { agentReason } : {}),
      },
    };
  };

  if (!isRecord(patch)) {
    return finish();
  }

  const headers = new Set(options.headers);
  const edited = new Set(options.requestSnapshot ? editedAgentConfigFields(options.requestSnapshot, current) : []);
  const editedAnalytical = ANALYTICAL_FIELDS.filter((field) => edited.has(field));

  const conflictFor = (field: AgentConfigField): { reason: AgentConfigRejectReason; detail?: string[] } | null => {
    if (edited.has(field)) return { reason: 'editedDuringRequest' };
    if (editedAnalytical.length > 0 && ANALYTICAL_FIELDS.includes(field)) {
      return { reason: 'dependsOnEditedSetting', detail: [...editedAnalytical] };
    }
    return null;
  };

  const reject = (
    field: AgentConfigField,
    reason: AgentConfigRejectReason,
    requested: unknown,
    detail?: string[],
  ) => {
    const before = agentConfigValue(current, field);
    changes.push({
      field,
      status: 'rejected',
      before,
      after: before,
      requested: normalizeRequested(requested),
      reason,
      ...(detail && detail.length ? { detail: detail.map(clip).slice(0, MAX_LIST_ITEMS) } : {}),
    });
  };

  /**
   * Records one setting's outcome and says whether the app should write it. A proposal that
   * differs from a value changed since the request was sent is rejected, never written over it;
   * one that matches what is already there is a harmless no-op.
   */
  const commit = (
    field: AgentConfigField,
    after: AgentConfigValue,
    extras: Partial<AgentConfigChange> = {},
  ): AgentConfigChange['status'] => {
    const before = agentConfigValue(current, field);
    if (agentConfigValuesEqual(before, after)) {
      changes.push({ field, status: 'unchanged', before, after, ...extras });
      return 'unchanged';
    }
    const conflict = conflictFor(field);
    if (conflict) {
      reject(field, conflict.reason, extras.requested ?? after, conflict.detail);
      return 'rejected';
    }
    changes.push({ field, status: 'applied', before, after, ...extras });
    return 'applied';
  };

  // A stale dataset means column names may now point at different data: touch nothing.
  if (options.staleDataset) {
    for (const field of AGENT_CONFIG_FIELDS) {
      if (hasOwn(patch, field) && !(isMissing(patch[field]) && field !== 'xAxisColumn' && field !== 'denominatorColumn')) {
        reject(field, 'staleDataset', patch[field]);
      }
    }
    return finish();
  }

  const requestedChartType = patch.chartType;
  const requestedColumns = patch.yColumns;
  let chartOrColumnsTouched = false;

  if (!isMissing(requestedChartType)) {
    chartOrColumnsTouched = true;
    if (!isString(requestedChartType)) {
      reject('chartType', 'invalidValue', requestedChartType);
    } else if (!AGENT_CHART_TYPES.includes(requestedChartType as ChartType)) {
      reject('chartType', 'unknownChartType', requestedChartType);
    } else if (commit('chartType', requestedChartType) === 'applied') {
      next.chartType = requestedChartType as ChartType;
      updates.chartType = next.chartType;
    }
  }

  if (Array.isArray(requestedColumns)) {
    chartOrColumnsTouched = true;
    const named = Array.from(new Set(requestedColumns.filter(isString)));
    const valid = named.filter((name) => headers.has(name));
    // Request order, so the evidence reads the way the assistant wrote it.
    const ignored = Array.from(new Set(
      requestedColumns
        .filter((item) => !isString(item) || !headers.has(item))
        .map((item) => (isString(item) ? item : safeStringify(item))),
    ));
    if (valid.length > 0 || requestedColumns.length === 0) {
      const status = commit(
        'yColumns',
        valid,
        ignored.length > 0
          ? { requested: normalizeRequested(requestedColumns), note: 'ignoredColumns', detail: ignored.map(clip).slice(0, MAX_LIST_ITEMS) }
          : {},
      );
      if (status === 'applied') {
        next.yColumns = valid;
        updates.selectedColumns = valid;
      }
    } else {
      reject('yColumns', 'noValidColumns', requestedColumns, ignored);
    }
  } else if (!isMissing(requestedColumns)) {
    reject('yColumns', 'invalidValue', requestedColumns);
  }

  const applyColumn = (
    field: 'xAxisColumn' | 'denominatorColumn',
    value: unknown,
  ) => {
    // Explicit null clears the column: it means "row index" / "fixed sample size".
    if (isMissing(value)) {
      if (commit(field, null) === 'applied') {
        next[field] = null;
        updates[field] = null;
      }
    } else if (!isString(value)) {
      reject(field, 'invalidValue', value);
    } else if (!headers.has(value)) {
      reject(field, 'unknownColumn', value, [value]);
    } else if (commit(field, value) === 'applied') {
      next[field] = value;
      updates[field] = value;
    }
  };

  if (hasOwn(patch, 'xAxisColumn')) applyColumn('xAxisColumn', patch.xAxisColumn);
  if (hasOwn(patch, 'denominatorColumn')) applyColumn('denominatorColumn', patch.denominatorColumn);

  // Sample size is resolved last: it depends on the chart type and Y columns after the patch.
  const requestedSample = patch.sampleSize;
  const locked = isXBarChart(next.chartType) && next.yColumns.length > 1;
  if (!isMissing(requestedSample)) {
    const rule = sampleSizeRule(next.chartType);
    if (typeof requestedSample !== 'number' || !Number.isFinite(requestedSample)) {
      reject('sampleSize', 'invalidValue', requestedSample);
    } else if (!locked && rule.kind === 'positiveReal' && requestedSample <= 0) {
      reject('sampleSize', 'invalidValue', requestedSample);
    } else {
      let target: number;
      let note: 'clamped' | 'lockedToYColumns' | undefined;
      if (locked) {
        target = next.yColumns.length;
        note = 'lockedToYColumns';
      } else if (rule.kind === 'positiveReal') {
        target = requestedSample;
      } else {
        target = Math.max(rule.min, Math.min(rule.max, Math.round(requestedSample)));
        if (target !== requestedSample) note = 'clamped';
      }
      const status = commit('sampleSize', effectiveSampleSize({ ...next, sampleSize: target }), {
        ...(target !== requestedSample ? { requested: requestedSample } : {}),
        ...(note ? { note } : {}),
      });
      // Locked and the visible value does not move: leave the hidden stored value alone.
      if (status !== 'rejected' && target !== current.sampleSize && (!locked || status === 'applied')) {
        next.sampleSize = target;
        updates.sampleSize = target;
      }
    }
  } else if (chartOrColumnsTouched && locked && next.yColumns.length !== effectiveSampleSize(current)) {
    // X-bar charts built from several Y columns take their subgroup size from the column count.
    const status = commit('sampleSize', next.yColumns.length, { note: 'lockedToYColumns' });
    if (status !== 'rejected' && next.yColumns.length !== current.sampleSize) {
      next.sampleSize = next.yColumns.length;
      updates.sampleSize = next.sampleSize;
    }
  }

  const chartOptionUpdates: NonNullable<AgentConfigUpdates['chartOptions']> = {};

  const applyText = (field: 'chartLabel' | 'zAxisLabel' | 'yAxisLabel', option: 'title' | 'xAxisLabel' | 'yAxisLabel') => {
    const value = patch[field];
    if (isMissing(value)) return;
    if (!isString(value)) {
      reject(field, 'invalidValue', value);
      return;
    }
    if (commit(field, value) === 'applied') {
      next[field] = value;
      chartOptionUpdates[option] = value;
    }
  };
  applyText('chartLabel', 'title');
  applyText('zAxisLabel', 'xAxisLabel');
  applyText('yAxisLabel', 'yAxisLabel');

  const applyFlag = (
    field: 'showControlLimits' | 'showCenterLine' | 'showRuleViolations' | 'showSigma1' | 'showSigma2' | 'showSigma3',
  ) => {
    const value = patch[field];
    if (isMissing(value)) return;
    if (typeof value !== 'boolean') {
      reject(field, 'invalidValue', value);
      return;
    }
    if (commit(field, value) === 'applied') {
      next[field] = value;
      chartOptionUpdates[field] = value;
    }
  };
  (['showControlLimits', 'showCenterLine', 'showRuleViolations', 'showSigma1', 'showSigma2', 'showSigma3'] as const).forEach(applyFlag);

  if (!isMissing(patch.colorScheme)) {
    if (!isString(patch.colorScheme)) {
      reject('colorScheme', 'invalidValue', patch.colorScheme);
    } else if (commit('colorScheme', patch.colorScheme) === 'applied') {
      next.colorScheme = patch.colorScheme;
      chartOptionUpdates.colorScheme = patch.colorScheme;
    }
  }

  if (!isMissing(patch.ruleSet)) {
    if (!isString(patch.ruleSet) || !RULE_SETS.includes(patch.ruleSet as RuleSet)) {
      reject('ruleSet', 'unknownRuleSet', patch.ruleSet);
    } else if (commit('ruleSet', patch.ruleSet) === 'applied') {
      next.ruleSet = patch.ruleSet as RuleSet;
      chartOptionUpdates.ruleSet = next.ruleSet;
    }
  }

  if (Object.keys(chartOptionUpdates).length > 0) updates.chartOptions = chartOptionUpdates;

  // Report in the app's own field order, not the order the model happened to emit.
  changes.sort((left, right) => AGENT_CONFIG_FIELDS.indexOf(left.field) - AGENT_CONFIG_FIELDS.indexOf(right.field));
  return finish();
};

export const hasAgentConfigUpdates = (updates: AgentConfigUpdates): boolean => Object.keys(updates).length > 0;

export interface AgentConfigCurrentness {
  /** Applied settings that no longer hold their patched value. */
  supersededFields: AgentConfigField[];
}

export const evaluateEvidenceCurrentness = (
  evidence: AgentConfigEvidence,
  current: AgentConfigState,
): AgentConfigCurrentness => ({
  supersededFields: evidence.changes
    .filter((change) => change.status === 'applied')
    .filter((change) => !agentConfigValuesEqual(change.after, agentConfigValue(current, change.field)))
    .map((change) => change.field),
});

const formatPlain = (value: AgentConfigValue): string => {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (value === null) return 'none';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  return String(value);
};

const MAX_TRAILER_CHARS = 420;

/**
 * Model-facing, English-only trailer for an earlier assistant turn. It tells the model what the app
 * verified and which of those settings have since moved, so stale prose is not mistaken for state.
 */
export const buildEvidenceTrailer = (evidence: AgentConfigEvidence, current: AgentConfigState): string => {
  const { supersededFields } = evaluateEvidenceCurrentness(evidence, current);
  const parts: string[] = [];
  if (evidence.outcome === 'stale') {
    parts.push('app did not apply this turn because the dataset changed while it was running');
  }
  const applied = evidence.changes.filter((change) => change.status === 'applied');
  if (applied.length) {
    parts.push(`applied ${applied.map((change) => `${change.field} ${formatPlain(change.before)} -> ${formatPlain(change.after)}`).join('; ')}`);
  }
  const rejected = evidence.changes.filter((change) => change.status === 'rejected' && change.reason !== 'staleDataset');
  const declined = evidence.serverRejections ?? [];
  if (rejected.length || declined.length) {
    parts.push(`rejected ${[
      ...rejected.map((change) => `${change.field}${change.reason ? ` (${change.reason})` : ''}`),
      ...declined.map((entry) => `${entry.field ?? (entry.name || 'unknown setting')} (declined by the service)`),
    ].join(', ')}`);
  }
  if (supersededFields.length) {
    parts.push(`since changed: ${supersededFields.join(', ')}; the current controls snapshot is authoritative`);
  }
  if (!parts.length) {
    parts.push('app applied no settings');
  }
  const text = `[App verification: ${parts.join('. ')}.]`;
  return text.length > MAX_TRAILER_CHARS ? `${text.slice(0, MAX_TRAILER_CHARS - 2)}…]` : text;
};

/**
 * Copies of the history for an outgoing request; displayed messages are never altered.
 * Only turns that carry local evidence are annotated.
 */
export const buildRequestHistory = (messages: AiChatMessage[], current: AgentConfigState): AiChatMessage[] => (
  messages.map((message) => (
    message.role === 'assistant' && message.configEvidence
      ? { ...message, content: `${message.content}\n\n${buildEvidenceTrailer(message.configEvidence, current)}` }
      : message
  ))
);

export const EVIDENCE_OUTCOME_KEYS: Record<AgentConfigOutcome, string> = {
  applied: 'ai.evidence.outcome.applied',
  partial: 'ai.evidence.outcome.partial',
  unchanged: 'ai.evidence.outcome.unchanged',
  rejected: 'ai.evidence.outcome.rejected',
  none: 'ai.evidence.outcome.none',
  stale: 'ai.evidence.outcome.stale',
};

/** Latest app state, read at apply time so a slow response never writes over newer edits. */
export interface AgentRequestContext {
  config: AgentConfigState;
  /** Identifies the dataset and worksheet the request was about. */
  fingerprint: string;
  /**
   * The worksheet's row array at request time. Names and sizes can match after an in-place edit or a
   * re-upload of the same file, so identity is what proves the data is still the same.
   */
  dataRef: object | null;
}
