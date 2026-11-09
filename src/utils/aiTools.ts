import { sampleSizeBounds } from './sampleSize';
import type { Language } from '../context/LanguageContext';
import type { AiChatMessage } from '../types/AiTypes';
import type {
  CapabilityStatus,
  ChartOptions,
  ChartType,
  ControlLimits,
  DataSet,
  DataSelectionRange,
  ProcessedData,
  RuleSet,
  RuleViolation,
} from '../types/DataTypes';

export const LIST_TOOLS_TOOL_NAME = 'list-tools';
export const READ_CONTROLS_TOOL_NAME = 'read_controls';
export const READ_SPC_DIAGNOSTICS_TOOL_NAME = 'read_spc_diagnostics';
export const UPDATE_CONTROLS_TOOL_NAME = 'update_controls';

export const AGENT_CHART_TYPES: ChartType[] = [
  'individual',
  'pChart',
  'npChart',
  'cChart',
  'uChart',
  'xBarS',
  'xBarR',
  'ewma',
  'histogram',
  'scatterPlot',
];

export const AGENT_RULE_SETS: RuleSet[] = ['nelson', 'westernElectric'];

// Payload bounds: the gateway forwards this context to small LLMs on every turn.
const MAX_PREVIEW_ROWS = 5;
const MAX_PREVIEW_COLUMNS = 40;
const MAX_PREVIEW_VALUE_LENGTH = 80;
const MAX_SIGNAL_INDICES = 12;
const MAX_DIAGNOSTICS = 12;
const MAX_RECOMMENDATIONS = 5;

export interface AgentControlsSnapshotInput {
  rawData: DataSet | null;
  selectedChartType: ChartType;
  chartOptions: ChartOptions;
  selectedColumns: string[];
  xAxisColumn: string | null;
  denominatorColumn?: string | null;
  sampleSize: number;
  language: Language;
  agentModeEnabled: boolean;
  selectedAiSheetIndex: number | null;
  selectedDataRange?: DataSelectionRange | null;
}

export interface UpdateControlsToolArgs {
  chartType?: ChartType | null;
  yColumns?: string[];
  xAxisColumn?: string | null;
  denominatorColumn?: string | null;
  sampleSize?: number | null;
  chartLabel?: string | null;
  zAxisLabel?: string | null;
  yAxisLabel?: string | null;
  showControlLimits?: boolean;
  showCenterLine?: boolean;
  showRuleViolations?: boolean;
  showSigma1?: boolean;
  showSigma2?: boolean;
  showSigma3?: boolean;
  colorScheme?: string | null;
  ruleSet?: RuleSet | null;
  reason?: string | null;
}

/** Server-side record of one validated change, relative to the controls sent with the request. */
export interface AgentPatchChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AgentPatchRejection {
  field: string;
  value: unknown;
  reason: string;
}

export interface AgentControlPatch extends UpdateControlsToolArgs {
  chartType?: ChartType | null;
  applied?: string[];
  skipped?: string[];
  changes?: AgentPatchChange[];
  rejected?: AgentPatchRejection[];
  unchanged?: string[];
  warnings?: string[];
}

export interface AgentTurnResponse {
  content: string;
  reasoning?: string | null;
  controlPatch?: AgentControlPatch | null;
  toolTrace?: Array<Record<string, unknown>>;
  knowledgeSources?: string[];
  needsClarification?: boolean;
  model?: string;
  usage?: Record<string, number> | null;
  /** 'fallback' means the model failed and the content is deterministic. */
  status?: 'ok' | 'fallback' | 'clarification';
  intent?: string[];
  warnings?: string[];
  /** App-computed evidence echoed back when the user asked for numbers. */
  evidence?: Record<string, unknown> | null;
  grounding?: { checked: boolean; ungroundedNumbers: string[] } | null;
  stopReason?: string | null;
}

