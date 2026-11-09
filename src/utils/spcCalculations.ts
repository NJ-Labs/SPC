import {
  CapabilityStatus,
  ControlLimits,
  ChartType,
  DataPoint,
  DataProfile,
  RuleViolation,
  SpcDiagnostic,
} from '../types/DataTypes';

// Helper to compute B3/B4 from c4
const computeB3B4 = (c4: number) => {
  const k = (3 / c4) * Math.sqrt(Math.max(0, 1 - c4 * c4));
  const b3 = Math.max(0, 1 - k);
  const b4 = 1 + k;
  return { b3, b4 };
};

// Constants for control charts based on sample size (n = 2..25)
type ControlConstants = {
  a2: number;
  a3: number;
  c4: number;
  b3: number;
  b4: number;
  d2: number;
  d3: number;
  d4: number;
};

const controlChartConstants: Record<number, ControlConstants> = {
  2: { a2: 1.880, a3: 2.659, c4: 0.7979, ...computeB3B4(0.7979), d2: 1.128, d3: 0, d4: 3.267 },
  3: { a2: 1.023, a3: 1.954, c4: 0.8862, ...computeB3B4(0.8862), d2: 1.693, d3: 0, d4: 2.574 },
  4: { a2: 0.729, a3: 1.628, c4: 0.9213, ...computeB3B4(0.9213), d2: 2.059, d3: 0, d4: 2.282 },
  5: { a2: 0.577, a3: 1.427, c4: 0.9400, ...computeB3B4(0.9400), d2: 2.326, d3: 0, d4: 2.114 },
  6: { a2: 0.483, a3: 1.287, c4: 0.9515, ...computeB3B4(0.9515), d2: 2.534, d3: 0, d4: 2.004 },
  7: { a2: 0.419, a3: 1.182, c4: 0.9594, ...computeB3B4(0.9594), d2: 2.704, d3: 0.076, d4: 1.924 },
  8: { a2: 0.373, a3: 1.099, c4: 0.9650, ...computeB3B4(0.9650), d2: 2.847, d3: 0.136, d4: 1.864 },
  9: { a2: 0.337, a3: 1.032, c4: 0.9693, ...computeB3B4(0.9693), d2: 2.970, d3: 0.184, d4: 1.816 },
  10: { a2: 0.308, a3: 0.975, c4: 0.9727, ...computeB3B4(0.9727), d2: 3.078, d3: 0.223, d4: 1.777 },
  11: { a2: 0.285, a3: 0.927, c4: 0.9754, ...computeB3B4(0.9754), d2: 3.173, d3: 0.256, d4: 1.744 },
  12: { a2: 0.266, a3: 0.886, c4: 0.9776, ...computeB3B4(0.9776), d2: 3.258, d3: 0.283, d4: 1.717 },
  13: { a2: 0.249, a3: 0.850, c4: 0.9794, ...computeB3B4(0.9794), d2: 3.336, d3: 0.307, d4: 1.693 },
  14: { a2: 0.235, a3: 0.817, c4: 0.9810, ...computeB3B4(0.9810), d2: 3.407, d3: 0.328, d4: 1.672 },
  15: { a2: 0.223, a3: 0.789, c4: 0.9823, ...computeB3B4(0.9823), d2: 3.472, d3: 0.347, d4: 1.653 },
  16: { a2: 0.212, a3: 0.763, c4: 0.9835, ...computeB3B4(0.9835), d2: 3.532, d3: 0.363, d4: 1.637 },
  17: { a2: 0.203, a3: 0.739, c4: 0.9845, ...computeB3B4(0.9845), d2: 3.588, d3: 0.378, d4: 1.622 },
  18: { a2: 0.194, a3: 0.718, c4: 0.9854, ...computeB3B4(0.9854), d2: 3.640, d3: 0.391, d4: 1.608 },
  19: { a2: 0.187, a3: 0.698, c4: 0.9862, ...computeB3B4(0.9862), d2: 3.689, d3: 0.403, d4: 1.597 },
  20: { a2: 0.180, a3: 0.680, c4: 0.9869, ...computeB3B4(0.9869), d2: 3.735, d3: 0.415, d4: 1.585 },
  21: { a2: 0.173, a3: 0.663, c4: 0.9876, ...computeB3B4(0.9876), d2: 3.778, d3: 0.425, d4: 1.575 },
  22: { a2: 0.167, a3: 0.647, c4: 0.9882, ...computeB3B4(0.9882), d2: 3.819, d3: 0.434, d4: 1.566 },
  23: { a2: 0.162, a3: 0.633, c4: 0.9887, ...computeB3B4(0.9887), d2: 3.858, d3: 0.443, d4: 1.557 },
  24: { a2: 0.157, a3: 0.619, c4: 0.9892, ...computeB3B4(0.9892), d2: 3.895, d3: 0.451, d4: 1.548 },
  25: { a2: 0.153, a3: 0.606, c4: 0.9896, ...computeB3B4(0.9896), d2: 3.931, d3: 0.459, d4: 1.541 },
};

