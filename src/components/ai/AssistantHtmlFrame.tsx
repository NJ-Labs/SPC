import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Check, Code2, Copy, Download, Loader2, Lock } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  HTML_ARTIFACT_LIMITS,
  HTML_ARTIFACT_SANDBOX,
  assessHtmlArtifact,
  createArtifactNonce,
  htmlArtifactFileName,
  readHtmlArtifactMessage,
  resolveTargetOrigin,
  type HtmlArtifactMessage,
} from './assistantHtml';

/**
 * One window listener shared by every frame: each frame still checks `event.source` and its own nonce.
 */
type FrameMessageListener = (event: MessageEvent) => void;
const frameListeners = new Set<FrameMessageListener>();
const dispatchFrameMessage = (event: MessageEvent) => {
  frameListeners.forEach((listener) => listener(event));
};
const subscribeToFrameMessages = (listener: FrameMessageListener) => {
  if (frameListeners.size === 0) window.addEventListener('message', dispatchFrameMessage);
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
    if (frameListeners.size === 0) window.removeEventListener('message', dispatchFrameMessage);
  };
};

const hashString = (text: string): string => {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
};

const MAX_SOURCE_DISPLAY_CHARS = 20_000;

const downloadText = (content: string, fileName: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const toolbarButton =
  'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-teal-800 transition-colors hover:bg-teal-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-teal-600';

const SourceView: React.FC<{ id: string; source: string }> = ({ id, source }) => {
  const { t } = useLanguage();
  const shown = source.length > MAX_SOURCE_DISPLAY_CHARS ? source.slice(0, MAX_SOURCE_DISPLAY_CHARS) : source;
  return (
    <div id={id} className="markdown-body border-t border-teal-100 px-2.5 pb-2" dir="ltr">
      <pre
        className="mkd-pre max-h-64 overflow-auto text-xs"
        tabIndex={0}
        aria-label={t('ai.html.sourceLabel')}
      >
        <code className="mkd-code">{shown}</code>
      </pre>
      {shown.length < source.length && (
        <p className="text-[11px] text-slate-600">{t('ai.html.truncatedSource')}</p>
      )}
    </div>
  );
};

const useCopyFeedback = () => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, []);
  return { copied, copy };
};

interface AssistantHtmlFrameProps {
  html: string;
  /** Position among closed html blocks in the reply; past the cap only source is shown. */
  artifactIndex: number;
}

