/**
 * Safe, self-contained interactive HTML for assistant replies.
 *
 * Model output never touches the host DOM. A fenced ```html block becomes an
 * iframe `srcdoc` that runs under three independent layers:
 *   1. `sandbox="allow-scripts"` (no same-origin, forms, popups, modals, downloads, top navigation),
 *   2. a meta CSP placed first in <head> that denies every network and embedding directive,
 *   3. a sanitizer plus bootstrap script that remove or neutralise what the first two cannot
 *      (self-navigation via links, WebRTC, beacons).
 * The sanitizer is hygiene only; containment comes from layers 1 and 2.
 */

export const HTML_ARTIFACT_SANDBOX = 'allow-scripts';

export const HTML_ARTIFACT_LIMITS = {
  maxSourceBytes: 96 * 1024,
  maxPlainTextChars: 2000,
  maxLivePerMessage: 3,
  minHeight: 96,
  defaultHeight: 220,
  maxHeight: 640,
  maxTitleChars: 80,
} as const;

/** Everything is denied unless named; no directive admits a network origin. */
export const HTML_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const ASSISTANT_HTML_GUIDE_MARKER = 'SPC-HTML-ARTIFACT-GUIDE';

/** Appended to the system prompt by the panel unless the prompt already carries the marker. */
export const ASSISTANT_HTML_ARTIFACT_GUIDE = [
  `[${ASSISTANT_HTML_GUIDE_MARKER}]`,
  'When an interactive visual would explain an SPC idea better than prose (sigma zones, rule windows,',
  'a capability what-if, a chart comparison), you may add ONE small ```html fenced block after your written answer.',
  'The answer must still stand on its own as text. The block must be one self-contained HTML fragment:',
  'inline <style> and <script> only, no external files, fonts, images, links, forms or network calls,',
  `under ${Math.round(HTML_ARTIFACT_LIMITS.maxSourceBytes / 1024)} KB, no vh units, and no hard-coded page background.`,
  'Theme variables available on :root: --spc-bg, --spc-fg, --spc-muted, --spc-border, --spc-accent, --spc-accent-soft,',
  '--spc-danger, --spc-warn, --spc-ok, --spc-radius, --spc-font, --spc-mono.',
  'It runs in an isolated sandbox with no access to the app, the data file, or the network, so only use numbers you were given.',
].join(' ');

export type AssistantContentBlock =
  | { type: 'markdown'; text: string }
  | { type: 'html'; html: string; artifactIndex: number }
  | { type: 'html-open'; html: string };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const LOOKS_LIKE_HTML = /<[a-z!][^>]*>/i;

const isClosingFence = (line: string, marker: string): boolean => {
  const trimmed = line.replace(/^ {0,3}/, '').trimEnd();
  return trimmed.length >= marker.length && trimmed.split('').every((char) => char === marker[0]);
};

/**
 * Splits a reply into markdown and ```html artifacts. Other fences (including ones that merely
 * mention html inside them) stay verbatim in the markdown. An html fence with no closing line is
 * returned as `html-open` and must never be run: it is either still streaming or was truncated.
 */
export const parseAssistantContent = (content: string): AssistantContentBlock[] => {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: AssistantContentBlock[] = [];
  let markdown: string[] = [];
  let artifactIndex = 0;

  const flushMarkdown = () => {
    if (markdown.length === 0) return;
    const text = markdown.join('\n');
    if (text.trim()) blocks.push({ type: 'markdown', text });
    markdown = [];
  };

  let cursor = 0;
  while (cursor < lines.length) {
    const open = FENCE_OPEN.exec(lines[cursor]);
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) {
      markdown.push(lines[cursor]);
      cursor += 1;
      continue;
    }

    const marker = open[1];
    const language = open[2].trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    let end = -1;
    for (let probe = cursor + 1; probe < lines.length; probe += 1) {
      if (isClosingFence(lines[probe], marker)) {
        end = probe;
        break;
      }
    }
    const bodyLines = lines.slice(cursor + 1, end === -1 ? lines.length : end);
    const html = bodyLines.join('\n');

    if (language === 'html' && LOOKS_LIKE_HTML.test(html)) {
      flushMarkdown();
      blocks.push(end === -1 ? { type: 'html-open', html } : { type: 'html', html, artifactIndex });
      if (end !== -1) artifactIndex += 1;
    } else {
      markdown.push(...lines.slice(cursor, end === -1 ? lines.length : end + 1));
    }
    cursor = end === -1 ? lines.length : end + 1;
  }

  flushMarkdown();
  return blocks;
};