export interface RuleSignalSummary {
  ruleNumber: number;
  description: string;
  /** Number of distinct pattern windows that fired, not the number of flagged points. */
  signalCount: number;
  pointCount: number;
  firstIndex: number;
  lastIndex: number;
  /** Zero-based endpoints of the first signals, for display. */
  signalIndices: number[];
}

export interface RuleViolationSummary {
  ruleSet: RuleSet;
  signalCount: number;
  flaggedPointCount: number;
  /** False when the engine provided neither signalCount nor signal endpoints. */
  exactSignalCounts: boolean;
  rules: RuleSignalSummary[];
}

type RuleViolationRecord = RuleViolation & {
  ruleSet?: RuleSet;
  signalIndex?: number;
  signalCount?: number;
  signals?: Array<{ signalIndex?: number }>;
};


const finiteOrNull = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

export const scopeDatasetForAi = (rawData: DataSet | null, range?: DataSelectionRange | null): DataSet | null => {
  if (!rawData || !range) return rawData;
  const startRow = Math.max(0, Math.min(range.startRow, range.endRow));
  const endRow = Math.min(rawData.data.length - 1, Math.max(range.startRow, range.endRow));
  const startCol = Math.max(0, Math.min(range.startCol, range.endCol));
  const endCol = Math.min(rawData.headers.length - 1, Math.max(range.startCol, range.endCol));
  return { ...rawData, data: rawData.data.slice(startRow, endRow + 1), headers: rawData.headers.slice(startCol, endCol + 1) };
};

export const buildControlsSnapshot = (input: AgentControlsSnapshotInput) => {
  const { rawData, selectedChartType, chartOptions, selectedColumns, xAxisColumn, denominatorColumn, sampleSize, language, agentModeEnabled, selectedAiSheetIndex } = input;
  const activeSheetIndex = selectedAiSheetIndex ?? rawData?.activeSheetIndex ?? 0;
  const activeSheet = rawData?.sheets?.[activeSheetIndex] ?? null;
  const effectiveSampleSize = (selectedChartType === 'xBarS' || selectedChartType === 'xBarR') && selectedColumns.length > 1
    ? selectedColumns.length
    : sampleSize;

  return {
    current: {
      chartType: selectedChartType,
      yColumns: selectedColumns,
      xAxisColumn,
      denominatorColumn: denominatorColumn ?? null,
      sampleSize,
      effectiveSampleSize,
      chartLabel: chartOptions.title,
      zAxisLabel: chartOptions.xAxisLabel,
      yAxisLabel: chartOptions.yAxisLabel,
      showControlLimits: chartOptions.showControlLimits,
      showCenterLine: chartOptions.showCenterLine,
      showRuleViolations: chartOptions.showRuleViolations,
      showSigma1: chartOptions.showSigma1 ?? false,
      showSigma2: chartOptions.showSigma2 ?? false,
      showSigma3: chartOptions.showSigma3 ?? false,
      colorScheme: chartOptions.colorScheme,
      ruleSet: chartOptions.ruleSet ?? 'nelson',
      // Read-only for the agent: specification limits come from the user.
      lowerSpecLimit: finiteOrNull(chartOptions.lowerSpecLimit),
      upperSpecLimit: finiteOrNull(chartOptions.upperSpecLimit),
      targetValue: finiteOrNull(chartOptions.targetValue),
    },
    available: {
      chartTypes: AGENT_CHART_TYPES,
      ruleSets: AGENT_RULE_SETS,
      headers: scopeDatasetForAi(rawData, input.selectedDataRange)?.headers ?? [],
      sampleSize: {
        ...sampleSizeBounds(selectedChartType),
        current: sampleSize,
        effective: effectiveSampleSize,
        lockedToYColumns: selectedColumns.length > 1 && (selectedChartType === 'xBarS' || selectedChartType === 'xBarR'),
        usedByChart: ((selectedChartType === 'xBarS' || selectedChartType === 'xBarR') && selectedColumns.length <= 1) || selectedChartType === 'npChart'
          || ((selectedChartType === 'pChart' || selectedChartType === 'uChart') && !denominatorColumn),
      },
      editableFields: [
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
      ],
    },
    worksheet: {
      activeSheetIndex,
      activeSheetName: activeSheet?.name ?? null,
      worksheetCount: rawData?.sheets?.length ?? (rawData ? 1 : 0),
      worksheets: rawData?.sheets?.map((sheet, index) => ({
        index,
        name: sheet.name,
        rows: sheet.data.length,
        columns: sheet.headers.length,
      })) ?? [],
    },
    assistant: {
      language,
      agentModeEnabled,
      tools: [LIST_TOOLS_TOOL_NAME, READ_CONTROLS_TOOL_NAME, READ_SPC_DIAGNOSTICS_TOOL_NAME, UPDATE_CONTROLS_TOOL_NAME],
    },
  };
};

