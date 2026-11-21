/**
 * The old-Android-WebView guard of `src/app.html` (docs/wiki/frontend/mobile.md#an-old-android-system-webview-shows-an-update-screen-not-a-blank-page-owner-2026-11-21).
 *
 * The guard is an inline script that must parse on ANY engine, so these tests read it out of the
 * real file (never a copy) and check three things: it is ES5, its decisions are right, and its
 * string table says what the Paraglide messages say.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { inlineScripts } from './cspPolicy.js';

const root = resolve(import.meta.dirname, '../../..');
const appHtml = readFileSync(resolve(root, 'src/app.html'), 'utf8');
const guardSource = inlineScripts(appHtml).find((s) => s.includes('CANARI_WEBVIEW_GUARD'))!;

const ANDROID_WEBVIEW = (chrome: number) =>
  `Mozilla/5.0 (Linux; Android 12; SM-G950F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${chrome}.0.0.0 Mobile Safari/537.36`;
/** The same engine in a plain browser tab: no "; wv)" marker. */
const CHROME_ANDROID = (chrome: number) => ANDROID_WEBVIEW(chrome).replace('; wv)', ')');
const APP_ASSET = 'https://dev.example/_app/immutable/chunks/x.js';

type Listener = (event: Record<string, unknown>) => void;

/** Runs the guard in a bare context standing in for a page, and returns what it did. */
function runGuard(userAgent: string, language = 'fr-FR') {
  const listeners: Record<string, Listener[]> = {};
  const appended: any[] = [];
  const errors: string[] = [];
  const makeElement = (tag: string): any => ({
    tag,
    style: {},
    children: [] as any[],
    setAttribute() {},
    addEventListener() {},
    appendChild(child: any) {
      this.children.push(child);
      return child;
    },
  });
  const body: any = {
    appendChild(el: any) {
      appended.push(el);
      el.parentNode = body;
    },
    removeChild(el: any) {
      appended.splice(appended.indexOf(el), 1);
    },
  };
  const console = { error: (text: string) => errors.push(text) };
  const window: any = {
    console,
    addEventListener: (name: string, fn: Listener) => (listeners[name] ??= []).push(fn),
  };
  const document = {
    body,
    createElement: makeElement,
    createTextNode: (text: string) => ({ text }),
    getElementById: (id: string) => appended.find((el) => el.id === id) ?? null,
    addEventListener() {},
  };
  const context = vm.createContext({
    window,
    document,
    console,
    navigator: { userAgent, language },
  });
  vm.runInContext(guardSource, context);
  return { window, listeners, appended, errors };
}

const textOf = (el: any): string => el.text ?? [el.children ?? []].flat().map(textOf).join(' ');

describe('the guard is ES5 (it runs before anything else can)', () => {
  it('parses as ECMAScript 5', () => {
    expect(() => parse(guardSource, { ecmaVersion: 5 })).not.toThrow();
  });

  it('is found in app.html and hashed by the CSP like every inline script', () => {
    expect(guardSource).toContain('var FLOOR = 111;');
  });

  it('would be caught if ES2015 syntax crept in', () => {
    expect(() => parse('const a = () => `x`;', { ecmaVersion: 5 })).toThrow();
  });

  it('never reads an error message to decide', () => {
    expect(guardSource).not.toMatch(/\.message/);
  });

  it('links to https, never market://', () => {
    expect(guardSource).not.toContain('market:');
    expect(guardSource).toContain(
      "'https://play.google.com/store/apps/details?id=com.google.android.webview'"
    );
  });
});

describe('the version floor', () => {
  const guard = () => runGuard(ANDROID_WEBVIEW(120)).window.__canariWebViewGuard;

  it('names the floor once, at 111 (Vite default target)', () => {
    expect(guard().FLOOR).toBe(111);
  });

  it.each([
    [ANDROID_WEBVIEW(110), true],
    [ANDROID_WEBVIEW(111), false],
    [ANDROID_WEBVIEW(64), true],
    [ANDROID_WEBVIEW(131), false],
    ['Mozilla/5.0 (Linux; Android 8.0; wv) AppleWebKit/537.36', false],
  ])('isBelowFloor(%s) is %s', (ua, expected) => {
    expect(guard().isBelowFloor(ua)).toBe(expected);
  });

  it('tells a WebView from Chrome', () => {
    expect(guard().isAndroidWebView(ANDROID_WEBVIEW(90))).toBe(true);
    expect(guard().isAndroidWebView(CHROME_ANDROID(90))).toBe(false);
  });

  it('reads the Chrome major', () => {
    expect(guard().chromeMajor(ANDROID_WEBVIEW(67))).toBe(67);
    expect(guard().chromeMajor('nothing')).toBeNull();
  });

  it('knows a bundle parse failure by its type and its source, never its message', () => {
    const syntax = { name: 'SyntaxError', stack: '' };
    expect(guard().isBundleParseFailure(syntax, APP_ASSET)).toBe(true);
    expect(
      guard().isBundleParseFailure({ name: 'SyntaxError', stack: `at ${APP_ASSET}:1` }, '')
    ).toBe(true);
    // JSON.parse of an HTML body: a SyntaxError, but not from an app asset.
    expect(guard().isBundleParseFailure(syntax, 'https://dev.example/portal')).toBe(false);
    expect(guard().isBundleParseFailure(syntax, '')).toBe(false);
    expect(guard().isBundleParseFailure({ name: 'TypeError', stack: APP_ASSET }, APP_ASSET)).toBe(
      false
    );
  });
});