export const AssistantHtmlFrame: React.FC<AssistantHtmlFrameProps> = React.memo(({ html, artifactIndex }) => {
  const { language, t } = useLanguage();
  const [nonce] = useState(createArtifactNonce);
  const targetOrigin = useMemo(resolveTargetOrigin, []);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadState = useRef({ key: '', loads: 0 });
  const [height, setHeight] = useState<number>(HTML_ARTIFACT_LIMITS.defaultHeight);
  const [showSource, setShowSource] = useState(false);
  const [navigationBlockedKey, setNavigationBlockedKey] = useState<string | null>(null);
  const [runtimeNotice, setRuntimeNotice] = useState<HtmlArtifactMessage | null>(null);
  const { copied, copy } = useCopyFeedback();
  const sourceId = useMemo(() => `html-source-${nonce}`, [nonce]);

  const assessment = useMemo(
    () => assessHtmlArtifact(html, {
      nonce,
      targetOrigin,
      dir: language === 'he' ? 'rtl' : 'ltr',
      lang: language,
    }),
    [html, language, nonce, targetOrigin],
  );

  const withinLimit = artifactIndex < HTML_ARTIFACT_LIMITS.maxLivePerMessage;
  const documentKey = assessment.ok ? hashString(assessment.document) : '';
  const navigationBlocked = assessment.ok && navigationBlockedKey === documentKey;
  const live = assessment.ok && withinLimit && !navigationBlocked;

  useEffect(() => subscribeToFrameMessages((event) => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || event.source !== frameWindow) return;
    const message = readHtmlArtifactMessage(event.data, nonce);
    if (!message) return;
    if (message.type === 'size') setHeight(message.height);
    else setRuntimeNotice(message);
  }), [nonce]);

  // A sandboxed frame cannot be stopped from navigating itself, but a second load means it did.
  const handleLoad = useCallback(() => {
    if (loadState.current.key !== documentKey) loadState.current = { key: documentKey, loads: 0 };
    loadState.current.loads += 1;
    if (loadState.current.loads > 1) setNavigationBlockedKey(documentKey);
  }, [documentKey]);

  const title = (assessment.ok && assessment.title) || t('ai.html.title');
  const sourceVisible = showSource || !live;

  let notice: string | null = null;
  if (!assessment.ok) {
    notice = assessment.reason === 'too-large'
      ? t('ai.html.tooLarge')
      : assessment.reason === 'unsupported'
        ? t('ai.html.unsupported')
        : t('ai.html.empty');
  } else if (!withinLimit) {
    notice = t('ai.html.overLimit');
  } else if (navigationBlocked) {
    notice = t('ai.html.navigationBlocked');
  }

  const blockedTotal = assessment.ok
    ? assessment.blocked.links + assessment.blocked.resources + assessment.blocked.embeds + assessment.blocked.navigation
    : 0;
  const runtimeText = runtimeNotice?.type === 'error'
    ? t('ai.html.scriptError')
    : runtimeNotice?.type === 'blocked'
      ? (runtimeNotice.what === 'form' ? t('ai.html.blockedForm') : t('ai.html.blockedLink'))
      : null;

  return (
    <figure
      className="my-2 overflow-hidden rounded-lg border border-teal-200 bg-white text-gray-700"
      data-testid="assistant-html-frame"
      data-state={live ? 'live' : 'source-only'}
    >
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-teal-50 px-2.5 py-1.5">
        <AppWindow className="h-3.5 w-3.5 shrink-0 text-teal-700" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-teal-900">{title}</span>
        <span
          className="inline-flex items-center gap-1 text-[11px] text-slate-600"
          title={t('ai.html.sandboxedHint')}
        >
          <Lock className="h-3 w-3" aria-hidden="true" />
          {t('ai.html.sandboxed')}
        </span>
        {live && (
          <button
            type="button"
            className={toolbarButton}
            onClick={() => setShowSource((open) => !open)}
            aria-expanded={showSource}
            aria-controls={sourceId}
          >
            <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
            {showSource ? t('ai.html.hideSource') : t('ai.html.viewSource')}
          </button>
        )}
        <button type="button" className={toolbarButton} onClick={() => copy(html)}>
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? t('ai.html.copied') : t('ai.html.copySource')}
        </button>
        {assessment.ok && (
          <button
            type="button"
            className={toolbarButton}
            onClick={() => downloadText(assessment.document, htmlArtifactFileName(assessment.title), 'text/html')}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {t('ai.html.download')}
          </button>
        )}
      </figcaption>

      {live && assessment.ok && (
        <iframe
          ref={iframeRef}
          key={documentKey}
          title={`${t('ai.html.title')}: ${title}`}
          sandbox={HTML_ARTIFACT_SANDBOX}
          srcDoc={assessment.document}
          referrerPolicy="no-referrer"
          loading="lazy"
          allow=""
          onLoad={handleLoad}
          className="block w-full border-0 bg-white"
          style={{ height }}
        />
      )}

      {(notice || runtimeText || (blockedTotal > 0 && live)) && (
        <div role="status" className="space-y-0.5 border-t border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
          {notice && <p>{notice}</p>}
          {runtimeText && <p>{runtimeText}</p>}
          {blockedTotal > 0 && live && (
            <p>{t('ai.html.blockedResources')} {blockedTotal}</p>
          )}
        </div>
      )}

      {sourceVisible && <SourceView id={sourceId} source={html} />}

      {assessment.ok && assessment.plainText && (
        <details className="border-t border-teal-100 px-2.5 py-1.5 text-xs">
          <summary className="cursor-pointer font-medium text-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600">
            {t('ai.html.textVersion')}
          </summary>
          <p className="mt-1 whitespace-pre-line text-slate-700">{assessment.plainText}</p>
        </details>
      )}
    </figure>
  );
});
AssistantHtmlFrame.displayName = 'AssistantHtmlFrame';

/** An html fence with no closing line: still streaming, or cut off. Never run. */
export const AssistantHtmlPending: React.FC<{ html: string; streaming: boolean }> = React.memo(({ html, streaming }) => {
  const { t } = useLanguage();
  const sourceId = useMemo(() => `html-open-${hashString(html.slice(0, 64))}`, [html]);
  if (streaming) {
    return (
      <div
        role="status"
        className="my-2 flex items-center gap-2 rounded-lg border border-teal-200 bg-white px-3 py-2 text-xs text-teal-800"
        data-testid="assistant-html-pending"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t('ai.html.generating')}
      </div>
    );
  }
  return (
    <figure
      className="my-2 overflow-hidden rounded-lg border border-amber-200 bg-white"
      data-testid="assistant-html-unterminated"
    >
      <p role="status" className="bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">{t('ai.html.unterminated')}</p>
      <SourceView id={sourceId} source={html} />
    </figure>
  );
});
AssistantHtmlPending.displayName = 'AssistantHtmlPending';
