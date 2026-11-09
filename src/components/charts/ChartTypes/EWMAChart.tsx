import React from 'react';
import { useAppContext } from '../../../context/AppContext';
import { parseSpcNumber } from '../../../utils/spcCalculations';
import ControlChartView from '../ControlChartView';
import VariationChartView from '../VariationChartView';
import { buildAxisLabels } from '../chartSeries';

const EWMA_LAMBDA = 0.2;

const EWMAChart: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, xAxisColumn } = useAppContext();

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }

  const { controlLimits, ruleViolations, data } = processedData;
  const ewmaValues = controlLimits.chartValues ?? [];
  // Raw overlay keeps row positions (invalid cells stay gaps) so it lines up with the EWMA series.
  const rawValues = data.map((row) => parseSpcNumber(row[selectedColumns[0]]));
  const xAxisTitle = chartOptions.xAxisLabel || 'Sample';

  return (
    <div className="space-y-6">
      <ControlChartView
        title={chartOptions.title || `EWMA Chart (λ=${EWMA_LAMBDA})`}
        xAxisTitle={xAxisTitle}
        yAxisTitle={chartOptions.yAxisLabel || 'EWMA Value'}
        seriesLabel="EWMA"
        labels={buildAxisLabels(data, xAxisColumn, ewmaValues.length)}
        values={ewmaValues}
        centerLine={controlLimits.centerLine}
        ucl={controlLimits.ucl}
        lcl={controlLimits.lcl}
        sigma={controlLimits.sigma}
        uclSeries={controlLimits.uclSeries}
        lclSeries={controlLimits.lclSeries}
        sigmaSeries={controlLimits.sigmaSeries}
        centerLabel="Center Line"
        uclLabel="UCL"
        lclLabel="LCL"
        violations={ruleViolations}
        color="rgba(75, 192, 192, 0.8)"
        overlay={{ label: 'Raw Data', values: rawValues }}
        height={400}
        footer={(
          <p className="text-xs text-gray-600">
            EWMA (λ={EWMA_LAMBDA}): Exponentially Weighted Moving Average with weighting factor λ. Only points beyond the limits are tested, because EWMA points are correlated.
          </p>
        )}
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

export default EWMAChart;
