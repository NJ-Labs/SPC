import React from 'react';
import { useAppContext } from '../../context/AppContext';
import ControlChartView from './ControlChartView';
import { buildAxisLabels } from './chartSeries';

interface VariationChartViewProps {
  title: string;
  xAxisTitle: string;
  yAxisTitle: string;
  seriesLabel: string;
  centerLabel: string;
  uclLabel: string;
  lclLabel: string;
  color?: string;
  /** Plot subgroup labels from the rows instead of subgroup numbers. */
  labelColumn?: string | null;
}

/** MR / R / S chart straight from the shared `variationChart`; renders nothing when the chart has none. */
const VariationChartView: React.FC<VariationChartViewProps> = ({ labelColumn = null, ...props }) => {
  const { processedData } = useAppContext();
  const variation = processedData?.controlLimits.variationChart;
  if (!processedData || !variation) return null;

  return (
    <ControlChartView
      {...props}
      labels={buildAxisLabels(processedData.data, labelColumn, variation.chartValues.length)}
      values={variation.chartValues}
      centerLine={variation.centerLine}
      ucl={variation.ucl}
      lcl={variation.lcl}
      sigma={variation.sigma}
      violations={processedData.variationRuleViolations ?? []}
      lowerFloor={0}
      yMin={0}
    />
  );
};

export default VariationChartView;
