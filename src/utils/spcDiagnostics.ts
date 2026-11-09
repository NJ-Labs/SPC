import {
  ChartRecommendation,
  ChartType,
  DataKind,
  DataPoint,
  DataProfile,
  SpcDiagnostic,
} from '../types/DataTypes';
import { calculateMean, calculateStandardDeviation, parseSpcNumber } from './spcCalculations';

const parseNumber = (value: unknown): number | null => {
  const parsed = parseSpcNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const inferDataKind = (values: number[]): DataKind => {
  if (!values.length) return 'unknown';
  const nonNegative = values.every((value) => value >= 0);
  const integerLike = values.every((value) => Number.isInteger(value));
  const min = values.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const max = values.reduce((maximum, value) => Math.max(maximum, value), -Infinity);

  if (nonNegative && values.every((value) => value === 0 || value === 1)) return 'binary';
  if (nonNegative && min >= 0 && max <= 1 && !integerLike) return 'proportion';
  if (nonNegative && integerLike) return 'count';
  if (!integerLike) return 'continuous';
  return 'mixed';
};

const calculateSkewness = (values: number[]): number | null => {
  if (values.length < 3) return null;
  const mean = calculateMean(values);
  const sigma = calculateStandardDeviation(values);
  if (!Number.isFinite(mean) || !Number.isFinite(sigma) || sigma <= 0) return null;
  const thirdMoment = values.reduce((sum, value) => sum + ((value - mean) / sigma) ** 3, 0) / values.length;
  return thirdMoment;
};

const calculateLag1Autocorrelation = (values: Array<number | null>): number | null => {
  const clean = values.filter((value): value is number => value !== null);
  if (clean.length < 3) return null;
  const mean = calculateMean(clean);
  let numerator = 0;
  let pairCount = 0;
  for (let i = 1; i < values.length; i++) {
    const previous = values[i - 1];
    const current = values[i];
    if (previous !== null && current !== null) { numerator += (previous - mean) * (current - mean); pairCount++; }
  }
  const denominator = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return pairCount >= 2 && denominator > 0 ? numerator / denominator : null;
};

const isTimeOrdered = (rows: DataPoint[], xAxisColumn?: string | null): boolean => {
  if (!xAxisColumn) {
    return rows.length > 1;
  }
  const numeric = rows.map(row => parseNumber(row[xAxisColumn]));
  const numericCount = numeric.filter(value => value !== null).length;
  const numericAxis = numericCount >= Math.max(2, Math.ceil(rows.length * 0.8));
  const timestamps = numericAxis
    ? numeric.map(value => value ?? NaN)
    : rows.map(row => typeof row[xAxisColumn] === 'string' && parseNumber(row[xAxisColumn]) === null ? Date.parse(String(row[xAxisColumn])) : NaN);
  const finite = timestamps.filter(Number.isFinite);
  if (finite.length < Math.max(2, Math.floor(rows.length * 0.8))) {
    return false;
  }
  for (let index = 1; index < finite.length; index += 1) {
    if (finite[index] < finite[index - 1]) {
      return false;
    }
  }
  return true;
};

const addDiagnostic = (
  diagnostics: SpcDiagnostic[],
  severity: SpcDiagnostic['severity'],
  code: string,
  message: string,
) => diagnostics.push({ severity, code, message });

const recommendation = (
  chartType: ChartType,
  score: number,
  status: ChartRecommendation['status'],
  reason: string,
): ChartRecommendation => ({ chartType, score, status, reason });

const rankRecommendations = (params: {
  chartType: ChartType;
  dataKind: DataKind;
  sampleSize: number;
  subgroupCount: number;
  hasDenominator: boolean;
  hasMultipleYColumns: boolean;
  timeOrdered: boolean;
}): ChartRecommendation[] => {
  const { dataKind, sampleSize, subgroupCount, hasDenominator, hasMultipleYColumns, timeOrdered } = params;
  const recommendations: ChartRecommendation[] = [];

  if (dataKind === 'proportion' || dataKind === 'binary') {
    recommendations.push(recommendation('pChart', 94, 'recommended', 'Proportion or pass/fail data fits a P chart.'));
    recommendations.push(recommendation('npChart', 72, 'possible', 'Use NP only when subgroup size is constant.'));
  } else if (dataKind === 'count') {
    recommendations.push(recommendation(hasDenominator ? 'uChart' : 'cChart', 92, 'possible', hasDenominator ? 'If these are defect counts with opportunities, use a U chart; verify the data meaning.' : 'If these are defect counts with constant area, use a C chart; verify the data meaning.'));
    recommendations.push(recommendation(hasDenominator ? 'pChart' : 'npChart', 74, 'possible', hasDenominator ? 'Use P when counts are nonconforming units out of inspected units.' : 'Use NP for nonconforming counts with constant sample size.'));
  } else if (dataKind === 'continuous' || dataKind === 'mixed') {
    if (Number.isInteger(sampleSize) && sampleSize >= 2 && sampleSize <= 25 && subgroupCount >= 2) {
      recommendations.push(recommendation(sampleSize <= 10 ? 'xBarR' : 'xBarS', 90, 'recommended', 'Rational subgroups allow mean and variation monitoring.'));
      recommendations.push(recommendation(sampleSize <= 10 ? 'xBarS' : 'xBarR', 78, 'possible', 'Alternative subgroup chart depending on subgroup size and variation estimate.'));
    }
    recommendations.push(recommendation('individual', hasMultipleYColumns ? 68 : 88, hasMultipleYColumns ? 'possible' : 'recommended', 'Use I-MR when each row is one continuous observation.'));
    if (timeOrdered) {
      recommendations.push(recommendation('ewma', 76, 'possible', 'EWMA is useful for small persistent shifts in ordered data.'));
    }
    recommendations.push(recommendation('histogram', 55, 'possible', 'Use as distribution context, not as a control chart.'));
  } else {
    recommendations.push(recommendation('individual', 50, 'possible', 'Default to I-MR only after confirming the data are continuous and ordered.'));
  }

  return recommendations.sort((a, b) => b.score - a.score);
};

export const buildSpcDiagnostics = (params: {
  rows: DataPoint[];
  column: string | null;
  denominatorColumn?: string | null;
  xAxisColumn?: string | null;
  chartType: ChartType;
  sampleSize: number;
  selectedColumns: string[];
}): {
  profile: DataProfile;
  diagnostics: SpcDiagnostic[];
  recommendations: ChartRecommendation[];
  numericValues: number[];
} => {
  const { rows, column, denominatorColumn, xAxisColumn, chartType, sampleSize, selectedColumns } = params;
  const isXbar = chartType === 'xBarR' || chartType === 'xBarS';
  const subgroupColumns = isXbar && selectedColumns.length > 1 ? selectedColumns : [];
  const rawValues = subgroupColumns.length ? rows.flatMap(row => subgroupColumns.map(name => row[name])) : column ? rows.map(row => row[column]) : [];
  const subgroupSize = subgroupColumns.length || sampleSize;
  const validSubgroupSize = Number.isInteger(subgroupSize) && subgroupSize >= 2 && subgroupSize <= 25;
  const series = column ? rows.map(row => parseNumber(row[column])) : [];
  const groups: Array<Array<number | null>> = [];
  // A stored size alone does not establish rational subgroups for individual observations.
  if (isXbar && validSubgroupSize) {
    if (subgroupColumns.length) rows.forEach(row => groups.push(subgroupColumns.map(name => parseNumber(row[name]))));
    else for (let i = 0; i + subgroupSize <= series.length; i += subgroupSize) groups.push(series.slice(i, i + subgroupSize));
  }
  const validSubgroupCount = groups.filter(group => group.every(value => value !== null)).length;
  const orderedValues = isXbar
    ? groups.map(group => group.every(value => value !== null) ? calculateMean(group as number[]) : null)
    : series;
  const numericValues = rawValues.map(parseNumber).filter((value): value is number => value !== null);
  const missingCount = rawValues.filter((value) => value === null || value === undefined || String(value).trim() === '').length;
  const nonNumericCount = rawValues.length - missingCount - numericValues.length;
  const uniqueNumericCount = new Set(numericValues.map((value) => value.toPrecision(12))).size;
  const dataKind = inferDataKind(numericValues);
  const denominatorValues = denominatorColumn
    ? rows.map((row) => parseNumber(row[denominatorColumn])).filter((value): value is number => value !== null && value > 0)
    : [];
  const denominatorUniqueCount = new Set(denominatorValues.map((value) => value.toPrecision(12))).size;
  const timeOrdered = isTimeOrdered(rows, xAxisColumn);
  const mean = numericValues.length ? calculateMean(numericValues) : null;
  const standardDeviation = numericValues.length > 1 ? calculateStandardDeviation(numericValues) : null;
  const profile: DataProfile = {
    column,
    denominatorColumn,
    rowCount: rows.length,
    numericCount: numericValues.length,
    missingCount,
    nonNumericCount,
    uniqueNumericCount,
    tieRate: numericValues.length ? 1 - (uniqueNumericCount / numericValues.length) : 0,
    min: numericValues.length ? numericValues.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null,
    max: numericValues.length ? numericValues.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
    mean,
    standardDeviation,
    skewness: calculateSkewness(numericValues),
    lag1Autocorrelation: calculateLag1Autocorrelation(orderedValues),
    dataKind,
    integerLike: numericValues.every((value) => Number.isInteger(value)),
    nonNegative: numericValues.every((value) => value >= 0),
    hasVaryingDenominator: denominatorUniqueCount > 1,
    denominatorMin: denominatorValues.length ? denominatorValues.reduce((minimum, value) => Math.min(minimum, value), Infinity) : null,
    denominatorMax: denominatorValues.length ? denominatorValues.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
    timeOrdered,
  };

  const diagnostics: SpcDiagnostic[] = [];
  if (!column) {
    addDiagnostic(diagnostics, 'blocker', 'missing-y-column', 'Select a Y column before running SPC analysis.');
  }
  if (numericValues.length < 2) {
    addDiagnostic(diagnostics, 'blocker', 'too-few-numeric-values', 'At least two numeric values are required for control limits.');
  } else if (numericValues.length < 20) {
    addDiagnostic(diagnostics, 'warning', 'small-baseline', 'Fewer than 20 observations makes control limits preliminary.');
  }
  if (missingCount || nonNumericCount) {
    addDiagnostic(diagnostics, 'warning', 'non-numeric-values', `${missingCount + nonNumericCount} selected values are blank or non-numeric.`);
  }
  if (dataKind === 'count') {
    addDiagnostic(diagnostics, 'info', 'integer-data-ambiguity', 'Non-negative integers can be measurements or counts; confirm their meaning before choosing a chart.');
  }
  if (chartType === 'pChart' && !denominatorColumn && dataKind === 'binary' && sampleSize > 1) {
    addDiagnostic(diagnostics, 'warning', 'binary-sample-size', 'Confirm each value is a subgroup proportion; individual pass/fail observations have sample size 1.');
  }
  if (['individual', 'ewma'].includes(chartType) && numericValues.length >= 2 && !series.some((value, i) => i > 0 && value !== null && series[i - 1] !== null)) {
    addDiagnostic(diagnostics, 'blocker', 'no-moving-ranges', 'A within-process estimate needs at least one pair of consecutive numeric observations.');
  }
  if ((chartType === 'histogram' || chartType === 'scatterPlot')) {
    addDiagnostic(diagnostics, 'info', 'not-control-chart', 'This chart does not assess process stability or within-process capability.');
  }
  if (selectedColumns.length > 1 && chartType !== 'xBarR' && chartType !== 'xBarS') {
    addDiagnostic(diagnostics, 'info', 'multiple-y-columns', 'Only X-bar charts use multiple Y columns as one rational subgroup.');
  }
  if (profile.tieRate > 0.35 && numericValues.length >= 20) {
    addDiagnostic(diagnostics, 'warning', 'high-tie-rate', 'Many repeated values suggest gage resolution or rounded data may affect rules.');
  }
  if (Math.abs(profile.lag1Autocorrelation ?? 0) > 0.35) {
    addDiagnostic(diagnostics, 'warning', 'autocorrelation', 'Lag-1 autocorrelation is high; consider sampling interval or EWMA context.');
  }
  if (Math.abs(profile.skewness ?? 0) > 1) {
    addDiagnostic(diagnostics, 'warning', 'skewed-data', 'Strong skew can distort normal-theory limits and capability.');
  }
  if (!timeOrdered && ['individual', 'ewma', 'xBarR', 'xBarS'].includes(chartType)) {
    addDiagnostic(diagnostics, 'warning', 'time-order-unclear', 'Time ordering is unclear; control charts require process-order sequencing.');
  }
  if (['npChart', 'cChart', 'uChart'].includes(chartType) && (!profile.integerLike || !profile.nonNegative)) {
    addDiagnostic(diagnostics, 'blocker', 'count-data-required', 'This chart requires non-negative integer count data.');
  }
  if (chartType === 'pChart' && !denominatorColumn && dataKind !== 'proportion' && dataKind !== 'binary') {
    addDiagnostic(diagnostics, 'blocker', 'p-chart-needs-proportions', 'P charts need proportions or a denominator column with nonconforming counts.');
  }
  if (isXbar && !validSubgroupSize) {
    addDiagnostic(diagnostics, 'blocker', 'invalid-subgroup-size', 'X-bar subgroup size must be an integer from 2 through 25.');
  } else if (isXbar && validSubgroupCount < 2) {
    addDiagnostic(diagnostics, 'blocker', 'too-few-subgroups', 'X-bar charts need at least two complete numeric subgroups.');
  }
  if (isXbar && validSubgroupCount >= 2 && validSubgroupCount < 20) {
    addDiagnostic(diagnostics, 'warning', 'small-subgroup-baseline', 'Fewer than 20 complete subgroups makes control limits preliminary.');
  }
  if (isXbar && validSubgroupSize && (groups.length > validSubgroupCount || (!subgroupColumns.length && series.length % subgroupSize !== 0))) {
    addDiagnostic(diagnostics, 'warning', 'incomplete-subgroups', 'Incomplete or invalid subgroups are excluded; their positions are not regrouped.');
  }
  if (['pChart', 'npChart', 'uChart'].includes(chartType) && (!denominatorColumn || chartType === 'npChart') && (!Number.isFinite(sampleSize) || sampleSize <= 0 || ((chartType === 'pChart' || chartType === 'npChart') && !Number.isInteger(sampleSize)))) {
    addDiagnostic(diagnostics, 'blocker', 'invalid-sample-size', 'A positive sample size is required (an integer for P/NP charts).');
  }
  if (chartType === 'npChart' && denominatorColumn) {
    addDiagnostic(diagnostics, 'blocker', 'np-chart-denominator', 'NP charts require a fixed sample size; use P for a denominator column.');
  }
  if ((chartType === 'pChart' || chartType === 'uChart') && denominatorColumn) {
    const invalidPair = rows.some(row => {
      const value = column ? parseNumber(row[column]) : null;
      if (value === null) return false;
      const denominator = parseNumber(row[denominatorColumn]);
      return denominator === null || denominator <= 0 || (chartType === 'pChart' && !Number.isInteger(denominator));
    });
    if (invalidPair) addDiagnostic(diagnostics, 'blocker', 'invalid-denominators', 'P/U charts need a valid positive denominator for each numeric row; P denominators must be integers.');
  }
  if (chartType === 'pChart' && denominatorColumn && rows.some(row => {
    const value = column ? parseNumber(row[column]) : null;
    const denominator = parseNumber(row[denominatorColumn]);
    return value !== null && (!Number.isInteger(value) || value < 0 || (denominator !== null && value > denominator));
  })) addDiagnostic(diagnostics, 'blocker', 'invalid-p-count', 'P counts must be non-negative integers no greater than their row denominator.');
  if (chartType === 'pChart' && !denominatorColumn && numericValues.some(value => value < 0 || value > 1)) {
    addDiagnostic(diagnostics, 'blocker', 'invalid-proportion', 'P chart proportions must lie between 0 and 1.');
  }
  if (chartType === 'npChart' && numericValues.some(value => value > sampleSize)) {
    addDiagnostic(diagnostics, 'blocker', 'invalid-np-count', 'NP counts cannot exceed the fixed sample size.');
  }

  return {
    profile,
    diagnostics,
    recommendations: rankRecommendations({
      chartType,
      dataKind,
      sampleSize,
      subgroupCount: validSubgroupCount,
      hasDenominator: Boolean(denominatorColumn),
      hasMultipleYColumns: selectedColumns.length > 1,
      timeOrdered,
    }),
    numericValues,
  };
};
