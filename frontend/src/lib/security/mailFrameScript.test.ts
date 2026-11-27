/**
 * THE MAIL FRAME'S ONE SCRIPT IS ALLOWED BY ITS HASH, THE SAME IN EVERY POLICY THAT GOVERNS IT.
 *
 * A `srcdoc` frame runs a script only if its own policy AND its parent's allow it, so the hash of
 * `MAIL_FRAME_SCRIPT` must be in the frame's policy (`mailFramePolicy`), the web page's
 * (`WEB_POLICY_DIRECTIVES`, which nginx's `csp.conf` must equal - `csp.test.ts`) and the native
 * WebView's (`tauri.conf.json`, release and dev). The hash is written down once
 * (`MAIL_FRAME_SCRIPT_HASH`) and computed here from the text: an edit of the script that forgets
 * the hash fails HERE, naming the new one, never as a silently dead frame.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mailFramePolicy } from '$lib/mail/mailHtml';
import { WEB_POLICY_DIRECTIVES } from './cspDirectives.js';
import { MAIL_FRAME_SCRIPT, MAIL_FRAME_SCRIPT_HASH } from './mailFrameScript.js';

const computed = `sha256-${createHash('sha256').update(MAIL_FRAME_SCRIPT, 'utf8').digest('base64')}`;

describe('the mail frame script hash', () => {
  it('is the hash of the script text', () => {
    expect(MAIL_FRAME_SCRIPT_HASH, `write ${computed} in the three places`).toBe(computed);
  });

  it("is the only script the frame's own policy allows", () => {
    for (const shown of [false, true]) {
      const scriptSrc = mailFramePolicy(shown)
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('script-src'));
      expect(scriptSrc).toBe(`script-src '${computed}'`);
    }
  });

  it('is in the web page policy, and so in nginx csp.conf', () => {
    expect(WEB_POLICY_DIRECTIVES['script-src']).toContain(computed);
    const dockerfile = readFileSync(
      resolve(process.cwd(), '../infrastructure/local/Dockerfile.frontend'),
      'utf8'
    );
    expect(dockerfile).toContain(computed);
  });

  it('is in the native WebView policy, release and dev', () => {
    const security = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')
    ).app.security;
    expect(security.csp['script-src'].split(/\s+/)).toContain(`'${computed}'`);
    expect(security.devCsp['script-src'].split(/\s+/)).toContain(`'${computed}'`);
  });

  it('carries nothing that would end its element early', () => {
    expect(MAIL_FRAME_SCRIPT).not.toMatch(/<\/script/i);
  });
});

describe("the parent's frame-src is load-bearing for the mail frame (second review, I-3)", () => {
  it("stays 'self' in the web page policy (= nginx) and the native WebView's", () => {
    // The mail frame is a frame of the app's page: a change of the page's `frame-src` decides
    // whether it is drawn at all, and must be re-read against `MailHtmlFrame` on every platform.
    expect(WEB_POLICY_DIRECTIVES['frame-src']).toEqual(['self']);
    const security = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')
    ).app.security;
    expect(security.csp['frame-src']).toBe("'self'");
    expect(security.devCsp['frame-src']).toBe("'self'");
  });
});

/**
 * Runs the frame's script against stand-ins for its document, so what it MEASURES can be checked
 * without a layout engine: `frameHeight` is the height the parent drew the frame at, which the
 * html and body boxes follow (`html,body{height:100%}` with `padding-bottom:1px`, the creep the
 * second review found); `contentEnd` is where the content really ends.
 */
function runScript(geometry: { frameHeight: number; contentEnd: number }) {
  const posts: unknown[] = [];
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  let resize: (() => void) | null = null;
  const children: unknown[] = [];
  const body = {
    get lastElementChild() {
      return children.at(-1) ?? null;
    },
    appendChild(child: unknown) {
      const at = children.indexOf(child);
      if (at !== -1) children.splice(at, 1);
      children.push(child);
    },
    // What a box measure would read: the frame's own height plus the mail's one pixel of padding.
    get scrollHeight() {
      return geometry.frameHeight + 1;
    },
  };
  const document = {
    body,
    documentElement: {
      getBoundingClientRect: () => ({ top: 0, height: geometry.frameHeight + 1 }),
    },
    createElement: () => ({
      style: { setProperty: () => {} },
      getBoundingClientRect: () => ({ top: geometry.contentEnd }),
    }),
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  const window = { scrollY: 0, addEventListener: () => {} };
  const parent = { postMessage: (message: unknown) => posts.push(message) };
  const getComputedStyle = () => ({
    paddingBottom: '1px',
    borderBottomWidth: '0px',
    marginBottom: '0px',
  });
  class ResizeObserver {
    constructor(cb: () => void) {
      resize = cb;
    }
    observe() {}
  }
  new Function(
    'document',
    'window',
    'parent',
    'getComputedStyle',
    'ResizeObserver',
    MAIL_FRAME_SCRIPT
  )(document, window, parent, getComputedStyle, ResizeObserver);
  return { posts, listeners, resize: () => resize?.(), children };
}

describe('the frame script', () => {
  it('measures the content, not the boxes: a frame grown to the reported height reports no more (I-1)', () => {
    const geometry = { frameHeight: 160, contentEnd: 300 };
    const run = runScript(geometry);
    expect(run.posts).toEqual([{ type: 'mail-frame-height', h: 301 }]);
    // The parent draws the frame at the reported height, then again one pixel taller each round, as a
    // box measure would have asked: every resize measures again, and nothing new is reported.
    for (let round = 0; round < 5; round++) {
      geometry.frameHeight = 301 + round;
      run.resize();
    }
    expect(run.posts).toHaveLength(1);
    // The content growing is reported.
    geometry.contentEnd = 420;
    run.resize();
    expect(run.posts.at(-1)).toEqual({ type: 'mail-frame-height', h: 421 });
  });

  it('keeps its zero-height marker last in the body', () => {
    const run = runScript({ frameHeight: 160, contentEnd: 10 });
    const marker = run.children.at(-1);
    run.children.push({ late: 'node' });
    run.resize();
    expect(run.children.at(-1)).toBe(marker);
  });

  it('hands a pressed link over once, and ignores a held Enter key (M-1)', () => {
    const run = runScript({ frameHeight: 160, contentEnd: 10 });
    const link = { getAttribute: () => 'https://a.test' };
    const target = { closest: () => link };
    const press = (extra: object) => ({ target, preventDefault: () => {}, ...extra });
    run.listeners.keydown[0](press({ key: 'Enter', repeat: false }));
    run.listeners.keydown[0](press({ key: 'Enter', repeat: true }));
    run.listeners.keydown[0](press({ key: 'Enter', repeat: true }));
    run.listeners.click[0](press({}));
    const links = run.posts.filter((p) => (p as { type: string }).type === 'mail-frame-link');
    expect(links).toEqual([
      { type: 'mail-frame-link', href: 'https://a.test' },
      { type: 'mail-frame-link', href: 'https://a.test' },
    ]);
  });
});
