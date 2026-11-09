// Minimal typings for the part of jsdom the sandbox tests use; the project does not ship @types/jsdom.
declare module 'jsdom' {
  export class VirtualConsole {
    constructor();
  }

  export interface JSDOMOptions {
    runScripts?: 'dangerously' | 'outside-only';
    url?: string;
    pretendToBeVisual?: boolean;
    virtualConsole?: VirtualConsole;
    beforeParse?: (window: Window & typeof globalThis) => void;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    window: Window & typeof globalThis;
  }
}