describe('what the guard does on a page', () => {
  it('draws the update screen at once on a WebView below the floor, with the version', () => {
    const { appended, listeners } = runGuard(ANDROID_WEBVIEW(67));
    expect(appended).toHaveLength(1);
    const text = textOf(appended[0]);
    expect(text).toContain('Mettez à jour Android System WebView');
    expect(text).toContain('Version détectée : 67');
    expect(listeners.error).toBeUndefined();
  });

  it('speaks English when the phone does', () => {
    const { appended } = runGuard(ANDROID_WEBVIEW(67), 'en-GB');
    expect(textOf(appended[0])).toContain('Update Android System WebView');
  });

  it('does nothing on a desktop or an iOS agent', () => {
    for (const ua of [
      'Mozilla/5.0 (Windows NT 10.0) Chrome/90.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    ]) {
      const { appended, listeners } = runGuard(ua);
      expect(appended).toHaveLength(0);
      expect(listeners.error).toBeUndefined();
    }
  });

  it('a JSON.parse-style SyntaxError before mount does NOT draw the screen', () => {
    for (const chrome of [120, 67]) {
      const { appended, listeners } = runGuard(CHROME_ANDROID(chrome));
      const error = { name: 'SyntaxError', stack: 'at JSON.parse (<anonymous>)' };
      listeners.error[0]({ error, filename: '' });
      listeners.unhandledrejection[0]({ reason: error });
      expect(appended).toHaveLength(0);
    }
  });

  it('a SyntaxError from a non-/_app/ source does not draw it', () => {
    const { appended, listeners } = runGuard(CHROME_ANDROID(67));
    listeners.error[0]({
      error: { name: 'SyntaxError', stack: '' },
      filename: 'chrome-extension://abc/inject.js',
    });
    expect(appended).toHaveLength(0);
  });

  it('a bundle parse failure at or above the floor logs an error and draws nothing', () => {
    const { appended, listeners, errors } = runGuard(CHROME_ANDROID(120));
    listeners.error[0]({ error: { name: 'SyntaxError', stack: '' }, filename: APP_ASSET });
    expect(appended).toHaveLength(0);
    expect(errors.join('\n')).toContain('not an old WebView');
  });

  it('a bundle parse failure on an old non-WebView Android engine draws it, once', () => {
    const { appended, listeners } = runGuard(CHROME_ANDROID(67));
    listeners.error[0]({ error: { name: 'SyntaxError', stack: '' }, filename: APP_ASSET });
    listeners.unhandledrejection[0]({
      reason: { name: 'SyntaxError', stack: `at ${APP_ASSET}` },
    });
    expect(appended).toHaveLength(1);
  });

  it('removes the screen, and says so, when the app mounts anyway', () => {
    const { appended, window, errors } = runGuard(ANDROID_WEBVIEW(67));
    expect(appended).toHaveLength(1);
    window.__canariWebViewGuard.mounted();
    expect(appended).toHaveLength(0);
    expect(errors.join('\n')).toContain('screen removed');
  });

  it('draws nothing once the layout has mounted', () => {
    const { appended, listeners, window } = runGuard(CHROME_ANDROID(67));
    window.__canariWebViewGuard.mounted();
    listeners.error[0]({ error: { name: 'SyntaxError', stack: '' }, filename: APP_ASSET });
    expect(appended).toHaveLength(0);
  });
});

describe('the string table follows the Paraglide messages', () => {
  const messages = (lang: string) =>
    JSON.parse(readFileSync(resolve(root, `messages/${lang}.json`), 'utf8')) as Record<
      string,
      string
    >;
  const table = runGuard(ANDROID_WEBVIEW(120)).window.__canariWebViewGuard.STRINGS as Record<
    string,
    Record<string, string>
  >;

  it.each(['fr', 'en'])('%s: every entry equals webview_outdated_<key>', (lang) => {
    const keys = Object.keys(table[lang]);
    expect(keys.sort()).toEqual(['body', 'button', 'title', 'version']);
    for (const key of keys) {
      expect(messages(lang)[`webview_outdated_${key}`], `${lang}.${key}`).toBe(table[lang][key]);
    }
  });
});
