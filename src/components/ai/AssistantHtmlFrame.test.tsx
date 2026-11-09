import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantHtmlFrame, AssistantHtmlPending } from './AssistantHtmlFrame';
import { AssistantMessageContent } from './AssistantMessageContent';
import { HTML_ARTIFACT_LIMITS } from './assistantHtml';

vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}));

vi.mock('../common/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <span data-testid="markdown">{text}</span>,
}));

const FRAGMENT = '<h1>Zone demo</h1><button id="b" onclick="this.textContent=\'hit\'">go</button><script>window.x=1</script>';

const getFrame = (container: HTMLElement) => container.querySelector('iframe') as HTMLIFrameElement;
const nonceOf = (iframe: HTMLIFrameElement) => /N="([0-9a-f]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1] ?? '';

const postFromFrame = (iframe: HTMLIFrameElement, data: unknown, source: MessageEventSource | null = iframe.contentWindow) => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source, origin: 'null' }));
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AssistantHtmlFrame sandbox', () => {
  it('runs model HTML only in an iframe with exactly allow-scripts and a restrictive document', () => {
    const { container } = render(<AssistantHtmlFrame html={FRAGMENT} artifactIndex={0} />);
    const iframe = getFrame(container);

    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    const tokens = (iframe.getAttribute('sandbox') ?? '').split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(['allow-scripts']);
    for (const token of ['allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-modals', 'allow-downloads']) {
      expect(tokens.includes(token), token).toBe(false);
    }
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe.getAttribute('src')).toBeNull();
    expect(iframe.getAttribute('title')).toContain('Zone demo');

    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("form-action 'none'");

    // Never injected into the host document.
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { x?: number }).x).toBeUndefined();
  });

  it('shows source as inert text and offers a text version', () => {
    const { container } = render(<AssistantHtmlFrame html={FRAGMENT} artifactIndex={0} />);
    fireEvent.click(screen.getByRole('button', { name: /ai\.html\.viewSource/ }));

    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('<script>window.x=1</script>');
    expect(pre?.querySelector('script')).toBeNull();
    expect(screen.getByText('ai.html.textVersion')).toBeInTheDocument();
    expect(container.querySelector('details')?.textContent).toContain('Zone demo');
  });

  it('applies height reports only from its own frame, with its own nonce, and clamps them', () => {
    const { container } = render(<AssistantHtmlFrame html={FRAGMENT} artifactIndex={0} />);
    const iframe = getFrame(container);
    const nonce = nonceOf(iframe);
    expect(nonce).toHaveLength(24);
    expect(iframe.style.height).toBe(`${HTML_ARTIFACT_LIMITS.defaultHeight}px`);

    postFromFrame(iframe, { spcHtmlArtifact: 1, nonce, type: 'size', height: 400 }, window);
    expect(iframe.style.height).toBe(`${HTML_ARTIFACT_LIMITS.defaultHeight}px`);

    postFromFrame(iframe, { spcHtmlArtifact: 1, nonce: 'forged', type: 'size', height: 400 });
    expect(iframe.style.height).toBe(`${HTML_ARTIFACT_LIMITS.defaultHeight}px`);

    postFromFrame(iframe, { spcHtmlArtifact: 1, nonce, type: 'size', height: 400 });
    expect(iframe.style.height).toBe('400px');

    postFromFrame(iframe, { spcHtmlArtifact: 1, nonce, type: 'size', height: 5_000_000 });
    expect(iframe.style.height).toBe(`${HTML_ARTIFACT_LIMITS.maxHeight}px`);
  });

  it('does not let one frame resize or message another', () => {
    const { container } = render(
      <>
        <AssistantHtmlFrame html={FRAGMENT} artifactIndex={0} />
        <AssistantHtmlFrame html="<p>second</p>" artifactIndex={1} />
      </>,
    );
    const [first, second] = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
    postFromFrame(first, { spcHtmlArtifact: 1, nonce: nonceOf(second), type: 'size', height: 500 });
    expect(first.style.height).toBe(`${HTML_ARTIFACT_LIMITS.defaultHeight}px`);
    expect(second.style.height).toBe(`${HTML_ARTIFACT_LIMITS.defaultHeight}px`);
  });

  it('removes a frame that navigates itself and tells the reader', () => {
    const { container } = render(<AssistantHtmlFrame html={FRAGMENT} artifactIndex={0} />);
    const iframe = getFrame(container);

    fireEvent.load(iframe); // the initial srcdoc load
    expect(getFrame(container)).not.toBeNull();

    fireEvent.load(iframe); // any further load means the page moved
    expect(getFrame(container)).toBeNull();
    expect(screen.getByText('ai.html.navigationBlocked')).toBeInTheDocument();
    expect(container.querySelector('pre')?.textContent).toContain('window.x=1');
  });

  it('surfaces blocked links, form submits and script errors from the frame', () => {
    const { container } = render(<AssistantHtmlFrame html={FRAGMENT} artifactIndex={0} />);
    const iframe = getFrame(container);
    const nonce = nonceOf(iframe);

    postFromFrame(iframe, { spcHtmlArtifact: 1, nonce, type: 'blocked', what: 'link' });
    expect(screen.getByText('ai.html.blockedLink')).toBeInTheDocument();
    postFromFrame(iframe, { spcHtmlArtifact: 1, nonce, type: 'error', message: 'boom' });
    expect(screen.getByText('ai.html.scriptError')).toBeInTheDocument();
  });

  it('reports what the sanitizer removed before the page ever ran', () => {
    const { container } = render(
      <AssistantHtmlFrame html={'<a href="https://evil.example">x</a><iframe src="https://evil.example"></iframe><p>ok</p>'} artifactIndex={0} />,
    );
    expect(getFrame(container).getAttribute('srcdoc')).not.toContain('evil.example');
    expect(screen.getByText(/ai\.html\.blockedResources/)).toHaveTextContent('2');
  });

  it('falls back to source only when too large, and past the per-reply limit', () => {
    const big = `<p>${'x'.repeat(HTML_ARTIFACT_LIMITS.maxSourceBytes)}</p>`;
    const { container, rerender } = render(<AssistantHtmlFrame html={big} artifactIndex={0} />);
    expect(getFrame(container)).toBeNull();
    expect(screen.getByText('ai.html.tooLarge')).toBeInTheDocument();
    expect(container.querySelector('figure')?.getAttribute('data-state')).toBe('source-only');

    rerender(<AssistantHtmlFrame html="<p>small</p>" artifactIndex={HTML_ARTIFACT_LIMITS.maxLivePerMessage} />);
    expect(getFrame(container)).toBeNull();
    expect(screen.getByText('ai.html.overLimit')).toBeInTheDocument();
  });

  it('copies the original source and downloads a self-contained document', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    let downloaded: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloaded = blob;
      return 'blob:test';
    });
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    render(<AssistantHtmlFrame html={FRAGMENT} artifactIndex={0} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /ai\.html\.copySource/ }));
    });
    expect(writeText).toHaveBeenCalledWith(FRAGMENT);

    fireEvent.click(screen.getByRole('button', { name: /ai\.html\.download/ }));
    expect(downloaded?.type).toBe('text/html');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(downloaded as Blob);
    });
    expect(text).toContain("default-src 'none'");
    expect(text).toContain('Zone demo');
  });
});

