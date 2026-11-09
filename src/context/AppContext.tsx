import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { ChartType, DataSet, ProcessedData, ChartOptions, Sheet, DataSelectionRange } from '../types/DataTypes';
import { calculateCapabilityStatus, calculateControlLimits } from '../utils/spcCalculations';
import { detectRuleViolations } from '../utils/westernElectricRules';
import { buildSpcDiagnostics } from '../utils/spcDiagnostics';

interface AppContextType {
  rawData: DataSet | null;
  setRawData: (data: DataSet | null) => void;
  setActiveSheetIndex: (index: number) => void;
  addSheet: (name?: string) => void;
  copySheet: (index: number) => void;
  removeSheet: (index: number) => void;
  moveSheet: (from: number, to: number) => void;
  renameSheet: (index: number, name: string) => void;
  processedData: ProcessedData | null;
  selectedChartType: ChartType;
  setSelectedChartType: (type: ChartType) => void;
  chartOptions: ChartOptions;
  setChartOptions: (options: ChartOptions) => void;
  isDataLoaded: boolean;
  isProcessing: boolean;
  selectedColumns: string[];
  setSelectedColumns: (columns: string[]) => void;
  xAxisColumn: string | null;
  setXAxisColumn: (col: string | null) => void;
  denominatorColumn: string | null;
  setDenominatorColumn: (col: string | null) => void;
  selectedDataRange: DataSelectionRange | null;
  setSelectedDataRange: (range: DataSelectionRange | null) => void;
  sampleSize: number;
  setSampleSize: (size: number) => void;
  errorMessage: string | null;
  setErrorMessage: (message: string | null) => void;
  resetData: () => void;
}

const defaultChartOptions: ChartOptions = {
  title: 'SPC Analysis Chart',
  xAxisLabel: 'Sample',
  yAxisLabel: 'Value',
  lowerSpecLimit: null,
  upperSpecLimit: null,
  targetValue: null,
  showControlLimits: true,
  showCenterLine: true,
  showRuleViolations: true,
  colorScheme: 'default',
  showSigma1: true,
  showSigma2: true,
  showSigma3: true,
};