export const selectControlsSnapshotSections = (
  snapshot: ReturnType<typeof buildControlsSnapshot>,
  include?: string[],
) => {
  if (!include || include.length === 0) {
    return snapshot;
  }

  const selectedEntries = include
    .filter((key): key is keyof typeof snapshot => key in snapshot)
    .map((key) => [key, snapshot[key]]);

  return Object.fromEntries(selectedEntries);
};

/**
 * Per-rule signal summary. When the engine reports `signalCount` per record, the sum is exact;
 * otherwise distinct window endpoints (`signals[].signalIndex`, `signalIndex`) are counted.
 */
export const summarizeRuleViolations = (
  violations: readonly RuleViolation[] | null | undefined,
  fallbackRuleSet: RuleSet = 'nelson',
): RuleViolationSummary => {
  const records = (violations ?? []) as readonly RuleViolationRecord[];
  const byRule = new Map<number, {
    description: string;
    points: Set<number>;
    endpoints: Set<number>;
    countedSignals: number;
    hasSignalCount: boolean;
    hasEndpoints: boolean;
  }>();
  const flagged = new Set<number>();
  let ruleSet: RuleSet = fallbackRuleSet;

  for (const record of records) {
    if (!isInteger(record.ruleNumber) || !isInteger(record.index)) continue;
    if (record.ruleSet === 'nelson' || record.ruleSet === 'westernElectric') ruleSet = record.ruleSet;
    flagged.add(record.index);
    let entry = byRule.get(record.ruleNumber);
    if (!entry) {
      entry = { description: record.description ?? '', points: new Set(), endpoints: new Set(), countedSignals: 0, hasSignalCount: false, hasEndpoints: false };
      byRule.set(record.ruleNumber, entry);
    }
    entry.points.add(record.index);
    if (isInteger(record.signalCount)) {
      entry.hasSignalCount = true;
      entry.countedSignals += Math.max(0, record.signalCount);
      if (record.signalCount > 0) entry.endpoints.add(record.index);
      continue;
    }
    const windowEnds = (record.signals ?? []).map((signal) => signal.signalIndex).filter(isInteger);
    if (isInteger(record.signalIndex)) windowEnds.push(record.signalIndex);
    if (windowEnds.length) {
      entry.hasEndpoints = true;
      for (const end of windowEnds) entry.endpoints.add(end);
    } else {
      entry.endpoints.add(record.index);
    }
  }

  let exact = true;
  const rules: RuleSignalSummary[] = [...byRule.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ruleNumber, entry]) => {
      if (!entry.hasSignalCount && !entry.hasEndpoints) exact = false;
      let firstIndex = Infinity;
      let lastIndex = -Infinity;
      for (const index of entry.points) {
        if (index < firstIndex) firstIndex = index;
        if (index > lastIndex) lastIndex = index;
      }
      return {
        ruleNumber,
        description: entry.description,
        signalCount: entry.hasSignalCount ? entry.countedSignals : entry.endpoints.size,
        pointCount: entry.points.size,
        firstIndex,
        lastIndex,
        signalIndices: [...entry.endpoints].sort((left, right) => left - right).slice(0, MAX_SIGNAL_INDICES),
      };
    });

  return {
    ruleSet,
    signalCount: rules.reduce((sum, rule) => sum + rule.signalCount, 0),
    flaggedPointCount: flagged.size,
    exactSignalCounts: exact,
    rules,
  };
};