describe('AssistantMessageContent', () => {
  it('renders markdown as markdown and only closed html fences as frames', () => {
    const { container } = render(
      <AssistantMessageContent text={'**bold** text\n\n```html\n<p>live</p>\n```\n\nafter'} streaming={false} />,
    );
    expect(container.querySelectorAll('[data-testid="markdown"]')).toHaveLength(2);
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('shows a progress note while an html block is still streaming and never runs it', () => {
    const { container, rerender } = render(<AssistantMessageContent text={'Intro\n```html\n<p>part'} streaming />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByTestId('assistant-html-pending')).toBeInTheDocument();

    rerender(<AssistantMessageContent text={'Intro\n```html\n<p>part'} streaming={false} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('ai.html.unterminated')).toBeInTheDocument();
  });

  it('keeps a streaming frame mounted when later text arrives', () => {
    const base = 'Intro\n```html\n<p>stable</p>\n```\n';
    const { container, rerender } = render(<AssistantMessageContent text={base} streaming />);
    const iframe = getFrame(container);
    rerender(<AssistantMessageContent text={`${base}more words arriving`} streaming />);
    expect(getFrame(container)).toBe(iframe);
  });
});

describe('AssistantHtmlPending', () => {
  it('is announced as status while streaming', () => {
    render(<AssistantHtmlPending html="<p>x" streaming />);
    expect(screen.getByRole('status')).toHaveTextContent('ai.html.generating');
  });
});
