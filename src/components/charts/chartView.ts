import type { Chart as ChartJS } from 'chart.js';

type ScaleWithMinMax = { min?: number; max?: number };

export const resetChartView = (chart: ChartJS | null | undefined) => {
  if (!chart) return;
  if (typeof chart.resetZoom === 'function') {
    try { chart.resetZoom(); return; } catch { /* fall through to manual reset */ }
  }
  chart.options.scales = chart.options.scales || {};
  for (const axis of ['x', 'y'] as const) {
    const scale = chart.options.scales[axis] as unknown as ScaleWithMinMax | undefined;
    if (scale) {
      delete scale.min;
      delete scale.max;
    }
  }
  chart.update('none');
};
