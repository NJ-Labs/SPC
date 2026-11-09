import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiAssistantPanel from './AiAssistantPanel';

const setSelectedChartType = vi.fn();
const setSelectedColumns = vi.fn();
const setXAxisColumn = vi.fn();
const setDenominatorColumn = vi.fn();
const setSampleSize = vi.fn();
const setChartOptions = vi.fn();
const fetchMock = vi.fn();

const chatResponse = (content: string) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => ({
    choices: [
      {
        message: { content },
      },
    ],
  }),
  statusText: 'OK',
});

const agentResponse = (content: string, controlPatch: Record<string, unknown> | null = null) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => ({
    content,
    controlPatch,
    toolTrace: controlPatch ? [{ tool: 'update_controls', result: { patch: controlPatch } }] : [],
    knowledgeSources: ['xbar-r.md'],
    needsClarification: false,
    model: 'test-model',
  }),
  statusText: 'OK',
});

const appContextMock: any = {
  rawData: {
    data: [
      { A: 1, B: 2, Date: '2024-01-01' },
      { A: 2, B: 3, Date: '2024-01-02' },
    ],
    headers: ['A', 'B', 'Date'],
    fileName: 'test.xlsx',
    fileType: 'xlsx',
    sheets: [{ name: 'Sheet1', data: [{ A: 1, B: 2, Date: '2024-01-01' }], headers: ['A', 'B', 'Date'] }],
    activeSheetIndex: 0,
  },
  processedData: null,
  selectedColumns: ['A'],
  xAxisColumn: null,
  denominatorColumn: null,
  sampleSize: 3,
  selectedChartType: 'individual',
  chartOptions: {
    title: 'SPC Analysis Chart',
    xAxisLabel: 'Sample',
    yAxisLabel: 'Value',
    showControlLimits: true,
    showCenterLine: true,
    showRuleViolations: true,
    colorScheme: 'default',
    showSigma1: true,
    showSigma2: true,
    showSigma3: true,
  },
  setSelectedChartType,
  setChartOptions,
  setSelectedColumns,
  setXAxisColumn,
  setDenominatorColumn,
  setSampleSize,
  setActiveSheetIndex: vi.fn(),
};

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => appContextMock,
}));

vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('../common/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <span>{text}</span>,
}));