// Unsupported sizes must never silently use constants for a different subgroup size.
export const getControlChartConstants = (sampleSize: number): ControlConstants => (
  controlChartConstants[sampleSize] ?? { a2: NaN, a3: NaN, c4: NaN, b3: NaN, b4: NaN, d2: NaN, d3: NaN, d4: NaN }
);

export const parseSpcNumber = (value: unknown): number => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

export const calculateMean = (data: number[]): number => data.length ? data.reduce((sum, value) => sum + value, 0) / data.length : NaN;
export const calculateStandardDeviation = (data: number[]): number => {
  if (data.length < 2) return NaN;
  // Welford's algorithm avoids cancellation when measurements have a large offset.
  let mean = 0;
  let m2 = 0;
  data.forEach((value, i) => { const delta = value - mean; mean += delta / (i + 1); m2 += delta * (value - mean); });
  return Math.sqrt(m2 / (data.length - 1));
};

export interface CapabilitySpecLimits {
  lowerSpecLimit?: number | null;
  upperSpecLimit?: number | null;
  targetValue?: number | null;
}

const finiteOrNull = (value: number | null | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const calculateCapabilityIndices = (
  mean: number,
  sigma: number,
  specLimits: CapabilitySpecLimits
): Pick<CapabilityStatus['indices'], 'cp' | 'cpl' | 'cpu' | 'cpk'> => {
  const empty = {
    cp: Number.NaN,
    cpl: Number.NaN,
    cpu: Number.NaN,
    cpk: Number.NaN,
  };

  if (!Number.isFinite(mean) || !Number.isFinite(sigma) || sigma <= 0) {
    return empty;
  }

  const lowerSpecLimit = finiteOrNull(specLimits.lowerSpecLimit);
  const upperSpecLimit = finiteOrNull(specLimits.upperSpecLimit);
  if ((specLimits.lowerSpecLimit != null && lowerSpecLimit === null) || (specLimits.upperSpecLimit != null && upperSpecLimit === null)) return empty;

  if (
    lowerSpecLimit !== null &&
    upperSpecLimit !== null &&
    upperSpecLimit <= lowerSpecLimit
  ) {
    return empty;
  }

  const cpl = lowerSpecLimit !== null
    ? (mean - lowerSpecLimit) / (3 * sigma)
    : Number.NaN;
  const cpu = upperSpecLimit !== null
    ? (upperSpecLimit - mean) / (3 * sigma)
    : Number.NaN;
  const cp = lowerSpecLimit !== null && upperSpecLimit !== null
    ? (upperSpecLimit - lowerSpecLimit) / (6 * sigma)
    : Number.NaN;
  const cpkCandidates = [cpl, cpu].filter(Number.isFinite);
  const cpk = cpkCandidates.length > 0
    ? Math.min(...cpkCandidates)
    : Number.NaN;

  return { cp, cpl, cpu, cpk };
};

export const calculateCapabilityStatus = (
  values: number[], mean: number, withinSigma: number, specLimits: CapabilitySpecLimits,
  options: { chartType: ChartType; dataProfile?: DataProfile; ruleViolations?: RuleViolation[]; sigmaMethod?: string; diagnostics?: SpcDiagnostic[] },
): CapabilityStatus => {
  const emptyIndices = { cp: NaN, cpl: NaN, cpu: NaN, cpk: NaN, pp: NaN, ppl: NaN, ppu: NaN, ppk: NaN, cpm: NaN };
  const cleanValues = values.filter(Number.isFinite);
  const overallSigma = calculateStandardDeviation(cleanValues);
  const sigmaEstimate = { within: withinSigma, overall: overallSigma, method: options.sigmaMethod, observationCount: cleanValues.length };
  const unavailable = (reason: string): CapabilityStatus => ({ readiness: 'notApplicable', indices: emptyIndices, reasons: [reason], sigmaEstimate });
  if (['pChart', 'npChart', 'cChart', 'uChart'].includes(options.chartType)) {
    return unavailable('Capability indices require continuous variable data, not attribute counts or proportions.');
  }
  if (['histogram', 'scatterPlot'].includes(options.chartType)) {
    return unavailable('Choose a continuous control chart to estimate within-process variation and assess stability.');
  }
  const lower = finiteOrNull(specLimits.lowerSpecLimit);
  const upper = finiteOrNull(specLimits.upperSpecLimit);
  const target = finiteOrNull(specLimits.targetValue);
  if ((specLimits.lowerSpecLimit != null && lower === null) || (specLimits.upperSpecLimit != null && upper === null) || (specLimits.targetValue != null && target === null)) {
    return unavailable('Specification limits and target must be finite numbers.');
  }
  if (lower === null && upper === null) return unavailable('Add at least one specification limit before interpreting capability.');
  if (lower !== null && upper !== null && upper <= lower) return unavailable('Upper specification limit must be greater than lower specification limit.');
  if (!Number.isFinite(mean) || cleanValues.length < 2) return unavailable('At least two usable observations and a finite mean are required for capability.');

  const within = calculateCapabilityIndices(mean, withinSigma, { lowerSpecLimit: lower, upperSpecLimit: upper });
  const performance = calculateCapabilityIndices(mean, overallSigma, { lowerSpecLimit: lower, upperSpecLimit: upper });
  let cpm = NaN;
  const targetOutsideSpecs = target !== null && ((lower !== null && target < lower) || (upper !== null && target > upper));
  if (lower !== null && upper !== null && target !== null && !targetOutsideSpecs && Number.isFinite(overallSigma) && overallSigma > 0) {
    const denominator = 6 * Math.sqrt(overallSigma ** 2 + (mean - target) ** 2);
    if (denominator > 0) cpm = (upper - lower) / denominator;
  }
  const indices = { ...within, pp: performance.cp, ppl: performance.cpl, ppu: performance.cpu, ppk: performance.cpk, cpm };
  const reasons: string[] = [];
  if (targetOutsideSpecs) reasons.push('The target must lie within the specification limits; Cpm is unavailable.');
  if (!Number.isFinite(withinSigma) || withinSigma <= 0) reasons.push('A positive within-process sigma estimate is required for Cp and Cpk.');
  if (!Number.isFinite(overallSigma) || overallSigma <= 0) reasons.push('A positive overall sample standard deviation is required for Pp and Ppk.');
  if (!Object.values(indices).some(Number.isFinite)) return { readiness: 'notApplicable', indices, reasons, sigmaEstimate };
  if (cleanValues.length < 30) reasons.push('Capability is preliminary with fewer than 30 usable observations.');
  if (options.chartType === 'ewma') reasons.push('Capability is preliminary until the underlying individual and moving-range chart is assessed for stability.');
  if (options.ruleViolations === undefined) reasons.push('Capability is preliminary because control-chart stability has not been evaluated.');
  else if (options.ruleViolations.length > 0) reasons.push('Capability is preliminary because control-chart rules indicate instability.');
  if (options.diagnostics?.some(item => ['incomplete-subgroups', 'small-subgroup-baseline', 'time-order-unclear', 'non-numeric-values'].includes(item.code) || item.severity === 'blocker')) {
    reasons.push('Capability is preliminary because data quality, subgroup coverage, or time order needs review.');
  }
  if (Math.abs(options.dataProfile?.skewness ?? 0) > 1) reasons.push('Capability is preliminary because the selected data are strongly skewed.');
  if (Math.abs(options.dataProfile?.lag1Autocorrelation ?? 0) > 0.35) reasons.push('Capability is preliminary because observations appear autocorrelated.');
  return { readiness: reasons.length ? 'preliminary' : 'ready', indices, reasons: reasons.length ? reasons : ['Process appears stable enough for initial capability interpretation.'], sigmaEstimate };
};

// Moving ranges never bridge missing observations.
export const calculateIndividualControlLimits = (data: number[]): ControlLimits => {
  const clean = data.filter(Number.isFinite);
  const mean = calculateMean(clean);
  const movingRanges = data.map((value, i) => i > 0 && Number.isFinite(value) && Number.isFinite(data[i - 1]) ? Math.abs(value - data[i - 1]) : NaN);
  const mrBar = calculateMean(movingRanges.filter(Number.isFinite));
  const sigma = mrBar / 1.128;
  return { ucl: mean + 3 * sigma, lcl: mean - 3 * sigma, centerLine: mean, sigma, processSigma: sigma,
    sigmaMethod: 'MR-bar/d2 (n=2)', capabilityValues: clean, chartValues: data,
    variationChart: { ucl: 3.267 * mrBar, lcl: 0, centerLine: mrBar, sigma: (3.267 - 1) * mrBar / 3, chartValues: movingRanges } };

};

const clampLowerLimit = (value: number): number => Math.max(0, value);
const numericSeriesFromRows = (data: DataPoint[], column: string): number[] => data.map(row => parseSpcNumber(row[column]));
const positiveDenominatorsFromRows = (data: DataPoint[], column?: string | null): Array<number | null> | undefined =>
  column ? data.map(row => { const n = parseSpcNumber(row[column]); return n > 0 ? n : null; }) : undefined;

// P and U preserve row positions and exclude invalid count/denominator pairs.
export const calculatePChartLimits = (data: number[], sampleSize: number, denominators?: Array<number | null>): ControlLimits => {
  const validSize = (n: number) => Number.isInteger(n) && n > 0;
  const ns = data.map((_, i) => denominators === undefined ? sampleSize : (denominators[i] ?? NaN));
  const chartValues = data.map((value, i) => {
    const n = ns[i];
    if (!validSize(n) || !Number.isFinite(value)) return NaN;
    if (denominators !== undefined) return Number.isInteger(value) && value >= 0 && value <= n ? value / n : NaN;
    return value >= 0 && value <= 1 ? value : NaN;
  });
  const pairs = chartValues.map((value, i) => ({ value, n: ns[i] })).filter(pair => Number.isFinite(pair.value));
  const total = pairs.reduce((sum, pair) => sum + pair.n, 0);
  const p = total > 0 ? pairs.reduce((sum, pair) => sum + pair.value * pair.n, 0) / total : NaN;
  const sigmaSeries = chartValues.map((value, i) => Number.isFinite(value) ? Math.sqrt(p * (1 - p) / ns[i]) : NaN);
  const uclSeries = sigmaSeries.map(sigma => Math.min(1, p + 3 * sigma));
  const lclSeries = sigmaSeries.map(sigma => clampLowerLimit(p - 3 * sigma));
  return { ucl: calculateMean(uclSeries.filter(Number.isFinite)), lcl: calculateMean(lclSeries.filter(Number.isFinite)), centerLine: p, sigma: calculateMean(sigmaSeries.filter(Number.isFinite)), uclSeries, lclSeries, sigmaSeries, denominatorSeries: ns, chartValues };
};

export const calculateNPChartLimits = (data: number[], sampleSize: number): ControlLimits => {
  const validSize = Number.isInteger(sampleSize) && sampleSize > 0;
  const chartValues = data.map(v => validSize && Number.isInteger(v) && v >= 0 && v <= sampleSize ? v : NaN);
  const np = calculateMean(chartValues.filter(Number.isFinite));
  const p = np / sampleSize;
  const sigma = Math.sqrt(sampleSize * p * (1 - p));
  return { ucl: Math.min(sampleSize, np + 3 * sigma), lcl: clampLowerLimit(np - 3 * sigma), centerLine: np, sigma, chartValues };
};

export const calculateCChartLimits = (data: number[]): ControlLimits => {
  const chartValues = data.map(v => Number.isInteger(v) && v >= 0 ? v : NaN);
  const cBar = calculateMean(chartValues.filter(Number.isFinite));
  const sigma = Math.sqrt(cBar);
  return { ucl: cBar + 3 * sigma, lcl: clampLowerLimit(cBar - 3 * sigma), centerLine: cBar, sigma, chartValues };
};

export const calculateUChartLimits = (data: number[], sampleSize: number, denominators?: Array<number | null>): ControlLimits => {
  const ns = data.map((_, i) => denominators === undefined ? sampleSize : (denominators[i] ?? NaN));
  const chartValues = data.map((count, i) => Number.isInteger(count) && count >= 0 && Number.isFinite(ns[i]) && ns[i] > 0 ? count / ns[i] : NaN);
  const valid = chartValues.map((value, i) => ({ value, n: ns[i] })).filter(pair => Number.isFinite(pair.value));
  const total = valid.reduce((sum, pair) => sum + pair.n, 0);
  const uBar = total > 0 ? valid.reduce((sum, pair) => sum + pair.value * pair.n, 0) / total : NaN;
  const sigmaSeries = chartValues.map((value, i) => Number.isFinite(value) ? Math.sqrt(uBar / ns[i]) : NaN);
  const uclSeries = sigmaSeries.map(sigma => uBar + 3 * sigma);
  const lclSeries = sigmaSeries.map(sigma => clampLowerLimit(uBar - 3 * sigma));
  return { ucl: calculateMean(uclSeries.filter(Number.isFinite)), lcl: calculateMean(lclSeries.filter(Number.isFinite)), centerLine: uBar, sigma: calculateMean(sigmaSeries.filter(Number.isFinite)), uclSeries, lclSeries, sigmaSeries, denominatorSeries: ns, chartValues };
};

// Each incomplete or invalid subgroup remains a gap; observations are never regrouped across it.
const splitSubgroups = (values: number[], sampleSize: number): number[][] => {
  if (!Number.isInteger(sampleSize) || sampleSize < 2 || sampleSize > 25) return [];
  const groups: number[][] = [];
  for (let i = 0; i + sampleSize <= values.length; i += sampleSize) groups.push(values.slice(i, i + sampleSize));
  return groups;
};

const summarizeSubgroups = (groups: number[][], sampleSize: number, kind: 'xBarR' | 'xBarS') => {
  const constants = getControlChartConstants(sampleSize);
  const valid = groups.map(group => group.length === sampleSize && group.every(Number.isFinite));
  const subgroupMeans = groups.map((group, i) => valid[i] ? calculateMean(group) : NaN);
  const subgroupVariation = groups.map((group, i) => !valid[i] ? NaN : kind === 'xBarR' ? Math.max(...group) - Math.min(...group) : calculateStandardDeviation(group));
  const completeMeans = subgroupMeans.filter(Number.isFinite);
  const usable = completeMeans.length >= 2 && Number.isFinite(constants.d2);
  const xBar = usable ? calculateMean(completeMeans) : NaN;
  const variationBar = usable ? calculateMean(subgroupVariation.filter(Number.isFinite)) : NaN;
  const processSigma = kind === 'xBarR' ? variationBar / constants.d2 : variationBar / constants.c4;
  const sigma = processSigma / Math.sqrt(sampleSize);
  const factor = kind === 'xBarR' ? constants.a2 : constants.a3;
  const controlLimits: ControlLimits = {
    ucl: xBar + factor * variationBar, lcl: xBar - factor * variationBar, centerLine: xBar,
    sigma, processSigma, sigmaMethod: kind === 'xBarR' ? 'R-bar/d2' : 'S-bar/c4', constants,
    chartValues: subgroupMeans,
    capabilityValues: groups.filter((_, i) => valid[i]).flat(),
    variationChart: {
      ucl: (kind === 'xBarR' ? constants.d4 : constants.b4) * variationBar,
      lcl: Math.max(0, (kind === 'xBarR' ? constants.d3 : constants.b3) * variationBar),
      centerLine: variationBar,
      sigma: ((kind === 'xBarR' ? constants.d4 : constants.b4) - 1) * variationBar / 3,
      chartValues: subgroupVariation,
    },
  };
  return { subgroupMeans, subgroupVariation, variationBar, controlLimits, constants };
};

export const calculateXbarSChartLimits = (subgroupMeans: number[], subgroupStdDevs: number[], sampleSize: number): ControlLimits => {
  const constants = getControlChartConstants(sampleSize);
  const pairs = subgroupMeans.map((mean, i) => ({ mean, s: subgroupStdDevs[i] })).filter(pair => Number.isFinite(pair.mean) && Number.isFinite(pair.s) && pair.s >= 0);
  const xBar = pairs.length >= 2 ? calculateMean(pairs.map(pair => pair.mean)) : NaN;
  const sBar = pairs.length >= 2 ? calculateMean(pairs.map(pair => pair.s)) : NaN;
  const processSigma = sBar / constants.c4;
  return { ucl: xBar + constants.a3 * sBar, lcl: xBar - constants.a3 * sBar, centerLine: xBar, sigma: processSigma / Math.sqrt(sampleSize), processSigma, sigmaMethod: 'S-bar/c4', constants };
};

export const computeXbarSComponents = (values: number[], sampleSize: number) => {
  const summary = summarizeSubgroups(splitSubgroups(values, sampleSize), sampleSize, 'xBarS');
  const { controlLimits, constants, variationBar } = summary;
  return { subgroupMeans: summary.subgroupMeans, subgroupStdDevs: summary.subgroupVariation,
    xbarLimits: { ucl: controlLimits.ucl, lcl: controlLimits.lcl, centerLine: controlLimits.centerLine },
    sChartLimits: { ucl: constants.b4 * variationBar, lcl: Math.max(0, constants.b3 * variationBar), centerLine: variationBar },
    sigmaEstimate: controlLimits.processSigma ?? NaN };
};

export const computeXbarRComponents = (values: number[], sampleSize: number) => {
  const summary = summarizeSubgroups(splitSubgroups(values, sampleSize), sampleSize, 'xBarR');
  const { controlLimits, constants, variationBar } = summary;
  return { subgroupMeans: summary.subgroupMeans, subgroupRanges: summary.subgroupVariation,
    xbarLimits: { ucl: controlLimits.ucl, lcl: controlLimits.lcl, centerLine: controlLimits.centerLine },
    rChartLimits: { ucl: constants.d4 * variationBar, lcl: Math.max(0, constants.d3 * variationBar), centerLine: variationBar },
    sigmaEstimate: controlLimits.processSigma ?? NaN };
};

// Missing observations leave a plotted gap while preserving EWMA state and observation age.
export const calculateEWMALimits = (data: number[], lambda = 0.2): ControlLimits => {
  const individual = calculateIndividualControlLimits(data);
  const mean = individual.centerLine;
  const processSigma = individual.processSigma ?? NaN;
  const validLambda = Number.isFinite(lambda) && lambda > 0 && lambda <= 1;
  const ewmaValues = calculateEWMAValues(data, lambda, mean);
  let age = 0;
  const sigmaSeries = data.map(value => {
    if (!Number.isFinite(value)) return NaN;
    age++;
    return validLambda ? processSigma * Math.sqrt((lambda / (2 - lambda)) * (1 - (1 - lambda) ** (2 * age))) : NaN;
  });
  const sigma = validLambda ? processSigma * Math.sqrt(lambda / (2 - lambda)) : NaN;
  return { ucl: mean + 3 * sigma, lcl: mean - 3 * sigma, centerLine: mean, sigma, processSigma,
    sigmaMethod: individual.sigmaMethod, capabilityValues: individual.capabilityValues, variationChart: individual.variationChart,
    uclSeries: sigmaSeries.map(pointSigma => mean + 3 * pointSigma), lclSeries: sigmaSeries.map(pointSigma => mean - 3 * pointSigma), sigmaSeries, chartValues: ewmaValues };
};

// Process data for histogram
export const prepareHistogramData = (data: number[]): { bins: number[], counts: number[] } => {
  // Calculate suggested number of bins (Sturges' formula)
  const binCount = Math.ceil(1 + 3.322 * Math.log10(data.length));
  
  // Calculate bin width
  const min = data.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const max = data.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  const binWidth = (max - min) / binCount;
  
  // Create bins
  const bins: number[] = [];
  for (let i = 0; i <= binCount; i++) {
    bins.push(min + i * binWidth);
  }
  
  // Count data points in each bin
  const counts = new Array(binCount).fill(0);
  data.forEach(value => {
    // Skip the max value to avoid out of bounds
    if (value === max) {
      counts[binCount - 1]++;
      return;
    }
    
    const binIndex = Math.floor((value - min) / binWidth);
    counts[binIndex]++;
  });
  
  return { bins, counts };
};

// Multi-column X-bar charts treat each row as one rational subgroup.
export const calculateControlLimits = (
  data: DataPoint[], column: string, chartType: ChartType, sampleSize: number,
  denominatorColumn?: string | null, subgroupColumns?: string[],
): ControlLimits => {
  const series = numericSeriesFromRows(data, column);
  const clean = series.filter(Number.isFinite);
  const denominators = positiveDenominatorsFromRows(data, denominatorColumn);
  switch (chartType) {
    case 'individual': return calculateIndividualControlLimits(series);
    case 'pChart': return calculatePChartLimits(series, sampleSize, denominators);
    case 'npChart': return calculateNPChartLimits(series, denominatorColumn ? NaN : sampleSize);
    case 'cChart': return calculateCChartLimits(series);
    case 'uChart': return calculateUChartLimits(series, sampleSize, denominators);
    case 'xBarS':
    case 'xBarR': {
      const columns = subgroupColumns && subgroupColumns.length > 1 ? subgroupColumns : undefined;
      const effectiveSize = columns ? columns.length : sampleSize;
      const groups = columns ? data.map(row => columns.map(name => parseSpcNumber(row[name]))) : splitSubgroups(series, effectiveSize);
      return summarizeSubgroups(groups, effectiveSize, chartType).controlLimits;
    }
    case 'ewma': return calculateEWMALimits(series);
    case 'histogram':
    case 'scatterPlot': {
      const mean = calculateMean(clean);
      const sigma = calculateStandardDeviation(clean);
      return { ucl: mean + 3 * sigma, lcl: mean - 3 * sigma, centerLine: mean, sigma, chartValues: series };
    }
    default: throw new Error(`Unsupported chart type: ${chartType}`);
  }
};

// The baseline mean is the default initial EWMA value (z0).
export const calculateEWMAValues = (data: number[], lambda = 0.2, initialValue = calculateMean(data.filter(Number.isFinite))): number[] => {
  let previous = initialValue;
  return data.map(value => {
    if (!Number.isFinite(value)) return NaN;
    if (!Number.isFinite(initialValue) || !Number.isFinite(lambda) || lambda <= 0 || lambda > 1) return NaN;
    previous = lambda * value + (1 - lambda) * previous;
    return previous;
  });
};
