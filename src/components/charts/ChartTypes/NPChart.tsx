import React from 'react';
import { useAppContext } from '../../../context/AppContext';
import ControlChartView from '../ControlChartView';
import { buildAxisLabels } from '../chartSeries';

const NPChart: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, xAxisColumn } = useAppContext();

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }

  const { controlLimits, ruleViolations, data } = processedData;
  const values = controlLimits.chartValues ?? [];

  return (
    <ControlChartView
      title={chartOptions.title || 'NP Chart (Nonconforming Units)'}
      xAxisTitle={chartOptions.xAxisLabel || 'Sample Group'}
      yAxisTitle={chartOptions.yAxisLabel || 'Nonconforming Units'}
      seriesLabel="Nonconforming Units"
      labels={buildAxisLabels(data, xAxisColumn, values.length)}
      values={values}
      centerLine={controlLimits.centerLine}
      ucl={controlLimits.ucl}
      lcl={controlLimits.lcl}
      sigma={controlLimits.sigma}
      centerLabel="Center Line (np)"
      uclLabel="+3σ (UCL)"
      lclLabel="-3σ (LCL)"
      violations={ruleViolations}
      decimals={0}
      lowerFloor={0}
      yMin={0}
      height={400}
    />
  );
};

export default NPChart;