describe('AiAssistantPanel Agent Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The panel talks to the AI service only when runtime config exists; do not depend on a local .env.
    window.APP_CONFIG = { AI: { API_URL: 'http://gateway.test', API_KEY: 'test-key', MODEL: 'test-model' } };
    fetchMock.mockReset();
    appContextMock.rawData = {
      data: [
        { A: 1, B: 2, Date: '2024-01-01' },
        { A: 2, B: 3, Date: '2024-01-02' },
      ],
      headers: ['A', 'B', 'Date'],
      fileName: 'test.xlsx',
      fileType: 'xlsx',
      sheets: [{ name: 'Sheet1', data: [{ A: 1, B: 2, Date: '2024-01-01' }], headers: ['A', 'B', 'Date'] }],
      activeSheetIndex: 0,
    };
    appContextMock.selectedColumns = ['A'];
    appContextMock.xAxisColumn = null;
    appContextMock.denominatorColumn = null;
    appContextMock.sampleSize = 3;
    appContextMock.selectedChartType = 'individual';
    appContextMock.chartOptions = {
      title: 'SPC Analysis Chart',
      xAxisLabel: 'Sample',
      yAxisLabel: 'Value',
      showControlLimits: true,
      showCenterLine: true,
      showRuleViolations: true,
      colorScheme: 'default',
      showSigma1: true,
      showSigma2: true,
      showSigma3: true,
    };

    fetchMock
      .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
      .mockResolvedValue(agentResponse('- Applied X-bar R settings.', {
        chartType: 'xBarR',
        yColumns: ['A', 'B'],
        xAxisColumn: 'Date',
        sampleSize: 4,
        chartLabel: 'XBar-R by Date',
        zAxisLabel: 'Collection Date',
        yAxisLabel: 'Defect Count',
      }));

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete window.APP_CONFIG;
  });

  it('initializes only once in StrictMode when AI configuration is missing', async () => {
    delete window.APP_CONFIG;
    for (const name of ['VITE_AI_API_URL', 'VITE_AI_API_KEY', 'VITE_AI_MODEL']) vi.stubEnv(name, '');
    try {
      render(<StrictMode><AiAssistantPanel onClose={vi.fn()} /></StrictMode>);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ai.notConfigured'));
      expect(screen.getAllByText('test.xlsx')).toHaveLength(1);
      expect(screen.getAllByText('ai.configError')).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('identifies the missing server model when gateway runtime config is present', async () => {
    window.APP_CONFIG = { AI: { API_URL: '/', API_KEY: 'test-gateway-token', MODEL: '' } };
    vi.stubEnv('VITE_AI_MODEL', '');
    try {
      render(<StrictMode><AiAssistantPanel onClose={vi.fn()} /></StrictMode>);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ai.gatewayModelMissing'));
      expect(screen.getAllByText('test.xlsx')).toHaveLength(1);
      expect(screen.getAllByText('ai.gatewayModelMissing')).toHaveLength(2);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('starts only one initial request in StrictMode with configured AI', async () => {
    render(<StrictMode><AiAssistantPanel onClose={vi.fn()} /></StrictMode>);
    await screen.findByText('- Initial chart recommendation.');
    expect(screen.getAllByText('test.xlsx')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prompt = request.messages.find((message: { role: string }) => message.role === 'user').content;
    expect(prompt).toContain('one observation per row (n=1)');
    expect(prompt).not.toContain('Preferred subgroup/sample size');
  });

  it.each([false, true])('shows an actionable invalid-key message in chat and agent mode (%s)', async agentMode => {
    const failure = { ok: false, status: 502, statusText: 'Bad Gateway', headers: new Headers({ 'Content-Type': 'application/json', 'X-SPC-Error-Code': 'upstream_api_key_invalid' }), json: async () => ({ detail: 'provider stack with private-upstream-canary' }) };
    fetchMock.mockReset();
    if (agentMode) fetchMock.mockResolvedValueOnce(chatResponse('- Initial recommendation.'));
    fetchMock.mockResolvedValue(failure);
    render(<StrictMode><AiAssistantPanel onClose={vi.fn()} /></StrictMode>);
    if (agentMode) {
      await screen.findByText('- Initial recommendation.');
      fireEvent.click(screen.getByRole('button', { pressed: false }));
    }
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ai.invalidApiKey'));
    expect(screen.getByRole('log')).toHaveTextContent('ai.invalidApiKey');
    expect(screen.queryByText(/private-upstream-canary|provider stack/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(agentMode ? 2 : 1);
  });

  it('auto-applies recommendation after enabling Agent Mode', async () => {
    render(<AiAssistantPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { pressed: false }));

    await waitFor(() => {
      expect(setSelectedChartType).toHaveBeenCalledWith('xBarR');
      expect(setSelectedColumns).toHaveBeenCalledWith(['A', 'B']);
      expect(setXAxisColumn).toHaveBeenCalledWith('Date');
      expect(setSampleSize).toHaveBeenCalledWith(2);
      expect(setChartOptions).toHaveBeenCalledWith({
        ...appContextMock.chartOptions,
        title: 'XBar-R by Date',
        xAxisLabel: 'Collection Date',
        yAxisLabel: 'Defect Count',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('auto-applies X-bar S multi-sample recommendations to chart controls', async () => {
    fetchMock.mockReset();
    appContextMock.rawData = {
      data: [
        { Sample_1: 11, Sample_2: 12, Sample_3: 10, Sample_4: 13, Sample_5: 12 },
        { Sample_1: 12, Sample_2: 13, Sample_3: 11, Sample_4: 14, Sample_5: 13 },
      ],
      headers: ['Sample_1', 'Sample_2', 'Sample_3', 'Sample_4', 'Sample_5'],
      fileName: 'samples.xlsx',
      fileType: 'xlsx',
      sheets: [
        {
          name: 'Sheet1',
          data: [{ Sample_1: 11, Sample_2: 12, Sample_3: 10, Sample_4: 13, Sample_5: 12 }],
          headers: ['Sample_1', 'Sample_2', 'Sample_3', 'Sample_4', 'Sample_5'],
        },
      ],
      activeSheetIndex: 0,
    };

    fetchMock
      .mockResolvedValueOnce(chatResponse('- Initial non-agent recommendation.'))
      .mockResolvedValueOnce(agentResponse('- Switch to X-bar S chart.', {
        chartType: 'xBarS',
        yColumns: ['Sample_1', 'Sample_2', 'Sample_3', 'Sample_4', 'Sample_5'],
        xAxisColumn: null,
        sampleSize: 2,
        chartLabel: 'X-bar and S Control Chart',
        zAxisLabel: 'Subgroup Index',
        yAxisLabel: 'Measurement Value',
      }));

    render(<AiAssistantPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { pressed: false }));

    await waitFor(() => {
      expect(setSelectedChartType).toHaveBeenCalledWith('xBarS');
      expect(setSelectedColumns).toHaveBeenCalledWith(['Sample_1', 'Sample_2', 'Sample_3', 'Sample_4', 'Sample_5']);
      // The X column was already "row index", so there is nothing to write.
      expect(setXAxisColumn).not.toHaveBeenCalled();
      expect(setSampleSize).toHaveBeenCalledWith(5);
      expect(setChartOptions).toHaveBeenCalledWith({
        ...appContextMock.chartOptions,
        title: 'X-bar and S Control Chart',
        xAxisLabel: 'Subgroup Index',
        yAxisLabel: 'Measurement Value',
      });
    });
  });

  it('posts Agent Mode state to the DSPy agent endpoint and applies the returned patch', async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
      .mockResolvedValueOnce(agentResponse('- Read the current controls and updated the chart configuration.', {
        chartType: 'xBarR',
        yColumns: ['A', 'B'],
        xAxisColumn: 'Date',
        chartLabel: 'XBar-R by Date',
        zAxisLabel: 'Collection Date',
        yAxisLabel: 'Defect Count',
      }));

    render(<AiAssistantPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { pressed: false }));

    await waitFor(() => {
      expect(setSelectedChartType).toHaveBeenCalledWith('xBarR');
      expect(setSelectedColumns).toHaveBeenCalledWith(['A', 'B']);
      expect(setXAxisColumn).toHaveBeenCalledWith('Date');
      expect(setSampleSize).toHaveBeenCalledWith(2);
      expect(setChartOptions).toHaveBeenCalledWith({
        ...appContextMock.chartOptions,
        title: 'XBar-R by Date',
        xAxisLabel: 'Collection Date',
        yAxisLabel: 'Defect Count',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const agentRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fetchMock.mock.calls[1][0]).toContain('/v1/agent/turn');
    expect(agentRequest.tools).toBeUndefined();
    expect(agentRequest.controls.chartType).toBe('individual');
    expect(agentRequest.controls.denominatorColumn).toBeNull();
    expect(agentRequest.availableHeaders).toEqual(['A', 'B', 'Date']);
    expect(agentRequest.dataset.previewRows).toHaveLength(2);
  });

  it('applies denominator column patches for attribute charts', async () => {
    fetchMock.mockReset();
    appContextMock.rawData = {
      data: [
        { Defects: 3, Opportunities: 100, Date: '2024-01-01' },
        { Defects: 5, Opportunities: 120, Date: '2024-01-02' },
      ],
      headers: ['Defects', 'Opportunities', 'Date'],
      fileName: 'defects.xlsx',
      fileType: 'xlsx',
      sheets: [{ name: 'Sheet1', data: [{ Defects: 3, Opportunities: 100, Date: '2024-01-01' }], headers: ['Defects', 'Opportunities', 'Date'] }],
      activeSheetIndex: 0,
    };
    appContextMock.selectedColumns = ['Defects'];

    fetchMock
      .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
      .mockResolvedValueOnce(agentResponse('- Applied U chart settings.', {
        chartType: 'uChart',
        yColumns: ['Defects'],
        denominatorColumn: 'Opportunities',
        xAxisColumn: 'Date',
      }));

    render(<AiAssistantPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { pressed: false }));

    await waitFor(() => {
      expect(setSelectedChartType).toHaveBeenCalledWith('uChart');
      // Y was already ['Defects']: an unchanged selection must not be rewritten (it would reprocess the data).
      expect(setSelectedColumns).not.toHaveBeenCalled();
      expect(setDenominatorColumn).toHaveBeenCalledWith('Opportunities');
      expect(setXAxisColumn).toHaveBeenCalledWith('Date');
    });
  });

  describe('interactive HTML in chat', () => {
    it('renders a closed html fence only inside a script-only sandboxed iframe', async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(chatResponse(
        'Here is the zone view.\n\n```html\n<h1>Zones</h1><script>window.__pwned = 1</script>\n```\n\nKeep an eye on rule 5.',
      ));

      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);

      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
      const iframe = container.querySelector('iframe') as HTMLIFrameElement;
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
      expect(iframe.getAttribute('srcdoc')).toContain('Zones');
      expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'");
      // The model's markup and script never reach the host page.
      expect(container.querySelector('h1')).toBeNull();
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
      // The prose around the block still renders as normal message text.
      expect(screen.getByText(/Here is the zone view\./)).toBeInTheDocument();
      expect(screen.getByText(/Keep an eye on rule 5\./)).toBeInTheDocument();
      // The system prompt teaches the model the constraints of the sandbox exactly once.
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const system = body.messages[0].content as string;
      expect(system.match(/SPC-HTML-ARTIFACT-GUIDE/g)).toHaveLength(1);
    });

    it('does not run an html block that was never closed', async () => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(chatResponse('Cut off here:\n```html\n<script>window.__pwned = 2</script><p>part'));

      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);

      expect(await screen.findByText('ai.html.unterminated')).toBeInTheDocument();
      expect(container.querySelector('iframe')).toBeNull();
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });
  });

  describe('configuration evidence on agent messages', () => {
    const enableAgentMode = () => fireEvent.click(screen.getByRole('button', { pressed: false }));
    const evidenceRoot = (container: HTMLElement) => container.querySelector('[data-testid="agent-config-evidence"]') as HTMLElement | null;
    const row = (container: HTMLElement, field: string) => container.querySelector(`tr[data-field="${field}"]`) as HTMLElement | null;
    const json = (element: HTMLElement | null, attribute: string) => JSON.parse(element?.getAttribute(attribute) ?? 'null');

    const queueAgentTurn = (controlPatch: Record<string, unknown>) => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
        .mockResolvedValue(agentResponse('- I changed your chart.', controlPatch));
    };

    it('shows the real before and after of what was applied, not the patch', async () => {
      queueAgentTurn({
        chartType: 'xBarR',
        yColumns: ['A', 'B'],
        chartLabel: 'XBar-R by Date',
        sampleSize: 4,
        showSigma1: false,
        reason: 'Subgrouped data',
      });
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('applied');
      expect(row(container, 'chartType')?.getAttribute('data-status')).toBe('applied');
      expect(json(row(container, 'chartType'), 'data-before')).toBe('individual');
      expect(json(row(container, 'chartType'), 'data-after')).toBe('xBarR');
      expect(json(row(container, 'yColumns'), 'data-before')).toEqual(['A']);
      expect(json(row(container, 'yColumns'), 'data-after')).toEqual(['A', 'B']);
      expect(json(row(container, 'chartLabel'), 'data-before')).toBe('SPC Analysis Chart');
      // The model asked for 4; two Y columns make the real subgroup size 2, and the card says so.
      expect(json(row(container, 'sampleSize'), 'data-before')).toBe(3);
      expect(json(row(container, 'sampleSize'), 'data-after')).toBe(2);
      expect(json(row(container, 'sampleSize'), 'data-requested')).toBe(4);
      expect(screen.getByText('ai.evidence.note.locked (ai.evidence.askedFor 4)')).toBeInTheDocument();
      // false is a real value, not a missing one.
      expect(row(container, 'showSigma1')?.getAttribute('data-status')).toBe('applied');
      expect(json(row(container, 'showSigma1'), 'data-before')).toBe(true);
      expect(json(row(container, 'showSigma1'), 'data-after')).toBe(false);
      expect(row(container, 'showSigma1')?.textContent).toContain('ai.value.off');
      // The assistant's rationale is shown, but labelled as unverified.
      expect(screen.getByText('ai.evidence.agentReason')).toBeInTheDocument();
      expect(setChartOptions).toHaveBeenCalledWith({
        ...appContextMock.chartOptions,
        title: 'XBar-R by Date',
        showSigma1: false,
      });
    });

    it('makes rejected changes unmistakable and never writes them', async () => {
      queueAgentTurn({ chartType: 'pie', yColumns: ['Nope'], xAxisColumn: 'Ghost', showSigma2: false, applied: ['chartType', 'yColumns'] });
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('partial');
      for (const field of ['chartType', 'yColumns', 'xAxisColumn']) {
        expect(row(container, field)?.getAttribute('data-status'), field).toBe('rejected');
        // Rejected rows keep showing the value the app really has.
        expect(json(row(container, field), 'data-after')).toEqual(json(row(container, field), 'data-before'));
      }
      expect(screen.getByText('ai.evidence.reason.unknownChartType')).toBeInTheDocument();
      expect(screen.getByText('ai.evidence.reason.noValidColumns')).toBeInTheDocument();
      expect(screen.getByText('ai.evidence.reason.unknownColumn')).toBeInTheDocument();
      expect(row(container, 'showSigma2')?.getAttribute('data-status')).toBe('applied');
      expect(setSelectedChartType).not.toHaveBeenCalled();
      expect(setSelectedColumns).not.toHaveBeenCalled();
      expect(setXAxisColumn).not.toHaveBeenCalled();
    });

    it('labels a patch that changes nothing as a no-op and performs no writes', async () => {
      queueAgentTurn({ chartType: 'individual', yColumns: ['A'], showSigma1: true, chartLabel: 'SPC Analysis Chart', sampleSize: 3 });
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('unchanged');
      expect(container.querySelectorAll('tr[data-status="unchanged"]').length).toBe(5);
      expect(container.querySelectorAll('tr[data-status="applied"]').length).toBe(0);
      expect(setSelectedChartType).not.toHaveBeenCalled();
      expect(setSelectedColumns).not.toHaveBeenCalled();
      expect(setSampleSize).not.toHaveBeenCalled();
      expect(setChartOptions).not.toHaveBeenCalled();
    });

    it('says plainly when the assistant asked for no settings at all', async () => {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
        .mockResolvedValue(agentResponse('- Just an explanation.', null));
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('none');
      expect(screen.getByText('ai.evidence.noneRequested')).toBeInTheDocument();
    });

    it('rejects a patch when the same file is re-uploaded while the request is running', async () => {
      let resolveAgent: (value: unknown) => void = () => undefined;
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveAgent = resolve; }));
      const { container, rerender } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // Same name, same shape, same headers: only the row array's identity differs.
      appContextMock.rawData = { ...appContextMock.rawData, data: appContextMock.rawData.data.map((entry: object) => ({ ...entry })) };
      rerender(<AiAssistantPanel onClose={vi.fn()} />);
      await act(async () => {
        resolveAgent(agentResponse('- Applied.', { chartType: 'xBarR', yColumns: ['A', 'B'] }));
      });

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('stale');
      expect(row(container, 'chartType')?.getAttribute('data-status')).toBe('rejected');
      expect(screen.getAllByText('ai.evidence.reason.staleDataset').length).toBeGreaterThan(0);
      expect(setSelectedChartType).not.toHaveBeenCalled();
      expect(setSelectedColumns).not.toHaveBeenCalled();
    });

    it('applies against the latest settings and keeps what the user changed while the request ran', async () => {
      let resolveAgent: (value: unknown) => void = () => undefined;
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveAgent = resolve; }));
      const { container, rerender } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // The user edits spec limits and the title while the assistant is thinking.
      appContextMock.chartOptions = { ...appContextMock.chartOptions, lowerSpecLimit: 5, upperSpecLimit: 9, title: 'My title' };
      rerender(<AiAssistantPanel onClose={vi.fn()} />);
      await act(async () => {
        resolveAgent(agentResponse('- Retitled.', { chartLabel: 'Assistant title', yAxisLabel: 'Assistant Y' }));
      });

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      // A stale closure would have written the old options back over the user's spec limits...
      expect(setChartOptions).toHaveBeenCalledWith(expect.objectContaining({ yAxisLabel: 'Assistant Y', lowerSpecLimit: 5, upperSpecLimit: 9 }));
      // ...and the assistant's title must not replace the one the user typed.
      expect(setChartOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'My title' }));
      expect(setChartOptions).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Assistant title' }));
      expect(row(container, 'chartLabel')?.getAttribute('data-status')).toBe('rejected');
      expect(json(row(container, 'chartLabel'), 'data-before')).toBe('My title');
      expect(json(row(container, 'chartLabel'), 'data-after')).toBe('My title');
      expect(json(row(container, 'chartLabel'), 'data-requested')).toBe('Assistant title');
      expect(screen.getByText('ai.evidence.reason.editedDuringRequest')).toBeInTheDocument();
      expect(row(container, 'yAxisLabel')?.getAttribute('data-status')).toBe('applied');
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('partial');
    });

    it('performs no write at all when the only proposal is for a setting the user changed', async () => {
      let resolveAgent: (value: unknown) => void = () => undefined;
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveAgent = resolve; }));
      const { container, rerender } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      appContextMock.chartOptions = { ...appContextMock.chartOptions, title: 'My title' };
      rerender(<AiAssistantPanel onClose={vi.fn()} />);
      await act(async () => {
        resolveAgent(agentResponse('- Retitled.', { chartLabel: 'Assistant title' }));
      });

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('rejected');
      expect(setChartOptions).not.toHaveBeenCalled();
    });

    it('treats a concurrent edit that already matches the proposal as a no-op, not a conflict', async () => {
      let resolveAgent: (value: unknown) => void = () => undefined;
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveAgent = resolve; }));
      const { container, rerender } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      appContextMock.chartOptions = { ...appContextMock.chartOptions, title: 'Same title' };
      rerender(<AiAssistantPanel onClose={vi.fn()} />);
      await act(async () => {
        resolveAgent(agentResponse('- Retitled.', { chartLabel: 'Same title' }));
      });

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('unchanged');
      expect(row(container, 'chartLabel')?.getAttribute('data-status')).toBe('unchanged');
      expect(screen.queryByText('ai.evidence.reason.editedDuringRequest')).toBeNull();
      expect(setChartOptions).not.toHaveBeenCalled();
    });

    it('does not apply a chart/column/sample selection that the user changed part of', async () => {
      let resolveAgent: (value: unknown) => void = () => undefined;
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(chatResponse('- Initial chart recommendation.'))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveAgent = resolve; }));
      const { container, rerender } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      // The user picks a P chart while the assistant is still proposing an X-bar R setup.
      appContextMock.selectedChartType = 'pChart';
      rerender(<AiAssistantPanel onClose={vi.fn()} />);
      await act(async () => {
        resolveAgent(agentResponse('- X-bar R.', { chartType: 'xBarR', yColumns: ['A', 'B'], sampleSize: 4, yAxisLabel: 'Mean' }));
      });

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(row(container, 'chartType')?.getAttribute('data-status')).toBe('rejected');
      expect(row(container, 'yColumns')?.getAttribute('data-status')).toBe('rejected');
      expect(row(container, 'sampleSize')?.getAttribute('data-status')).toBe('rejected');
      expect(screen.getByText('ai.evidence.reason.editedDuringRequest')).toBeInTheDocument();
      expect(screen.getAllByText('ai.evidence.reason.dependsOnEditedSetting').length).toBe(2);
      expect(screen.getAllByText('ai.evidence.changedSettings controlPanel.chartType').length).toBe(2);
      expect(setSelectedChartType).not.toHaveBeenCalled();
      expect(setSelectedColumns).not.toHaveBeenCalled();
      expect(setSampleSize).not.toHaveBeenCalled();
      // A label does not feed the statistics, so it still applies.
      expect(row(container, 'yAxisLabel')?.getAttribute('data-status')).toBe('applied');
      expect(setChartOptions).toHaveBeenCalledWith(expect.objectContaining({ yAxisLabel: 'Mean' }));
    });

    it('shows a gateway patch that carries only rejections instead of "no settings requested"', async () => {
      queueAgentTurn({
        applied: [],
        skipped: ['chartType'],
        changes: [],
        rejected: [{ field: 'chartType', value: 'pie', reason: 'Unknown chart type. Use one of: individual, xBarR.' }],
        reason: 'Pie shows the split.',
      });
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('rejected');
      expect(screen.queryByText('ai.evidence.noneRequested')).toBeNull();
      expect(screen.getByText('ai.evidence.outcome.rejected')).toBeInTheDocument();
      expect(evidenceRoot(container)?.textContent).toContain('ai.evidence.rejected 1');

      const refusal = container.querySelector('[data-source="service"]') as HTMLElement;
      expect(refusal.getAttribute('data-status')).toBe('rejected');
      expect(refusal.getAttribute('data-field')).toBe('chartType');
      expect(json(refusal, 'data-requested')).toBe('pie');
      expect(refusal.textContent).toContain('controlPanel.chartType');
      expect(refusal.textContent).toContain('Unknown chart type. Use one of: individual, xBarR.');
      // It states the value the app really still has, not the refused one.
      expect(refusal.textContent).toMatch(/ai\.evidence\.now\s+Individual/i);
      expect(container.querySelectorAll('tr[data-field]').length).toBe(0);
      expect(setSelectedChartType).not.toHaveBeenCalled();
    });

    it('keeps real changes in the table and gateway refusals in their own list', async () => {
      queueAgentTurn({
        showSigma2: false,
        applied: ['showSigma2'],
        skipped: ['chartType'],
        changes: [{ field: 'showSigma2', from: true, to: false }],
        rejected: [{ field: 'chartType', value: 'pie', reason: 'Unknown chart type.' }],
      });
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('partial');
      expect(row(container, 'showSigma2')?.getAttribute('data-status')).toBe('applied');
      expect(row(container, 'chartType')).toBeNull();
      expect(container.querySelectorAll('[data-source="service"]').length).toBe(1);
      expect(setChartOptions).toHaveBeenCalledWith(expect.objectContaining({ showSigma2: false }));
      expect(setSelectedChartType).not.toHaveBeenCalled();
    });

    it('does not count gateway "applied" metadata as a change', async () => {
      queueAgentTurn({
        applied: ['chartType', 'yColumns'],
        skipped: [],
        changes: [{ field: 'chartType', from: 'individual', to: 'xBarR' }],
        rejected: [],
      });
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      expect(evidenceRoot(container)?.getAttribute('data-outcome')).toBe('none');
      expect(screen.getByText('ai.evidence.noneRequested')).toBeInTheDocument();
      expect(container.querySelectorAll('tr[data-status="applied"]').length).toBe(0);
      expect(setSelectedChartType).not.toHaveBeenCalled();
      expect(setSelectedColumns).not.toHaveBeenCalled();
    });

    it('shows an unknown or unsafe refused setting generically without internal details', async () => {
      queueAgentTurn({
        rejected: [
          { field: 'lowerSpecLimit', value: 5, reason: 'Specification limits come from requirements; ask the user to enter them in the app.' },
          { field: '<img src=x onerror=alert(1)>', value: 1, reason: 'Traceback (most recent call last):\n  File "/app/main.py", line 3\nKeyError' },
        ],
      });
      const { container } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();

      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());
      const entries = Array.from(container.querySelectorAll('[data-source="service"]')) as HTMLElement[];
      expect(entries).toHaveLength(2);
      expect(entries[0].textContent).toContain('lowerSpecLimit');
      expect(entries[0].textContent).toContain('Specification limits come from requirements');
      expect(entries[1].textContent).toContain('ai.evidence.unknownSetting');
      expect(entries[1].textContent).toContain('ai.evidence.reason.serverRefused');
      const html = evidenceRoot(container)?.innerHTML ?? '';
      expect(html).not.toContain('Traceback');
      expect(html).not.toContain('main.py');
      expect(container.querySelector('img')).toBeNull();
    });

    it('flags an older reply once its applied settings have since changed, and tells the model', async () => {
      queueAgentTurn({ chartType: 'xBarR', yColumns: ['A', 'B'] });
      const { container, rerender } = render(<AiAssistantPanel onClose={vi.fn()} />);
      enableAgentMode();
      await waitFor(() => expect(evidenceRoot(container)).not.toBeNull());

      // The store adopts the patch (the setters here are mocks, so do what the real app would).
      appContextMock.selectedChartType = 'xBarR';
      appContextMock.selectedColumns = ['A', 'B'];
      appContextMock.sampleSize = 2;
      rerender(<AiAssistantPanel onClose={vi.fn()} />);
      expect(screen.queryByText('ai.evidence.superseded')).toBeNull();

      // Then the user moves on to a different chart.
      appContextMock.selectedChartType = 'pChart';
      rerender(<AiAssistantPanel onClose={vi.fn()} />);
      expect(screen.getByText('ai.evidence.superseded')).toBeInTheDocument();
      // Changing chart type changes the layout summary and triggers one automatic reassessment.
      await screen.findByRole('button', { name: 'ai.send' });
      expect(fetchMock).toHaveBeenCalledTimes(3);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'What now?' } });
      fireEvent.click(screen.getByRole('button', { name: 'ai.send' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

      const followUp = JSON.parse(fetchMock.mock.calls[3][1].body);
      const earlierReply = followUp.messages.find((message: { role: string; content: string }) => message.role === 'assistant' && message.content.includes('I changed your chart.'));
      expect(earlierReply.content).toContain('[App verification:');
      expect(earlierReply.content).toContain('applied chartType individual -> xBarR');
      expect(earlierReply.content).toContain('since changed: chartType');
      // Only the outgoing copy is annotated; the transcript still shows the assistant's own words.
      expect(screen.queryByText(/App verification/)).toBeNull();
    });
  });
});