export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

export interface HtmlArtifactBlocked {
  links: number;
  resources: number;
  embeds: number;
  navigation: number;
}

export type HtmlArtifactAssessment =
  | {
    ok: true;
    document: string;
    title: string;
    plainText: string;
    bytes: number;
    blocked: HtmlArtifactBlocked;
  }
  | { ok: false; reason: 'too-large' | 'empty' | 'unsupported'; bytes: number };

export interface HtmlArtifactBuildOptions {
  /** Per-instance secret the host checks on every message from the frame. */
  nonce: string;
  /** Host origin the frame may post to; `*` only when the host has an opaque origin. */
  targetOrigin: string;
  dir?: 'ltr' | 'rtl';
  lang?: string;
}

const BASE_CSS = [
  ':root{color-scheme:light;--spc-bg:#fff;--spc-fg:#1f2937;--spc-muted:#64748b;--spc-border:#cbd5e1;--spc-accent:#0f766e;--spc-accent-soft:#f0fdfa;--spc-danger:#b91c1c;--spc-warn:#b45309;--spc-ok:#047857;--spc-radius:8px;--spc-font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--spc-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  '*,*::before,*::after{box-sizing:border-box}',
  'html{margin:0;padding:8px;background:var(--spc-bg);color:var(--spc-fg);font:14px/1.5 var(--spc-font);-webkit-text-size-adjust:100%}',
  'body{margin:0}',
  'h1,h2,h3{line-height:1.25;margin:.7em 0 .3em;font-weight:600}h1{font-size:1.25em}h2{font-size:1.1em}h3{font-size:1em}',
  'p{margin:.4em 0}',
  'table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border:1px solid var(--spc-border);padding:.3em .5em;text-align:start}th{background:var(--spc-accent-soft)}',
  'code,kbd,pre,samp{font-family:var(--spc-mono);font-size:.92em}',
  'button,input,select,textarea{font:inherit;color:inherit}',
  'button{border:1px solid var(--spc-accent);background:var(--spc-bg);color:var(--spc-accent);border-radius:999px;padding:.25em .9em;cursor:pointer}',
  'button:hover{background:var(--spc-accent-soft)}',
  'input,select,textarea{border:1px solid var(--spc-border);border-radius:6px;padding:.25em .5em;background:var(--spc-bg)}',
  'input[type=range]{padding:0;accent-color:var(--spc-accent)}',
  ':focus-visible{outline:2px solid var(--spc-accent);outline-offset:2px}',
  'svg,img,canvas{max-width:100%}svg{height:auto}',
  '@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}',
].join('');

const jsString = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

const bootstrapScript = (nonce: string, targetOrigin: string): string => `(function(){
var N=${jsString(nonce)},O=${jsString(targetOrigin)},w=window,d=document,P=w.parent,last=-1;
function send(t,x){try{var m={spcHtmlArtifact:1,nonce:N,type:t},k;for(k in x)m[k]=x[k];P.postMessage(m,O);}catch(e){}}
function kill(n){try{Object.defineProperty(w,n,{value:undefined,configurable:false,writable:false});}catch(e){}}
['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'].forEach(kill);
try{navigator.sendBeacon=function(){return false;};}catch(e){}
try{w.open=function(){return null;};}catch(e){}
d.addEventListener('click',function(e){var t=e.target,a=t&&t.closest?t.closest('a[href],area[href]'):null;if(!a)return;if((a.getAttribute('href')||'').charAt(0)==='#')return;e.preventDefault();send('blocked',{what:'link'});},true);
d.addEventListener('submit',function(e){e.preventDefault();send('blocked',{what:'form'});},true);
function measure(){var r=d.documentElement,h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h>0&&h!==last){last=h;send('size',{height:h});}}
if(w.ResizeObserver){var ro=new ResizeObserver(measure);ro.observe(d.documentElement);d.addEventListener('DOMContentLoaded',function(){if(d.body)ro.observe(d.body);});}
else if(w.MutationObserver){d.addEventListener('DOMContentLoaded',function(){new MutationObserver(measure).observe(d.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});});}
d.addEventListener('DOMContentLoaded',measure);w.addEventListener('load',measure);
w.addEventListener('error',function(e){send('error',{message:String(e&&e.message||'Script error').slice(0,200)});});
})();`;

