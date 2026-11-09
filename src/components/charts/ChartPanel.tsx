import React from 'react';
import { useAppContext } from '../../context/AppContext';
import { useLanguage } from '../../context/LanguageContext';
import IndividualChart from './ChartTypes/IndividualChart';
import PChart from './ChartTypes/PChart';
import NPChart from './ChartTypes/NPChart';
import CChart from './ChartTypes/CChart';
import UChart from './ChartTypes/UChart';
import XBarSChart from './ChartTypes/XBarSChart';
import XBarRChart from './ChartTypes/XBarRChart';
import EWMAChart from './ChartTypes/EWMAChart';
import Histogram from './ChartTypes/Histogram';
import ScatterPlot from './ChartTypes/ScatterPlot';
import ChartActions from './ChartActions';
import CapabilityPanel from './CapabilityPanel';

const ChartPanel: React.FC = () => {
  const {
    selectedChartType,
    processedData,
    chartOptions,
    isProcessing,
    selectedColumns,
  } = useAppContext();
  const { t } = useLanguage();

  const formatStat = (value: number, decimals = 3): string => {
    return Number.isFinite(value) ? value.toFixed(decimals) : '-';
  };

  if (isProcessing) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500" role="status">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500 mb-2"></div>
        <p>{t('chartPanel.processing')}</p>
      </div>
    );
  }

  if (!processedData || selectedColumns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <p>{t('chartPanel.selectData')}</p>
      </div>
    );
  }

  const renderChart = () => {
    switch (selectedChartType) {
      case 'individual':
        return <IndividualChart />;
      case 'pChart':
        return <PChart />;
      case 'npChart':
        return <NPChart />;
      case 'cChart':
        return <CChart />;
      case 'uChart':
        return <UChart />;
      case 'xBarS':
        return <XBarSChart />;
      case 'xBarR':
        return <XBarRChart />;
      case 'ewma':
        return <EWMAChart />;
      case 'histogram':
        return <Histogram />;
      case 'scatterPlot':
        return <ScatterPlot />;
      default:
        return <IndividualChart />;
    }
  };
  const { centerLine, ucl, lcl, sigma, processSigma } = processedData.controlLimits;
  // Shown only when it differs: X-bar charts plot subgroup means, so their σ is a standard error.
  const showProcessSigma = typeof processSigma === 'number' && Number.isFinite(processSigma)
    && Math.abs(processSigma - sigma) > 1e-12;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-medium text-gray-800">
          {chartOptions.title || 'SPC Chart'}
        </h2>
        <ChartActions />
      </div>

      <div className="rounded-lg border border-gray-100 p-4">
        {renderChart()}
      </div>

      <div className={`mt-4 grid grid-cols-1 gap-4 ${showProcessSigma ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
        <div className="bg-blue-50 rounded-md p-3">
          <p className="text-xs text-blue-800 font-medium">{t('chartPanel.mean')}</p>
          <p className="text-lg font-semibold tabular-nums">{formatStat(centerLine)}</p>
        </div>
        <div className="bg-red-50 rounded-md p-3">
          <p className="text-xs text-red-800 font-medium">{t('chartPanel.ucl')}</p>
          <p className="text-lg font-semibold tabular-nums">{formatStat(ucl)}</p>
        </div>
        <div className="bg-red-50 rounded-md p-3">
          <p className="text-xs text-red-800 font-medium">{t('chartPanel.lcl')}</p>
          <p className="text-lg font-semibold tabular-nums">{formatStat(lcl)}</p>
        </div>
        <div className="bg-purple-50 rounded-md p-3" title={t('chartPanel.sigmaPlottedHint')}>
          <p className="text-xs text-purple-800 font-medium">{t('chartPanel.sigmaPlotted')}</p>
          <p className="text-lg font-semibold tabular-nums">{formatStat(sigma)}</p>
          <p className="mt-0.5 text-[11px] text-purple-900">{t('chartPanel.sigmaPlottedHint')}</p>
        </div>
        {showProcessSigma && (
          <div className="bg-purple-50 rounded-md p-3" title={t('chartPanel.sigmaProcessHint')}>
            <p className="text-xs text-purple-800 font-medium">{t('chartPanel.sigmaProcess')}</p>
            <p className="text-lg font-semibold tabular-nums">{formatStat(processSigma as number)}</p>
            <p className="mt-0.5 text-[11px] text-purple-900">{t('chartPanel.sigmaProcessHint')}</p>
          </div>
        )}
      </div>

      <CapabilityPanel />
    </div>
  );
};

export default ChartPanel;