export const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppContextProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [rawData, setRawData] = useState<DataSet | null>(null);
  const [processedData, setProcessedData] = useState<ProcessedData | null>(null);
  const [selectedChartType, setSelectedChartType] = useState<ChartType>('individual');
  const [chartOptions, setChartOptions] = useState<ChartOptions>(defaultChartOptions);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [xAxisColumn, setXAxisColumn] = useState<string | null>(null);
  const [denominatorColumn, setDenominatorColumn] = useState<string | null>(null);
  const [selectedDataRange, setSelectedDataRange] = useState<DataSelectionRange | null>(null);
  const [sampleSize, setSampleSize] = useState<number>(5);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isDataLoaded = rawData !== null && rawData.data.length > 0;

  useEffect(() => {
    if (rawData && selectedColumns.length > 0) {
      processData();
    } else {
      setProcessedData(null);
    }
  }, [
    rawData,
    selectedColumns,
    selectedChartType,
    sampleSize,
    selectedDataRange,
    xAxisColumn,
    denominatorColumn,
    chartOptions.lowerSpecLimit,
    chartOptions.upperSpecLimit,
    chartOptions.targetValue,
    chartOptions.ruleSet,
  ]);

  useEffect(() => {
    if (!rawData) {
      if (selectedColumns.length > 0) setSelectedColumns([]);
      if (xAxisColumn !== null) setXAxisColumn(null);
      if (denominatorColumn !== null) setDenominatorColumn(null);
      return;
    }

    const availableHeaders = new Set(rawData.headers);
    const filteredSelectedColumns = selectedColumns.filter((column) => availableHeaders.has(column));
    if (filteredSelectedColumns.length !== selectedColumns.length) {
      setSelectedColumns(filteredSelectedColumns);
    }

    if (xAxisColumn && !availableHeaders.has(xAxisColumn)) {
      setXAxisColumn(null);
    }
    if (denominatorColumn && !availableHeaders.has(denominatorColumn)) {
      setDenominatorColumn(null);
    }
  }, [rawData, selectedColumns, xAxisColumn, denominatorColumn]);

  const processData = async () => {
    if (!rawData || selectedColumns.length === 0) return;

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      const isXbarChart = selectedChartType === 'xBarR' || selectedChartType === 'xBarS';

      const totalRows = rawData.data.length;
      const totalCols = rawData.headers.length;

      const rowStart = selectedDataRange ? Math.max(0, Math.min(selectedDataRange.startRow, selectedDataRange.endRow)) : 0;
      const rowEnd = selectedDataRange ? Math.min(totalRows - 1, Math.max(selectedDataRange.startRow, selectedDataRange.endRow)) : totalRows - 1;
      const colStart = selectedDataRange ? Math.max(0, Math.min(selectedDataRange.startCol, selectedDataRange.endCol)) : 0;
      const colEnd = selectedDataRange ? Math.min(totalCols - 1, Math.max(selectedDataRange.startCol, selectedDataRange.endCol)) : totalCols - 1;

      const rangeHeaders = rawData.headers.slice(colStart, colEnd + 1);
      const effectiveSelectedColumns = selectedColumns.filter((column) => rangeHeaders.includes(column));

      if (effectiveSelectedColumns.length === 0) {
        setProcessedData(null);
        setErrorMessage('Selected table range does not include the current Y column(s).');
        return;
      }

      const xAxisInRange = xAxisColumn && rangeHeaders.includes(xAxisColumn) ? xAxisColumn : null;
      const denominatorInRange = denominatorColumn && rangeHeaders.includes(denominatorColumn) ? denominatorColumn : null;
      const projectionColumns = Array.from(new Set([
        ...effectiveSelectedColumns,
        ...(xAxisInRange ? [xAxisInRange] : []),
        ...(denominatorInRange ? [denominatorInRange] : []),
      ]));

      const scopedRows = rawData.data.slice(rowStart, rowEnd + 1);

      // Extract only the selected columns from the selected row range
      const filteredData = scopedRows.map(row => {
        const newRow: Record<string, any> = {};
        projectionColumns.forEach(col => {
          newRow[col] = row[col];
        });
        return newRow;
      });

      if (filteredData.length === 0) {
        setProcessedData(null);
        setErrorMessage('Selected table range is empty.');
        return;
      }

      const selectedColumn = effectiveSelectedColumns[0];
      const effectiveSampleSize = isXbarChart && effectiveSelectedColumns.length > 1 ? effectiveSelectedColumns.length : sampleSize;
      const diagnosticsResult = buildSpcDiagnostics({
        rows: filteredData,
        column: selectedColumn,
        denominatorColumn: denominatorInRange,
        xAxisColumn: xAxisInRange,
        chartType: selectedChartType,
        sampleSize: effectiveSampleSize,
        selectedColumns: effectiveSelectedColumns,
      });

      const controlLimits = calculateControlLimits(
        filteredData, selectedColumn, selectedChartType, effectiveSampleSize, denominatorInRange,
        isXbarChart ? effectiveSelectedColumns : undefined,
      );
      if (controlLimits.processSigma === 0) {
        diagnosticsResult.diagnostics.push({ severity: 'warning', code: 'zero-within-variation', message: 'Within-process variation is zero; Cp and Cpk cannot be estimated.' });
      }
      const chartedValues = controlLimits.chartValues ?? [];
      const series = chartedValues.map(v => ({ v }));
      const ruleSet = chartOptions.ruleSet ?? 'nelson';
      const violations = ['histogram', 'scatterPlot'].includes(selectedChartType)
        ? []
        : detectRuleViolations(series, 'v', controlLimits, ruleSet, selectedChartType === 'ewma' ? { ruleNumbers: [1] } : {});
      const variationChart = controlLimits.variationChart;
      const variationRuleViolations = variationChart
        ? detectRuleViolations(variationChart.chartValues.map(v => ({ v })), 'v', variationChart, ruleSet, { ruleNumbers: [1] })
        : [];
      const capabilityValues = controlLimits.capabilityValues ?? diagnosticsResult.numericValues;
      const capabilityMean = capabilityValues.length
        ? capabilityValues.reduce((sum, value) => sum + value, 0) / capabilityValues.length
        : NaN;
      const capabilityStatus = calculateCapabilityStatus(
        capabilityValues, capabilityMean, controlLimits.processSigma ?? NaN,
        { lowerSpecLimit: chartOptions.lowerSpecLimit, upperSpecLimit: chartOptions.upperSpecLimit, targetValue: chartOptions.targetValue },
        { chartType: selectedChartType, dataProfile: diagnosticsResult.profile, ruleViolations: [...violations, ...variationRuleViolations], sigmaMethod: controlLimits.sigmaMethod, diagnostics: diagnosticsResult.diagnostics },
      );
      const finiteStatsValues = chartedValues.filter(Number.isFinite);

      setProcessedData({
        data: filteredData,
        controlLimits,
        ruleViolations: violations,
        variationRuleViolations,
        statistics: {
          mean: controlLimits.centerLine,
          standardDeviation: controlLimits.sigma,
          min: finiteStatsValues.length ? finiteStatsValues.reduce((minimum, value) => Math.min(minimum, value), Infinity) : Number.NaN,
          max: finiteStatsValues.length ? finiteStatsValues.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : Number.NaN,
          count: finiteStatsValues.length,
        },
        dataProfile: diagnosticsResult.profile,
        diagnostics: diagnosticsResult.diagnostics,
        chartRecommendations: diagnosticsResult.recommendations,
        capabilityStatus,
      });
    } catch (error) {
      console.error('Error processing data:', error);
      setProcessedData(null);
      setErrorMessage('Error processing data. Please check your data format and selected columns.');
    } finally {
      setIsProcessing(false);
    }
  };

  const resetData = () => {
    setRawData(null);
    setProcessedData(null);
    setSelectedColumns([]);
    setXAxisColumn(null);
    setDenominatorColumn(null);
    setSelectedDataRange(null);
    setErrorMessage(null);
  };

  const value = {
    rawData,
    setRawData,
    setActiveSheetIndex: (index: number) => {
      setRawData(prev => {
        if (!prev || !prev.sheets) return prev;
        if (index < 0 || index >= prev.sheets.length) return prev;
        const sheet = prev.sheets[index];
        return { ...prev, activeSheetIndex: index, data: sheet.data, headers: sheet.headers };
      });
    },
    addSheet: (name?: string) => {
      setRawData(prev => {
        if (!prev) return prev;
        const sheets: Sheet[] = prev.sheets ? [...prev.sheets] : [{ name: 'Sheet1', data: prev.data, headers: prev.headers }];
        const base = name || 'Sheet';
        let counter = 1;
        let newName = `${base}${counter}`;
        const existingNames = new Set(sheets.map(s => s.name));
        while (existingNames.has(newName)) {
          counter++;
          newName = `${base}${counter}`;
        }
        const newSheet: Sheet = { name: newName, data: [], headers: [] };
        sheets.push(newSheet);
        return { ...prev, sheets, activeSheetIndex: sheets.length - 1, data: newSheet.data, headers: newSheet.headers };
      });
    },
    copySheet: (index: number) => {
      setRawData(prev => {
        if (!prev) return prev;
        const sheets: Sheet[] = prev.sheets ? [...prev.sheets] : [{ name: 'Sheet1', data: prev.data, headers: prev.headers }];
        if (index < 0 || index >= sheets.length) return prev;
        const src = sheets[index];
        let copyName = `${src.name} Copy`;
        let i = 2;
        const existing = new Set(sheets.map(s => s.name));
        while (existing.has(copyName)) {
          copyName = `${src.name} Copy ${i++}`;
        }
        const newSheet: Sheet = { name: copyName, headers: [...src.headers], data: src.data.map(r => ({ ...r })) };
        sheets.splice(index + 1, 0, newSheet);
        return { ...prev, sheets, activeSheetIndex: index + 1, data: newSheet.data, headers: newSheet.headers };
      });
    },
    removeSheet: (index: number) => {
      setRawData(prev => {
        if (!prev) return prev;
        const sheets: Sheet[] = prev.sheets ? [...prev.sheets] : [{ name: 'Sheet1', data: prev.data, headers: prev.headers }];
        if (sheets.length === 1) return prev; // keep at least one
        if (index < 0 || index >= sheets.length) return prev;
        sheets.splice(index, 1);
        const newActive = Math.min(index, sheets.length - 1);
        const activeSheet = sheets[newActive];
        return { ...prev, sheets, activeSheetIndex: newActive, data: activeSheet.data, headers: activeSheet.headers };
      });
    },
    moveSheet: (from: number, to: number) => {
      setRawData(prev => {
        if (!prev || !prev.sheets) return prev;
        const sheets = [...prev.sheets];
        if (from < 0 || from >= sheets.length || to < 0 || to >= sheets.length) return prev;
        const [moved] = sheets.splice(from, 1);
        sheets.splice(to, 0, moved);
        let active = prev.activeSheetIndex ?? 0;
        if (active === from) active = to;
        else if (from < active && to >= active) active -= 1;
        else if (from > active && to <= active) active += 1;
        const sheet = sheets[active];
        return { ...prev, sheets, activeSheetIndex: active, data: sheet.data, headers: sheet.headers };
      });
    },
    renameSheet: (index: number, name: string) => {
      setRawData(prev => {
        if (!prev || !prev.sheets) return prev;
        if (!name.trim()) return prev;
        const sheets = prev.sheets.map((s, i) => (i === index ? { ...s, name } : s));
        return { ...prev, sheets };
      });
    },
    processedData,
    selectedChartType,
    setSelectedChartType,
    chartOptions,
    setChartOptions,
    isDataLoaded,
    isProcessing,
    selectedColumns,
    setSelectedColumns,
    xAxisColumn,
    setXAxisColumn,
    denominatorColumn,
    setDenominatorColumn,
    selectedDataRange,
    setSelectedDataRange,
    sampleSize,
    setSampleSize,
    errorMessage,
    setErrorMessage,
    resetData,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useAppContext = (): AppContextType => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppContextProvider');
  }
  return context;
};
