import { ChartType } from '../types/DataTypes';

const CHART_TYPES: ChartType[] = ['individual', 'pChart', 'npChart', 'cChart', 'uChart', 'xBarS', 'xBarR', 'ewma', 'histogram', 'scatterPlot'];

// Paraphrases weaker models produce, keyed by the lowercased name with separators and a
// trailing "chart"/"plot" removed. Mirrors CHART_TYPE_ALIASES in the DSPy gateway.
const CHART_TYPE_ALIASES: Record<string, ChartType> = {
  individual: 'individual',
  individuals: 'individual',
  i: 'individual',
  imr: 'individual',
  xmr: 'individual',
  individualsmovingrange: 'individual',
  individualmovingrange: 'individual',
  p: 'pChart',
  proportion: 'pChart',
  fractiondefective: 'pChart',
  fractionnonconforming: 'pChart',
  np: 'npChart',
  numberdefective: 'npChart',
  numbernonconforming: 'npChart',
  c: 'cChart',
  defectcount: 'cChart',
  u: 'uChart',
  defectsperunit: 'uChart',
  xbars: 'xBarS',
  xbarands: 'xBarS',
  xbarstddev: 'xBarS',
  xbarstdev: 'xBarS',
  xbarsigma: 'xBarS',
  xbarr: 'xBarR',
  xbarandr: 'xBarR',
  xbarrange: 'xBarR',
  ewma: 'ewma',
  exponentiallyweightedmovingaverage: 'ewma',
  histogram: 'histogram',
  hist: 'histogram',
  scatter: 'scatterPlot',
  xy: 'scatterPlot',
};

export interface AgentRecommendation {
  chartType: ChartType | null;
  yColumns: string[];
  xAxisColumn?: string | null;
  denominatorColumn?: string | null;
  sampleSize?: number;
  chartLabel?: string;
  zAxisLabel?: string;
  yAxisLabel?: string;
  reason: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export const normalizeAgentChartType = (value: unknown): ChartType | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const raw = value.trim();
  if (CHART_TYPES.includes(raw as ChartType)) {
    return raw as ChartType;
  }
  const key = raw
    .toLowerCase()
    .replace(/x̄|x̅/g, 'xbar')
    .replace(/[\s_\-–—/().,&+]+/g, '')
    .replace(/(charts?|plots?|graph)$/, '');
  return CHART_TYPE_ALIASES[key] ?? null;
};

/** Exact header first, then a unique case-insensitive match; never a fuzzy guess. */
export const resolveHeaderName = (value: string, headers: string[]): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (headers.includes(trimmed)) {
    return trimmed;
  }
  const folded = trimmed.toLocaleLowerCase();
  const matches = headers.filter((header) => header.trim().toLocaleLowerCase() === folded);
  return matches.length === 1 ? matches[0] : null;
};

const normalizeOptionalLabel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeOptionalColumn = (recommendation: Record<string, unknown>, key: string): string | null | undefined => {
  if (!hasOwn(recommendation, key)) {
    return undefined;
  }
  const value = recommendation[key];
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  return value === null ? null : undefined;
};

const normalizeSampleSize = (value: unknown): number | undefined => {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numeric) ? Math.max(2, Math.min(25, Math.round(numeric))) : undefined;
};

const findMatchingBraceEnd = (content: string, start: number): number | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
};

