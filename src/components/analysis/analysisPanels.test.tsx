import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessedData, RuleViolation } from '../../types/DataTypes';
import CapabilityPanel from '../charts/CapabilityPanel';
import RuleViolationsPanel from './RuleViolationsPanel';

const ctx: { processedData: ProcessedData | null; chartOptions: Record<string, unknown> } = {
  processedData: null,
  chartOptions: {},
};

vi.mock('../../context/AppContext', () => ({ useAppContext: () => ctx }));
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}));

type Counted = RuleViolation & { signalCount?: number };
const violation = (index: number, ruleNumber: number, extra: Partial<Counted> = {}): Counted => ({
  index,
  pointValue: 1,
  ruleNumber,
  description: `rule ${ruleNumber}`,
  ...extra,
});

const processed = (overrides: Partial<ProcessedData> = {}, limits: Partial<ProcessedData['controlLimits']> = {}): ProcessedData => ({
  data: [],
  controlLimits: { ucl: 13, lcl: 7, centerLine: 10, sigma: 1, ...limits },
  ruleViolations: [],
  statistics: { mean: 10, standardDeviation: 1, min: 8, max: 12, count: 30 },
  ...overrides,
});

beforeEach(() => {
  ctx.processedData = null;
  ctx.chartOptions = {};
});

describe('RuleViolationsPanel', () => {
  it('counts a variation-chart signal against process status even with a clean main chart', () => {
    ctx.processedData = processed({ variationRuleViolations: [violation(5, 1, { signalCount: 1 })] });
    render(<RuleViolationsPanel />);

    const status = screen.getByTestId('process-status');
    expect(status.getAttribute('data-in-control')).toBe('false');
    expect(status).toHaveTextContent('ruleViolations.outOfControl');
    expect(status).toHaveTextContent('1 ruleViolations.violationsDetected 1 ruleViolations.ruleTypes');
    expect(screen.getByText('ruleViolations.variationChart')).toBeInTheDocument();
  });

  it('reports exact signal totals from signalCount alongside the flagged points', () => {
    ctx.processedData = processed({
      ruleViolations: [
        violation(10, 2, { signalCount: 3, signals: [{ windowStart: 2, windowEnd: 10, signalIndex: 10, participatingIndices: [] }] }),
        violation(11, 2, { signalCount: 0 }),
        violation(12, 2, { signalCount: 4 }),
      ],
    });
    render(<RuleViolationsPanel />);

    const group = screen.getByTestId('rule-group-2');
    expect(group).toHaveTextContent('7 ruleViolations.signalMany');
    expect(group).toHaveTextContent('3 ruleViolations.pointsFlagged');
    // 7 signals in the headline, not 3 flagged points.
    expect(screen.getByTestId('process-status')).toHaveTextContent('7 ruleViolations.violationsDetected');
    const listed = within(screen.getByTestId('rules-checked')).getAllByRole('listitem');
    expect(listed[1]).toHaveTextContent('7 ruleViolations.signalMany · 3 ruleViolations.pointsFlagged');
  });

  it('shows the Nelson set by default and lists all eight tests', () => {
    ctx.processedData = processed();
    render(<RuleViolationsPanel />);
    expect(screen.getByTestId('process-status')).toHaveTextContent('rules.set.nelson');
    expect(within(screen.getByTestId('rules-checked')).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText('rules.set.nelsonNote')).toBeInTheDocument();
    expect(screen.getAllByText('ruleViolations.noSignals')).toHaveLength(8);
  });

  it('describes the true Western Electric four when that is what the violations were computed with', () => {
    ctx.chartOptions = { ruleSet: 'nelson' };
    ctx.processedData = processed({ ruleViolations: [violation(3, 4, { ruleSet: 'westernElectric', signalCount: 1 })] });
    render(<RuleViolationsPanel />);

    expect(screen.getByTestId('process-status')).toHaveTextContent('rules.set.westernElectric');
    expect(screen.getByText('rules.set.westernElectricNote')).toBeInTheDocument();
    const listed = within(screen.getByTestId('rules-checked')).getAllByRole('listitem');
    expect(listed).toHaveLength(4);
    // Rule 4 means "8 on one side" in this set, not Nelson's alternating-14.
    expect(listed[3]).toHaveTextContent('8 consecutive points on the same side');
    expect(screen.getByTestId('rule-group-4')).toHaveTextContent('8 consecutive points on the same side');
  });

  it('explains σ with the plotted statistic, the process σ and zone bounds', () => {
    ctx.processedData = processed({}, { sigma: 0.5, processSigma: 1.5, sigmaMethod: 'R-bar/d2' });
    render(<RuleViolationsPanel />);

    const box = screen.getByTestId('sigma-explanation');
    expect(box).toHaveTextContent('ruleViolations.sigmaExplain');
    expect(box).toHaveTextContent('ruleViolations.sigmaProcess: 1.500');
    expect(box).toHaveTextContent('ruleViolations.sigmaMethod R-bar/d2');
    // Zone C is within ±1σ of the center line (10 ± 0.5).
    expect(box).toHaveTextContent('9.500 … 10.000 · 10.000 … 10.500');
    expect(box).toHaveTextContent('8.500 … 9.000 · 11.000 … 11.500');
  });

  it('shows the σ range when it varies by point', () => {
    ctx.processedData = processed({}, { sigma: 1, sigmaSeries: [0.5, 1, 2] });
    render(<RuleViolationsPanel />);
    expect(screen.getByTestId('sigma-explanation')).toHaveTextContent('ruleViolations.sigmaVaries');
    expect(screen.getAllByText('0.500 – 2.000').length).toBeGreaterThan(0);
  });

  it('prompts for data when nothing has been processed', () => {
    render(<RuleViolationsPanel />);
    expect(screen.getByText('ruleViolations.uploadData')).toBeInTheDocument();
  });
});