const REMOVED_ELEMENTS = 'base,meta,link,iframe,frame,frameset,object,embed,applet,portal,param,title';
const EMBED_ELEMENTS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal']);
const DROPPED_ATTRIBUTES = new Set(['srcdoc', 'ping', 'formaction', 'target', 'download', 'action']);
const URL_ATTRIBUTES = new Set(['src', 'poster', 'data', 'background', 'longdesc', 'manifest', 'xlink:href']);
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
]);

const isInlineSafeUrl = (value: string): boolean => /^\s*(?:data:|#)/i.test(value);

const escapeAttribute = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const collapseWhitespace = (text: string): string => text
  .replace(/[ \t\f\v\u00a0]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const extractPlainText = (root: HTMLElement): string => {
  const pieces: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      pieces.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    const name = element.tagName.toLowerCase();
    if (name === 'script' || name === 'style' || name === 'template' || name === 'noscript') return;
    const isBlock = BLOCK_ELEMENTS.has(name);
    if (isBlock) pieces.push('\n');
    element.childNodes.forEach(visit);
    if (isBlock) pieces.push('\n');
  };
  visit(root);
  return collapseWhitespace(pieces.join('')).slice(0, HTML_ARTIFACT_LIMITS.maxPlainTextChars);
};

const sanitizeDocument = (parsed: Document): HtmlArtifactBlocked => {
  const blocked: HtmlArtifactBlocked = { links: 0, resources: 0, embeds: 0, navigation: 0 };

  const cleanCss = (css: string): string => css
    .replace(/@import\b[^;{}]*;?/gi, () => {
      blocked.resources += 1;
      return '';
    })
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi, (match, doubleQuoted, singleQuoted, bare) => {
      const target = String(doubleQuoted ?? singleQuoted ?? bare ?? '');
      if (isInlineSafeUrl(target)) return match;
      blocked.resources += 1;
      return 'url("")';
    });

  parsed.querySelectorAll(REMOVED_ELEMENTS).forEach((element) => {
    const name = element.tagName.toLowerCase();
    if (EMBED_ELEMENTS.has(name)) blocked.embeds += 1;
    else if (name === 'link') blocked.resources += 1;
    else if (name === 'meta' && /refresh/i.test(element.getAttribute('http-equiv') ?? '')) blocked.navigation += 1;
    element.remove();
  });

  parsed.querySelectorAll('script[src]').forEach((element) => {
    blocked.resources += 1;
    element.remove();
  });

  parsed.querySelectorAll('style').forEach((element) => {
    element.textContent = cleanCss(element.textContent ?? '');
  });

  parsed.querySelectorAll('*').forEach((element) => {
    const name = element.tagName.toLowerCase();
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      if (DROPPED_ATTRIBUTES.has(attributeName)) {
        element.removeAttribute(attribute.name);
        if (attributeName !== 'target' && attributeName !== 'download') blocked.navigation += 1;
      } else if (attributeName === 'href' || attributeName === 'xlink:href') {
        // Fragments stay; anything else could navigate the frame or load a resource.
        if (!/^\s*#/.test(attribute.value) && !(name !== 'a' && name !== 'area' && isInlineSafeUrl(attribute.value))) {
          element.removeAttribute(attribute.name);
          if (name === 'a' || name === 'area') blocked.links += 1;
          else blocked.resources += 1;
        }
      } else if (URL_ATTRIBUTES.has(attributeName)) {
        if (!isInlineSafeUrl(attribute.value)) {
          element.removeAttribute(attribute.name);
          blocked.resources += 1;
        }
      } else if (attributeName === 'srcset') {
        const candidates = attribute.value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '');
        if (!candidates.every(isInlineSafeUrl)) {
          element.removeAttribute(attribute.name);
          blocked.resources += 1;
        }
      } else if (attributeName === 'style') {
        element.setAttribute(attribute.name, cleanCss(attribute.value));
      }
    }
  });

  return blocked;
};

