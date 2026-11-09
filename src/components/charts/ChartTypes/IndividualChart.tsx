import React from 'react';
import { useAppContext } from '../../../context/AppContext';
import ControlChartView from '../ControlChartView';
import VariationChartView from '../VariationChartView';
import { buildAxisLabels } from '../chartSeries';

const IndividualChart: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, xAxisColumn } = useAppContext();

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }

  const { controlLimits, ruleViolations, data } = processedData;
  const values = controlLimits.chartValues ?? [];
  const labels = buildAxisLabels(data, xAxisColumn, values.length);
  const xAxisTitle = chartOptions.xAxisLabel || 'Sample';

  return (
    <div className="space-y-6">
      <ControlChartView
        title={chartOptions.title || 'Individuals (I) Chart'}
        xAxisTitle={xAxisTitle}
        yAxisTitle={chartOptions.yAxisLabel || 'Value'}
        seriesLabel={selectedColumns[0]}
        labels={labels}
        values={values}
        centerLine={controlLimits.centerLine}
        ucl={controlLimits.ucl}
        lcl={controlLimits.lcl}
        sigma={controlLimits.sigma}
        centerLabel="Center Line"
        uclLabel="+3σ (UCL)"
        lclLabel="-3σ (LCL)"
        violations={ruleViolations}
        decimals={2}
      />
      <VariationChartView
        title="Moving Range (mR) Chart"
        xAxisTitle={xAxisTitle}
        yAxisTitle="Moving Range"
        seriesLabel="Moving Range (mR)"
        centerLabel="Center Line (MR̄)"
        uclLabel="UCL (mR)"
        lclLabel="LCL (mR)"
        color="rgba(153, 102, 255, 0.9)"
        labelColumn={xAxisColumn}
      />
    </div>
  );
};

export default IndividualChart;
