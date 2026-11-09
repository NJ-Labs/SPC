import React from 'react';
import { useAppContext } from '../../../context/AppContext';
import ControlChartView from '../ControlChartView';
import { buildAxisLabels } from '../chartSeries';

const PChart: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, xAxisColumn } = useAppContext();

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }

  const { controlLimits, ruleViolations, data } = processedData;
  const values = controlLimits.chartValues ?? [];

  return (
    <ControlChartView
      title={chartOptions.title || 'P Chart (Proportion)'}
      xAxisTitle={chartOptions.xAxisLabel || 'Sample Group'}
      yAxisTitle={chartOptions.yAxisLabel || 'Proportion'}
      seriesLabel="Proportion"
      labels={buildAxisLabels(data, xAxisColumn, values.length)}
      values={values}
      centerLine={controlLimits.centerLine}
      ucl={controlLimits.ucl}
      lcl={controlLimits.lcl}
      sigma={controlLimits.sigma}
      uclSeries={controlLimits.uclSeries}
      lclSeries={controlLimits.lclSeries}
      sigmaSeries={controlLimits.sigmaSeries}
      centerLabel="Center Line (p)"
      uclLabel="+3σ (UCL)"
      lclLabel="-3σ (LCL)"
      violations={ruleViolations}
      decimals={4}
      lowerFloor={0}
      yMin={0}
      height={400}
    />
  );
};

export default PChart;
