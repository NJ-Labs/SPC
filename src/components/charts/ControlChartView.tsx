import React, { useMemo, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions as ChartJsOptions,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useAppContext } from '../../context/AppContext';
import { resetChartView } from './chartView';
import type { RuleViolation } from '../../types/DataTypes';
import {
  constantLine,
  describeViolation,
  formatPlotted,
  groupViolationsByIndex,
  pointwiseLine,
  toPlotValues,
  zoneLine,
} from './chartSeries';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, zoomPlugin);

export interface ControlChartViewProps {
  title: string;
  xAxisTitle: string;
  yAxisTitle: string;
  seriesLabel: string;
  labels: string[];
  /** The shared plotted series; NaN marks a gap and keeps its position. */
  values: readonly number[];
  centerLine: number;
  ucl: number;
  lcl: number;
  sigma: number;
  uclSeries?: readonly number[];
  lclSeries?: readonly number[];
  sigmaSeries?: readonly number[];
  centerLabel: string;
  uclLabel: string;
  lclLabel: string;
  violations: readonly RuleViolation[];
  decimals?: number;
  /** Lower zone lines stop here (counts and proportions cannot go below zero). */
  lowerFloor?: number;
  yMin?: number;
  color?: string;
  /** Faint overlay such as the raw data under an EWMA line. */
  overlay?: { label: string; values: readonly number[] };
  footer?: React.ReactNode;
  height?: number;
}

const FLAGGED_COLOR = '#dc2626';
const NO_FLAGGED: ReadonlySet<number> = new Set<number>();

