import React, { useMemo, useRef } from 'react';
import { Scatter } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  type ChartOptions as ChartJsOptions,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useAppContext } from '../../../context/AppContext';
import { parseSpcNumber } from '../../../utils/spcCalculations';
import { finiteExtent, formatPlotted } from '../chartSeries';
import { resetChartView } from '../chartView';

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Legend, zoomPlugin);

interface XY { x: number; y: number }

const fitLine = (points: XY[]): { slope: number; intercept: number; correlation: number } => {
  const n = points.length;
  if (n < 2) return { slope: Number.NaN, intercept: Number.NaN, correlation: Number.NaN };
  const xMean = points.reduce((sum, point) => sum + point.x, 0) / n;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const point of points) {
    sxy += (point.x - xMean) * (point.y - yMean);
    sxx += (point.x - xMean) ** 2;
    syy += (point.y - yMean) ** 2;
  }
  const slope = sxx !== 0 ? sxy / sxx : 0;
  return {
    slope,
    intercept: yMean - slope * xMean,
    correlation: sxx !== 0 && syy !== 0 ? sxy / Math.sqrt(sxx * syy) : 0,
  };
};

const ScatterPlot: React.FC = () => {
  const { processedData, selectedColumns, chartOptions, xAxisColumn } = useAppContext();
  const chartRef = useRef<ChartJS<'scatter'> | null>(null);

  const yValues = processedData?.controlLimits.chartValues;
  const { points, excluded } = useMemo(() => {
    const rows = processedData?.data ?? [];
    const pairs = (yValues ?? []).map((y, index) => ({
      x: xAxisColumn ? parseSpcNumber(rows[index]?.[xAxisColumn]) : index + 1,
      y,
    }));
    const valid = pairs.filter((pair) => Number.isFinite(pair.x) && Number.isFinite(pair.y));
    return { points: valid, excluded: pairs.length - valid.length };
  }, [processedData, xAxisColumn, yValues]);

  if (!processedData || selectedColumns.length < 1) {
    return <div className="text-gray-500">Select at least one data column for scatter plot</div>;
  }
  if (points.length === 0) {
    return <div className="text-gray-500">No rows have numeric values for both axes.</div>;
  }

  const primaryColumn = selectedColumns[0];
  const { slope, intercept, correlation } = fitLine(points);
  const { min: minX, max: maxX } = finiteExtent(points.map((point) => point.x)) ?? { min: 0, max: 0 };
  const trendLine: XY[] = Number.isFinite(slope)
    ? [{ x: minX, y: slope * minX + intercept }, { x: maxX, y: slope * maxX + intercept }]
    : [];

  const chartData = {
    datasets: [
      {
        label: xAxisColumn ? `${primaryColumn} vs ${xAxisColumn}` : primaryColumn,
        data: points,
        backgroundColor: 'rgba(54, 162, 235, 0.6)',
        pointRadius: 5,
        pointHoverRadius: 7,
      },
      {
        // A scatter dataset drawn with a line keeps the chart's type uniform.
        label: 'Trend Line',
        data: trendLine,
        showLine: true,
        borderColor: 'rgba(255, 99, 132, 0.8)',
        borderDash: [5, 5],
        pointRadius: 0,
      },
    ],
  };

  const options: ChartJsOptions<'scatter'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' },
      title: { display: true, text: chartOptions.title || 'Scatter Plot with Trend Analysis', font: { size: 16 } },
      tooltip: {
        callbacks: {
          label: (context) => {
            const point = context.raw as XY;
            return `${xAxisColumn || 'X'}: ${formatPlotted(point.x, 2)}, ${primaryColumn}: ${formatPlotted(point.y, 2)}`;
          },
        },
      },
      zoom: {
        zoom: { wheel: { enabled: true, modifierKey: 'ctrl' }, pinch: { enabled: true }, mode: 'xy' },
        pan: { enabled: true, mode: 'xy' },
      },
    },
    scales: {
      x: { title: { display: true, text: chartOptions.xAxisLabel || xAxisColumn || 'X' } },
      y: { title: { display: true, text: chartOptions.yAxisLabel || primaryColumn } },
    },
  };

  return (
    <div>
      <div className="mb-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-sm border border-gray-200 bg-gray-100 px-2 py-1 text-sm hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600"
          onClick={() => resetChartView(chartRef.current as ChartJS | null)}
        >
          Reset View
        </button>
      </div>
      <div style={{ height: '400px' }}>
        <Scatter ref={chartRef} data={chartData} options={options} role="img" aria-label={`${chartOptions.title || 'Scatter plot'}: ${points.length} points`} />
      </div>

      <div className="mt-4 rounded-md bg-blue-50 p-3">
        <p className="font-medium">Trend Analysis</p>
        <p>Equation: y = {formatPlotted(slope, 4)}x + {formatPlotted(intercept, 4)}</p>
        <p>Correlation: {formatPlotted(correlation, 4)}</p>
        <p>{Math.abs(correlation) > 0.7 ? 'Strong correlation' : 'Weak correlation'}</p>
        {excluded > 0 && (
          <p className="mt-1 text-xs text-gray-600">{excluded} row{excluded === 1 ? '' : 's'} without numeric values for both axes are not plotted.</p>
        )}
      </div>
    </div>
  );
};

export default ScatterPlot;