const seriesRange = (values: readonly number[] | undefined) => {
  if (!values?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) ? { min, max } : null;
};

/** Scalars and ranges only: chartValues, capabilityValues and pointwise series never leave the browser. */
export const compactControlLimits = (limits: ControlLimits | null | undefined) => {
  if (!limits) return null;
  const variableUcl = seriesRange(limits.uclSeries);
  const variableLcl = seriesRange(limits.lclSeries);
  const denominator = seriesRange(limits.denominatorSeries);
  const variation = limits.variationChart;
  return {
    centerLine: finiteOrNull(limits.centerLine),
    ucl: finiteOrNull(limits.ucl),
    lcl: finiteOrNull(limits.lcl),
    sigma: finiteOrNull(limits.sigma),
    processSigma: finiteOrNull(limits.processSigma),
    sigmaMethod: limits.sigmaMethod ?? null,
    ...(limits.constants ? { constants: limits.constants } : {}),
    ...(variableUcl || variableLcl ? { variableLimits: { ucl: variableUcl, lcl: variableLcl } } : {}),
    ...(denominator ? { denominator } : {}),
    ...(variation ? {
      variationChart: {
        centerLine: finiteOrNull(variation.centerLine),
        ucl: finiteOrNull(variation.ucl),
        lcl: finiteOrNull(variation.lcl),
        sigma: finiteOrNull(variation.sigma),
      },
    } : {}),
  };
};

const compactCapabilityStatus = (status: CapabilityStatus | null | undefined) => {
  if (!status) return null;
  return {
    readiness: status.readiness,
    reasons: status.reasons,
    indices: Object.fromEntries(Object.entries(status.indices ?? {}).map(([key, value]) => [key, finiteOrNull(value)])),
    ...(status.sigmaEstimate ? {
      sigmaEstimate: {
        within: finiteOrNull(status.sigmaEstimate.within),
        overall: finiteOrNull(status.sigmaEstimate.overall),
        method: status.sigmaEstimate.method ?? null,
        observationCount: status.sigmaEstimate.observationCount,
      },
    } : {}),
  };
};

export const summarizeProcessedData = (processedData: ProcessedData | null, chartOptions?: ChartOptions) => {
  if (!processedData) {
    return null;
  }

  const ruleSet = chartOptions?.ruleSet ?? 'nelson';
  const statistics = processedData.statistics;
  return {
    statistics: {
      mean: finiteOrNull(statistics.mean),
      standardDeviation: finiteOrNull(statistics.standardDeviation),
      min: finiteOrNull(statistics.min),
      max: finiteOrNull(statistics.max),
      count: statistics.count,
    },
    // Flag records (one per point per rule), kept for older gateways; ruleSummary has real signal counts.
    ruleViolationCount: processedData.ruleViolations.length,
    ruleSummary: summarizeRuleViolations(processedData.ruleViolations, ruleSet),
    ...(processedData.variationRuleViolations
      ? { variationRuleSummary: summarizeRuleViolations(processedData.variationRuleViolations, ruleSet) }
      : {}),
    controlLimits: compactControlLimits(processedData.controlLimits),
    dataProfile: processedData.dataProfile,
    diagnostics: processedData.diagnostics?.slice(0, MAX_DIAGNOSTICS),
    chartRecommendations: processedData.chartRecommendations?.slice(0, MAX_RECOMMENDATIONS),
    capabilityStatus: compactCapabilityStatus(processedData.capabilityStatus),
    specLimits: {
      lowerSpecLimit: finiteOrNull(chartOptions?.lowerSpecLimit),
      upperSpecLimit: finiteOrNull(chartOptions?.upperSpecLimit),
      targetValue: finiteOrNull(chartOptions?.targetValue),
    },
  };
};