const ControlChartView: React.FC<ControlChartViewProps> = ({
  title, xAxisTitle, yAxisTitle, seriesLabel, labels, values, centerLine, ucl, lcl, sigma,
  uclSeries, lclSeries, sigmaSeries, centerLabel, uclLabel, lclLabel, violations,
  decimals = 3, lowerFloor, yMin, color = 'rgba(54, 162, 235, 0.8)', overlay, footer, height = 320,
}) => {
  const { chartOptions } = useAppContext();
  const chartRef = useRef<ChartJS<'line'> | null>(null);
  const length = values.length;

  // A Set of indexes is all the point styling needs; the per-index violation lists are built on first hover.
  const flaggedIndexes = useMemo(() => new Set(violations.map((violation) => violation.index)), [violations]);
  const flagged = chartOptions.showRuleViolations ? flaggedIndexes : NO_FLAGGED;
  const lookupRef = useRef<{ source: readonly RuleViolation[]; byIndex: Map<number, RuleViolation[]> } | null>(null);
  const violationsAt = (index: number): RuleViolation[] => {
    if (lookupRef.current?.source !== violations) {
      lookupRef.current = { source: violations, byIndex: groupViolationsByIndex(violations) };
    }
    return lookupRef.current.byIndex.get(index) ?? [];
  };
  const plotted = useMemo(() => toPlotValues(values), [values]);
  const plottedCount = plotted.filter((value) => value !== null).length;

  const data = useMemo<ChartData<'line', Array<number | null>>>(() => {
    const sigmaValues = pointwiseLine(sigmaSeries, sigma, length);
    const upper = pointwiseLine(uclSeries, ucl, length);
    const lower = pointwiseLine(lclSeries, lcl, length);
    const line = (label: string, points: Array<number | null>, borderColor: string, borderWidth: number, dash: number[]) => ({
      label,
      data: points,
      borderColor,
      borderWidth,
      borderDash: dash,
      pointRadius: 0,
      fill: false,
    });
    return {
      labels,
      datasets: [
        {
          label: seriesLabel,
          data: plotted,
          borderColor: color,
          // Scriptable so a long series does not carry four per-point arrays.
          backgroundColor: (context: { dataIndex: number }) => (flagged.has(context.dataIndex) ? FLAGGED_COLOR : color),
          pointBackgroundColor: (context: { dataIndex: number }) => (flagged.has(context.dataIndex) ? FLAGGED_COLOR : color),
          pointBorderColor: (context: { dataIndex: number }) => (flagged.has(context.dataIndex) ? FLAGGED_COLOR : color),
          pointRadius: (context: { dataIndex: number }) => (flagged.has(context.dataIndex) ? 6 : 4),
          pointHoverRadius: 7,
          tension: 0.1,
          spanGaps: false,
        },
        ...(overlay ? [{
          label: overlay.label,
          data: toPlotValues(overlay.values),
          borderColor: 'rgba(169, 169, 169, 0.4)',
          backgroundColor: 'rgba(169, 169, 169, 0.15)',
          borderDash: [2, 2],
          pointRadius: 2,
          pointHoverRadius: 3,
          tension: 0.1,
        }] : []),
        ...(chartOptions.showCenterLine
          ? [line(centerLabel, constantLine(length, centerLine), 'rgba(75, 192, 192, 0.9)', 2, [6, 6])]
          : []),
        ...(chartOptions.showSigma1 ? [
          line('+1σ', zoneLine(centerLine, sigmaValues, 1, 1), 'rgba(255, 205, 86, 0.7)', 1, [2, 2]),
          line('-1σ', zoneLine(centerLine, sigmaValues, 1, -1, lowerFloor), 'rgba(255, 205, 86, 0.7)', 1, [2, 2]),
        ] : []),
        ...(chartOptions.showSigma2 ? [
          line('+2σ', zoneLine(centerLine, sigmaValues, 2, 1), 'rgba(255, 159, 64, 0.7)', 1, [3, 3]),
          line('-2σ', zoneLine(centerLine, sigmaValues, 2, -1, lowerFloor), 'rgba(255, 159, 64, 0.7)', 1, [3, 3]),
        ] : []),
        ...((chartOptions.showControlLimits || chartOptions.showSigma3) ? [
          line(uclLabel, upper, 'rgba(255, 99, 132, 0.9)', 2, [5, 5]),
          line(lclLabel, lower, 'rgba(255, 99, 132, 0.9)', 2, [5, 5]),
        ] : []),
      ],
    };
  }, [
    centerLabel, centerLine, chartOptions.showCenterLine, chartOptions.showControlLimits, chartOptions.showSigma1,
    chartOptions.showSigma2, chartOptions.showSigma3, color, flagged, labels, lclLabel, lclSeries, lcl, length, lowerFloor,
    overlay, plotted, seriesLabel, sigma, sigmaSeries, uclLabel, uclSeries, ucl,
  ]);

  const options = useMemo<ChartJsOptions<'line'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' },
      title: { display: true, text: title, font: { size: 16 } },
      tooltip: {
        callbacks: {
          label: (context) => {
            const lines = [`${context.dataset.label}: ${formatPlotted(context.parsed.y, decimals)}`];
            if (context.datasetIndex === 0) {
              if (flagged.has(context.dataIndex)) {
                violationsAt(context.dataIndex).forEach((violation) => lines.push(describeViolation(violation)));
              }
            }
            return lines;
          },
        },
      },
      zoom: {
        zoom: { wheel: { enabled: true, modifierKey: 'ctrl' }, pinch: { enabled: true }, mode: 'xy' },
        pan: { enabled: true, mode: 'xy' },
      },
    },
    scales: {
      x: { title: { display: true, text: xAxisTitle } },
      y: { title: { display: true, text: yAxisTitle }, ...(yMin !== undefined ? { min: yMin } : {}) },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- violationsAt only reads refs and `violations`
  }), [decimals, flagged, title, violations, xAxisTitle, yAxisTitle, yMin]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-sm border border-gray-200 bg-gray-100 px-2 py-1 text-sm hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600"
          onClick={() => resetChartView(chartRef.current)}
        >
          Reset View
        </button>
      </div>
      <div style={{ height }}>
        <Line
          ref={chartRef}
          data={data}
          options={options}
          role="img"
          aria-label={`${title}: ${plottedCount} points plotted, ${flagged.size} flagged`}
        />
      </div>
      {footer}
    </div>
  );
};

export default ControlChartView;
