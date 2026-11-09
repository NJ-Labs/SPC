import React from 'react';
import { useAppContext } from '../../../context/AppContext';
import ControlChartView from '../ControlChartView';
import VariationChartView from '../VariationChartView';
import { buildAxisLabels } from '../chartSeries';

const XBarSChart: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, sampleSize, xAxisColumn } = useAppContext();

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }

  const { controlLimits, ruleViolations, data } = processedData;
  // Subgroup means from the shared calculation; the chart never regroups or drops rows itself.
  const subgroupMeans = controlLimits.chartValues ?? [];
  const multiColumn = selectedColumns.length > 1;
  const subgroupSize = multiColumn ? selectedColumns.length : sampleSize;
  const labelColumn = multiColumn ? xAxisColumn : null;
  const xAxisTitle = chartOptions.xAxisLabel || 'Subgroup';

  return (
    <div className="space-y-6">
      <ControlChartView
        title={chartOptions.title || `X-bar Chart (n=${subgroupSize})`}
        xAxisTitle={xAxisTitle}
        yAxisTitle={chartOptions.yAxisLabel || 'Subgroup Mean (X̄)'}
        seriesLabel="Subgroup Mean (X-bar)"
        labels={buildAxisLabels(data, labelColumn, subgroupMeans.length)}
        values={subgroupMeans}
        centerLine={controlLimits.centerLine}
        ucl={controlLimits.ucl}
        lcl={controlLimits.lcl}
        sigma={controlLimits.sigma}
        centerLabel="Center Line"
        uclLabel="UCL"
        lclLabel="LCL"
        violations={ruleViolations}
        color="rgba(54, 162, 235, 0.9)"
      />
      <VariationChartView
        title={`S Chart (n=${subgroupSize})`}
        xAxisTitle={xAxisTitle}
        yAxisTitle="Subgroup Std Dev (S)"
        seriesLabel="Subgroup Std Dev (S)"
        centerLabel="Center Line (S̄)"
        uclLabel="UCL (S)"
        lclLabel="LCL (S)"
        color="rgba(255, 159, 64, 0.9)"
        labelColumn={labelColumn}
      />
    </div>
  );
};

export default XBarSChart;