export interface AgentColumnProfile {
  name: string;
  numeric: number;
  nonNumeric: number;
  missing: number;
  integerLike: boolean;
  nonNegative: boolean;
  min: number | null;
  max: number | null;
  /** Legacy clients may send partial profiles; these cached profiles scan every row. */
  sampled: boolean;
}

const parseCellNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const columnProfileCache = new WeakMap<DataSet['data'], { headers: string; profiles: AgentColumnProfile[] }>();

/** Lets the gateway check chart/column compatibility (counts, proportions, positive denominators) before proposing a change. */
export const buildColumnProfiles = (rawData: DataSet | null): AgentColumnProfile[] => {
  if (!rawData) return [];
  const headers = JSON.stringify(rawData.headers);
  const cached = columnProfileCache.get(rawData.data);
  if (cached?.headers === headers) return cached.profiles;
  const rows = rawData.data;
  const profiles = rawData.headers.map((name) => {
    let numeric = 0;
    let nonNumeric = 0;
    let missing = 0;
    let integerLike = true;
    let nonNegative = true;
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      const raw = row[name];
      if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
        missing += 1;
        continue;
      }
      const value = parseCellNumber(raw);
      if (value === null) {
        nonNumeric += 1;
        continue;
      }
      numeric += 1;
      if (!Number.isInteger(value)) integerLike = false;
      if (value < 0) nonNegative = false;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return {
      name,
      numeric,
      nonNumeric,
      missing,
      integerLike: numeric > 0 && integerLike,
      nonNegative: numeric > 0 && nonNegative,
      min: numeric > 0 ? min : null,
      max: numeric > 0 ? max : null,
      sampled: false,
    };
  });
  columnProfileCache.set(rawData.data, { headers, profiles });
  return profiles;
};

const boundPreviewRows = (rawData: DataSet | null) => {
  if (!rawData) return [];
  const headers = rawData.headers.slice(0, MAX_PREVIEW_COLUMNS);
  return rawData.data.slice(0, MAX_PREVIEW_ROWS).map((row) => Object.fromEntries(headers.map((header) => {
    const value = row[header];
    return [header, typeof value === 'string' && value.length > MAX_PREVIEW_VALUE_LENGTH
      ? `${value.slice(0, MAX_PREVIEW_VALUE_LENGTH)}…`
      : value ?? null];
  })));
};

export const buildAgentTurnRequest = (
  input: AgentControlsSnapshotInput,
  conversationForRequest: AiChatMessage[],
  options: {
    model: string;
    systemPrompt: string;
    datasetSummary: string | null;
    processedData: ProcessedData | null;
    temperature?: number;
  },
) => {
  const snapshot = buildControlsSnapshot(input);
  const rawData = input.rawData;
  const scopedData = scopeDatasetForAi(rawData, input.selectedDataRange);

  return {
    model: options.model,
    language: input.language,
    messages: [
      { role: 'system', content: options.systemPrompt },
      ...conversationForRequest.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    controls: snapshot.current,
    availableHeaders: scopedData?.headers ?? [],
    worksheet: snapshot.worksheet,
    dataset: {
      summary: options.datasetSummary,
      fileName: rawData?.fileName ?? null,
      fileType: rawData?.fileType ?? null,
      rowCount: scopedData?.data.length ?? 0,
      columnCount: scopedData?.headers.length ?? 0,
      totalRowCount: rawData?.data.length ?? 0,
      totalColumnCount: rawData?.headers.length ?? 0,
      analysisScope: input.selectedDataRange ?? null,
      headers: scopedData?.headers ?? [],
      previewRows: boundPreviewRows(scopedData),
      columnProfiles: buildColumnProfiles(scopedData),
    },
    processed: summarizeProcessedData(options.processedData, input.chartOptions),
    selectedSheetIndex: input.selectedAiSheetIndex,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
};
