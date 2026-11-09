import React from 'react';
import { useAppContext } from '../../../context/AppContext';
import ControlChartView from '../ControlChartView';
import { buildAxisLabels } from '../chartSeries';

const UChart: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, xAxisColumn } = useAppContext();

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }

  const { controlLimits, ruleViolations, data } = processedData;
  const values = controlLimits.chartValues ?? [];

  return (
    <ControlChartView
      title={chartOptions.title || 'U Chart (Defects per Unit)'}
      xAxisTitle={chartOptions.xAxisLabel || 'Sample'}
      yAxisTitle={chartOptions.yAxisLabel || 'Defects per Unit'}
      seriesLabel="Defects per Unit"
      labels={buildAxisLabels(data, xAxisColumn, values.length)}
      values={values}
      centerLine={controlLimits.centerLine}
      ucl={controlLimits.ucl}
      lcl={controlLimits.lcl}
      sigma={controlLimits.sigma}
      uclSeries={controlLimits.uclSeries}
      lclSeries={controlLimits.lclSeries}
      sigmaSeries={controlLimits.sigmaSeries}
      centerLabel="Center Line (u-bar)"
      uclLabel="UCL"
      lclLabel="LCL"
      violations={ruleViolations}
      decimals={4}
      lowerFloor={0}
      yMin={0}
    />
  );
};

export default UChart;
