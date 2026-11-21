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

type Listener = (event: Record<string, unknown>) => void;

/** Runs the guard in a bare context standing in for a page, and returns what it did. */
function runGuard(userAgent: string, language = 'fr-FR') {
  const listeners: Record<string, Listener[]> = {};
  const appended: any[] = [];
  const makeElement = (tag: string): any => ({
    tag,
    style: {},
    children: [] as any[],
    setAttribute() {},
    appendChild(child: any) {
      this.children.push(child);
      return child;
    },
  });
  const window: any = {
    addEventListener: (name: string, fn: Listener) => (listeners[name] ??= []).push(fn),
  };
  const document = {
    body: { appendChild: (el: any) => appended.push(el) },
    createElement: makeElement,
    createTextNode: (text: string) => ({ text }),
    addEventListener() {},
  };
  const context = vm.createContext({ window, document, navigator: { userAgent, language } });
  vm.runInContext(guardSource, context);
  return { window, listeners, appended };
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
    // Chrome itself (no "; wv)") updates by itself: not this guard's business.
    [ANDROID_WEBVIEW(90).replace('; wv)', ')'), false],
    // Desktop and iOS never match.
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/90.0.0.0 Safari/537.36', false],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', false],
    // No Chrome token at all: nothing to compare.
    ['Mozilla/5.0 (Linux; Android 8.0; wv) AppleWebKit/537.36', false],
  ])('isBelowFloor(%s) is %s', (ua, expected) => {
    expect(guard().isBelowFloor(ua)).toBe(expected);
  });

  it('reads the Chrome major', () => {
    expect(guard().chromeMajor(ANDROID_WEBVIEW(67))).toBe(67);
    expect(guard().chromeMajor('nothing')).toBeNull();
  });

  it('tells a SyntaxError from a network failure', () => {
    expect(guard().isSyntaxFailure({ name: 'SyntaxError' }, '')).toBe(true);
    expect(guard().isSyntaxFailure(null, "Uncaught SyntaxError: Unexpected token '?'")).toBe(true);
    expect(guard().isSyntaxFailure({ name: 'TypeError' }, 'Failed to fetch')).toBe(false);
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

  it('on a current WebView draws nothing until a SyntaxError arrives before the app mounted', () => {
    const { appended, listeners } = runGuard(ANDROID_WEBVIEW(120));
    expect(appended).toHaveLength(0);
    listeners.error[0]({ error: { name: 'TypeError' }, message: 'x' });
    expect(appended).toHaveLength(0);
    listeners.error[0]({ error: { name: 'SyntaxError' }, message: 'x' });
    expect(appended).toHaveLength(1);
  });

  it('a SyntaxError that rejects the bundle import also draws it, once', () => {
    const { appended, listeners } = runGuard(ANDROID_WEBVIEW(120));
    listeners.unhandledrejection[0]({ reason: { name: 'SyntaxError' } });
    listeners.unhandledrejection[0]({ reason: { name: 'SyntaxError' } });
    expect(appended).toHaveLength(1);
  });

  it('draws nothing once the layout has mounted', () => {
    const { appended, listeners, window } = runGuard(ANDROID_WEBVIEW(120));
    window.__canariMounted = true;
    listeners.error[0]({ error: { name: 'SyntaxError' }, message: 'x' });
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
    expect(keys.sort()).toEqual(['body', 'button', 'fallback', 'title', 'version']);
    for (const key of keys) {
      expect(messages(lang)[`webview_outdated_${key}`], `${lang}.${key}`).toBe(table[lang][key]);
    }
  });
});
