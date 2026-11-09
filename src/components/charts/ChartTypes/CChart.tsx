import React from 'react';
import { useAppContext } from '../../../context/AppContext';
import ControlChartView from '../ControlChartView';
import { buildAxisLabels } from '../chartSeries';

const CChart: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, xAxisColumn } = useAppContext();

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }

  const { controlLimits, ruleViolations, data } = processedData;
  const values = controlLimits.chartValues ?? [];

  return (
    <ControlChartView
      title={chartOptions.title || 'C Chart (Defects)'}
      xAxisTitle={chartOptions.xAxisLabel || 'Sample'}
      yAxisTitle={chartOptions.yAxisLabel || 'Defect Count'}
      seriesLabel="Defect Count"
      labels={buildAxisLabels(data, xAxisColumn, values.length)}
      values={values}
      centerLine={controlLimits.centerLine}
      ucl={controlLimits.ucl}
      lcl={controlLimits.lcl}
      sigma={controlLimits.sigma}
      centerLabel="Center Line (c-bar)"
      uclLabel="UCL"
      lclLabel="LCL"
      violations={ruleViolations}
      decimals={0}
      lowerFloor={0}
      yMin={0}
    />
  );
};

export default CChart;