const extractJsonCandidates = (content: string): unknown[] => {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  for (const match of content.matchAll(/\{\s*"recommendation"\s*:/g)) {
    const end = findMatchingBraceEnd(content, match.index ?? 0);
    if (end !== null) {
      candidates.push(content.slice(match.index, end));
    }
  }

  return candidates.flatMap((candidate) => {
    if (seen.has(candidate)) {
      return [];
    }
    seen.add(candidate);

    try {
      return [JSON.parse(candidate)];
    } catch {
      return [];
    }
  });
};

const normalizeRecommendationPayload = (parsed: unknown): AgentRecommendation | null => {
  if (!isRecord(parsed) || !isRecord(parsed.recommendation)) {
    return null;
  }
  const recommendation = parsed.recommendation;

  const chartType = normalizeAgentChartType(recommendation.chartType);

  const yColumnsRaw: unknown[] = Array.isArray(recommendation.yColumns) ? recommendation.yColumns : [];
  const yColumnsFromArray = yColumnsRaw
    .filter((column): column is string => typeof column === 'string')
    .map((column) => column.trim())
    .filter((column) => column.length > 0);

  const yColumnLegacy = typeof recommendation.yColumn === 'string' && recommendation.yColumn.trim()
    ? recommendation.yColumn.trim()
    : null;

  const yColumns = yColumnsFromArray.length > 0
    ? Array.from(new Set(yColumnsFromArray))
    : yColumnLegacy
      ? [yColumnLegacy]
      : [];

  const xAxisColumn = normalizeOptionalColumn(recommendation, 'xAxisColumn');
  const denominatorColumn = normalizeOptionalColumn(recommendation, 'denominatorColumn');
  const sampleSize = hasOwn(recommendation, 'sampleSize') ? normalizeSampleSize(recommendation.sampleSize) : undefined;

  const chartLabel = normalizeOptionalLabel(recommendation.chartLabel);
  const zAxisLabel = normalizeOptionalLabel(recommendation.zAxisLabel ?? recommendation.xAxisLabel);
  const yAxisLabel = normalizeOptionalLabel(recommendation.yAxisLabel);

  const reason = typeof recommendation.reason === 'string' ? recommendation.reason.trim() : '';

  if (
    !chartType
    && yColumns.length === 0
    && xAxisColumn === undefined
    && denominatorColumn === undefined
    && sampleSize === undefined
    && chartLabel === undefined
    && zAxisLabel === undefined
    && yAxisLabel === undefined
    && !reason
  ) {
    return null;
  }

  return {
    chartType,
    yColumns,
    xAxisColumn,
    denominatorColumn,
    sampleSize,
    chartLabel,
    zAxisLabel,
    yAxisLabel,
    reason,
  };
};

const scoreRecommendation = (recommendation: AgentRecommendation): number => {
  let score = 0;
  if (recommendation.chartType) score += 4;
  score += Math.min(recommendation.yColumns.length, 8) * 3;
  if (recommendation.xAxisColumn !== undefined) score += 1;
  if (recommendation.denominatorColumn !== undefined) score += 2;
  if (recommendation.sampleSize !== undefined) score += 2;
  if (recommendation.chartLabel) score += 1;
  if (recommendation.zAxisLabel) score += 1;
  if (recommendation.yAxisLabel) score += 1;
  if (recommendation.reason) score += 1;
  return score;
};

export const extractAgentRecommendationFromMessage = (content: string): AgentRecommendation | null => {
  const recommendations = extractJsonCandidates(content)
    .map(normalizeRecommendationPayload)
    .filter((recommendation): recommendation is AgentRecommendation => recommendation !== null);

  if (recommendations.length === 0) {
    return null;
  }

  return recommendations.reduce((best, candidate) => (
    scoreRecommendation(candidate) > scoreRecommendation(best) ? candidate : best
  ));
};

export const stripAgentRecommendationFromMessage = (content: string, fallback: string): string => {
  let stripped = content.replace(/```json\s*[\s\S]*?```/gi, (block) => (
    /"recommendation"\s*:/.test(block) ? '' : block
  ));

  const spans: Array<[number, number]> = [];
  for (const match of stripped.matchAll(/\{\s*"recommendation"\s*:/g)) {
    const end = findMatchingBraceEnd(stripped, match.index ?? 0);
    if (end !== null) {
      spans.push([match.index ?? 0, end]);
    }
  }

  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const [start, end] = spans[index];
    stripped = `${stripped.slice(0, start)}${stripped.slice(end)}`;
  }

  stripped = stripped.replace(/\n?\s*(?:json\s*)?\{[\s\S]*"recommendation"[\s\S]*$/i, '');
  stripped = stripped.replace(/^\s*json\s*$/gim, '');

  return stripped.trim() || fallback;
};

export const validateAgentRecommendationAgainstHeaders = (
  recommendation: AgentRecommendation,
  headers: string[],
): AgentRecommendation => {
  const yColumns = Array.from(new Set(
    recommendation.yColumns
      .map((column) => resolveHeaderName(column, headers))
      .filter((column): column is string => column !== null),
  ));

  const resolveOptional = (value: string | null | undefined): string | null | undefined => {
    if (value === undefined || value === null) {
      return value;
    }
    return resolveHeaderName(value, headers) ?? undefined;
  };

  const xAxisColumn = resolveOptional(recommendation.xAxisColumn);
  const resolvedDenominator = resolveOptional(recommendation.denominatorColumn);
  // A column cannot be its own denominator; drop the suggestion rather than chart count/count.
  const denominatorColumn = typeof resolvedDenominator === 'string' && yColumns.includes(resolvedDenominator)
    ? undefined
    : resolvedDenominator;

  return {
    ...recommendation,
    yColumns,
    xAxisColumn,
    denominatorColumn,
    chartLabel: normalizeOptionalLabel(recommendation.chartLabel),
    zAxisLabel: normalizeOptionalLabel(recommendation.zAxisLabel),
    yAxisLabel: normalizeOptionalLabel(recommendation.yAxisLabel),
  };
};
