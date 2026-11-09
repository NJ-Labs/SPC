import React, { useMemo, useRef } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  type ChartOptions as ChartJsOptions,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { useAppContext } from '../../../context/AppContext';
import { finiteExtent, formatPlotted, histogramBins } from '../chartSeries';
import { resetChartView } from '../chartView';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, zoomPlugin);

const moment = (values: number[], power: number): number => {
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n);
  if (n < 3 || deviation === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + ((value - mean) / deviation) ** power, 0) / n;
};

const Histogram: React.FC = () => {
  const { processedData, selectedColumns, chartOptions } = useAppContext();
  const chartRef = useRef<ChartJS<'bar'> | null>(null);

  const values = useMemo(
    () => (processedData?.controlLimits.chartValues ?? []).filter(Number.isFinite),
    [processedData],
  );
  const histogram = useMemo(() => histogramBins(values), [values]);

  if (!processedData || !selectedColumns.length) {
    return <div>No data available</div>;
  }
  if (!histogram) {
    return <div className="text-gray-500">No numeric values to plot in the selected column.</div>;
  }

  const { bins, counts } = histogram;
  const { centerLine, sigma } = processedData.controlLimits;
  const { min, max } = finiteExtent(values) ?? { min: Number.NaN, max: Number.NaN };

  const chartData = {
    labels: bins.slice(0, -1).map((bin, index) => ((bin + bins[index + 1]) / 2).toFixed(2)),
    datasets: [
      {
        label: 'Frequency',
        data: counts,
        backgroundColor: 'rgba(54, 162, 235, 0.6)',
        borderColor: 'rgba(54, 162, 235, 1)',
        borderWidth: 1,
      },
    ],
  };

  const options: ChartJsOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' },
      title: { display: true, text: chartOptions.title || 'Histogram', font: { size: 16 } },
      tooltip: {
        callbacks: {
          title: (items) => {
            const index = items[0]?.dataIndex ?? 0;
            return `Range: ${bins[index].toFixed(2)} - ${bins[index + 1].toFixed(2)}`;
          },
          label: (context) => `Frequency: ${context.parsed.y ?? 0}`,
        },
      },
      zoom: {
        zoom: { wheel: { enabled: true, modifierKey: 'ctrl' }, pinch: { enabled: true }, mode: 'xy' },
        pan: { enabled: true, mode: 'xy' },
      },
    },
    scales: {
      x: { title: { display: true, text: chartOptions.xAxisLabel || 'Value' } },
      y: { title: { display: true, text: chartOptions.yAxisLabel || 'Frequency' }, beginAtZero: true },
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
        <Bar ref={chartRef} data={chartData} options={options} role="img" aria-label={`${chartOptions.title || 'Histogram'}: ${values.length} values in ${counts.length} bins`} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 text-sm md:grid-cols-3">
        <div className="rounded-md bg-blue-50 p-3">
          <p className="font-medium">Summary Statistics</p>
          <p>Mean: {formatPlotted(centerLine, 3)}</p>
          <p>Standard Deviation: {formatPlotted(sigma, 3)}</p>
          <p>Sample Size: {values.length}</p>
        </div>
        <div className="rounded-md bg-blue-50 p-3">
          <p className="font-medium">Range</p>
          <p>Minimum: {formatPlotted(min, 3)}</p>
          <p>Maximum: {formatPlotted(max, 3)}</p>
          <p>Range: {formatPlotted(max - min, 3)}</p>
        </div>
        <div className="rounded-md bg-blue-50 p-3">
          <p className="font-medium">Distribution</p>
          <p>Skewness: {formatPlotted(moment(values, 3), 3)}</p>
          <p>Excess kurtosis: {formatPlotted(moment(values, 4) - 3, 3)}</p>
          <p>Bins: {counts.length}</p>
        </div>
      </div>
    </div>
  );
};

export default Histogram;