describe('CapabilityPanel', () => {
  const indices = { cp: Number.NaN, cpl: Number.NaN, cpu: Number.NaN, cpk: Number.NaN, pp: Number.NaN, ppl: Number.NaN, ppu: Number.NaN, ppk: Number.NaN, cpm: Number.NaN };

  it('explains why capability is unavailable and never prints NaN', () => {
    ctx.processedData = processed({
      capabilityStatus: {
        readiness: 'notApplicable',
        indices,
        reasons: ['Add at least one specification limit before interpreting capability.', 'A second reason that used to be cut off.', 'Third.', 'Fourth reason.'],
      },
    });
    const { container } = render(<CapabilityPanel />);

    const panel = screen.getByTestId('capability-panel');
    expect(panel.getAttribute('data-readiness')).toBe('notApplicable');
    expect(panel).toHaveTextContent('capability.readiness.notApplicable');
    expect(panel).toHaveTextContent('capability.meaning.notApplicable');
    // Every reason is shown, not just the first three.
    expect(container.querySelectorAll('ul li')).toHaveLength(4);
    expect(panel.textContent).not.toMatch(/NaN/);
    const cp = container.querySelector('[data-index="Cp"] dd');
    expect(cp?.textContent).toBe('—');
    expect(cp?.getAttribute('aria-label')).toBe('capability.unavailable');
  });

  it('shows indices with what each one means and the σ actually used', () => {
    ctx.processedData = processed(
      {
        capabilityStatus: {
          readiness: 'ready',
          indices: { cp: 1.5, cpl: 1.4, cpu: 1.6, cpk: 1.4, pp: 1.2, ppl: 1.1, ppu: 1.3, ppk: 1.1, cpm: 1.3 },
          reasons: ['Process appears stable enough for initial capability interpretation.'],
          sigmaEstimate: { within: 0.8, overall: 0.95, method: 'MR-bar/d2 (n=2)', observationCount: 120 },
        },
      },
      { sigma: 0.4, processSigma: 0.8 },
    );
    const { container } = render(<CapabilityPanel />);

    expect(container.querySelector('[data-index="Cpk"] dd')).toHaveTextContent('1.4000');
    expect(container.querySelector('[data-index="Cpk"]')).toHaveTextContent('capability.index.cpk');
    expect(container.querySelector('[data-index="Ppk"]')).toHaveTextContent('capability.index.ppk');
    const sigma = screen.getByTestId('capability-sigma');
    expect(sigma).toHaveTextContent('capability.sigmaWithin: 0.8000 (MR-bar/d2 (n=2))');
    expect(sigma).toHaveTextContent('capability.sigmaOverall: 0.9500');
    expect(sigma).toHaveTextContent('capability.observations: 120');
    expect(screen.getByTestId('capability-panel').getAttribute('data-readiness')).toBe('ready');
  });

  it('uses the within-process σ rather than the plotted statistic\'s σ when estimating by itself', () => {
    ctx.chartOptions = { lowerSpecLimit: 0, upperSpecLimit: 12 };
    ctx.processedData = processed({}, { sigma: 0.5, processSigma: 2 });
    const { container } = render(<CapabilityPanel />);
    // Cp = (12 - 0) / (6 × 2) = 1, not 12 / (6 × 0.5) = 4.
    expect(container.querySelector('[data-index="Cp"] dd')).toHaveTextContent('1.0000');
  });
});