const deriveTitle = (parsed: Document): string => {
  const raw = parsed.title.trim() || parsed.querySelector('h1,h2,h3')?.textContent?.trim() || '';
  const title = raw.replace(/\s+/g, ' ').slice(0, HTML_ARTIFACT_LIMITS.maxTitleChars);
  return title || '';
};

/**
 * Validates, sanitises and wraps model HTML into a standalone document. The returned `document`
 * is also what the download action saves, so the file carries the same CSP.
 */
export const assessHtmlArtifact = (source: string, options: HtmlArtifactBuildOptions): HtmlArtifactAssessment => {
  const bytes = utf8ByteLength(source);
  if (!source.trim() || !LOOKS_LIKE_HTML.test(source)) return { ok: false, reason: 'empty', bytes };
  if (bytes > HTML_ARTIFACT_LIMITS.maxSourceBytes) return { ok: false, reason: 'too-large', bytes };
  if (typeof DOMParser === 'undefined') return { ok: false, reason: 'unsupported', bytes };

  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const title = deriveTitle(parsed);
  const plainText = extractPlainText(parsed.body);
  const blocked = sanitizeDocument(parsed);

  const bodyAttributes = ['class', 'style']
    .map((name) => {
      const value = parsed.body.getAttribute(name);
      return value ? ` ${name}="${escapeAttribute(value)}"` : '';
    })
    .join('');

  const dir = options.dir === 'rtl' ? 'rtl' : 'ltr';
  const lang = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(options.lang ?? '') ? options.lang : 'en';

  // The CSP meta must precede everything the model wrote, and the bootstrap must run before its scripts.
  const standalone = [
    '<!doctype html>',
    `<html lang="${lang}" dir="${dir}"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<style>${BASE_CSS}</style>`,
    `<script>${bootstrapScript(options.nonce, options.targetOrigin)}</script>`,
    parsed.head.innerHTML,
    `</head><body${bodyAttributes}>`,
    parsed.body.innerHTML,
    '</body></html>',
  ].join('');

  return { ok: true, document: standalone, title, plainText, bytes, blocked };
};

export const clampArtifactHeight = (height: number): number => Math.min(
  HTML_ARTIFACT_LIMITS.maxHeight,
  Math.max(HTML_ARTIFACT_LIMITS.minHeight, Math.ceil(height)),
);

export type HtmlArtifactMessage =
  | { type: 'size'; height: number }
  | { type: 'error'; message: string }
  | { type: 'blocked'; what: string };

/** Accepts only well-formed messages carrying this instance's nonce; the caller also checks `event.source`. */
export const readHtmlArtifactMessage = (data: unknown, nonce: string): HtmlArtifactMessage | undefined => {
  if (typeof data !== 'object' || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message.spcHtmlArtifact !== 1 || message.nonce !== nonce) return undefined;
  if (message.type === 'size') {
    return typeof message.height === 'number' && Number.isFinite(message.height) && message.height > 0
      ? { type: 'size', height: clampArtifactHeight(message.height) }
      : undefined;
  }
  if (message.type === 'error') {
    return { type: 'error', message: typeof message.message === 'string' ? message.message.slice(0, 200) : '' };
  }
  if (message.type === 'blocked') {
    return { type: 'blocked', what: message.what === 'form' ? 'form' : 'link' };
  }
  return undefined;
};

const FILE_NAME_FORBIDDEN = '\\/:*?"<>|';

export const htmlArtifactFileName = (title: string): string => {
  // Filtered by character code so no control characters have to appear in a regex.
  const name = Array.from(title, (char) => (char.charCodeAt(0) < 32 || FILE_NAME_FORBIDDEN.includes(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return `${name || 'spc-interactive-view'}.html`;
};

export const createArtifactNonce = (): string => {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Hosts with an opaque origin (file://) cannot name a target origin. */
export const resolveTargetOrigin = (): string => {
  if (typeof window === 'undefined') return '*';
  const origin = window.location.origin;
  return origin && origin !== 'null' ? origin : '*';
};
