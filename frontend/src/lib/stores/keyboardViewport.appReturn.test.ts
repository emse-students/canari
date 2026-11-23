// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKeyboardViewport } from './keyboardViewport.svelte';
import {
  keyboardTransitionCount,
  keyboardTransitionMoving,
  noteKeyboardAtRest,
} from './keyboardTransition';

/**
 * THE KEYBOARD COMES BACK WITH THE APP (iPhone 12, `1.8.0-alpha.4`, 2026-11-23): the app hidden with
 * the keyboard open, in the iOS shell, starts a keyboard transition, which the shell's did-show at the
 * return brings to rest - so WebKit's reveal at the return is put back like a rise's
 * (docs/wiki/frontend/modules/chat.md).
 */
let os = 'ios';
vi.mock('$lib/mls-client/mlsPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/mlsPlatform')>()),
  detectRuntimeDeviceOs: () => os,
}));

type Hooks = { canariKeyboardAtRest?: () => void; __TAURI_INTERNALS__?: unknown };
const hooks = () => window as unknown as Hooks;

describe('the app hidden with the keyboard open', () => {
  let teardown: () => void;
  let visibility: DocumentVisibilityState = 'visible';

  const resizeTo = (h: number) => {
    vi.stubGlobal('innerHeight', h);
    (window.visualViewport as unknown as { height: number }).height = h;
    window.dispatchEvent(new Event('resize'));
  };
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    os = 'ios';
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    hooks().__TAURI_INTERNALS__ = {};
    vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal(
      'visualViewport',
      Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 })
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    teardown = initKeyboardViewport({ afterLayout: (_targets, start) => (start(), () => {}) });
    noteKeyboardAtRest('test start');
  });

  afterEach(() => {
    teardown();
    delete hooks().__TAURI_INTERNALS__;
    Reflect.deleteProperty(document, 'visibilityState');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts a transition at the hidden edge, which the shell rests at the return', () => {
    resizeTo(543); // the keyboard is up
    hooks().canariKeyboardAtRest?.();
    expect(keyboardTransitionMoving()).toBe(false);
    const before = keyboardTransitionCount();

    setVisibility('hidden');
    expect(keyboardTransitionCount()).toBe(before + 1);
    expect(keyboardTransitionMoving()).toBe(true);

    // The return: the WebView comes back at the size it left with, so no resize starts anything.
    setVisibility('visible');
    resizeTo(543);
    expect(keyboardTransitionCount()).toBe(before + 1);
    expect(keyboardTransitionMoving()).toBe(true);

    // The shell's did-show at the return, after WebKit's reveal.
    hooks().canariKeyboardAtRest?.();
    expect(keyboardTransitionMoving()).toBe(false);
  });

  it('starts nothing when the keyboard is closed', () => {
    const before = keyboardTransitionCount();
    setVisibility('hidden');
    expect(keyboardTransitionCount()).toBe(before);
    expect(keyboardTransitionMoving()).toBe(false);
  });

  it('starts nothing outside the iOS shell, where no engine makes the move', () => {
    os = 'android';
    delete hooks().__TAURI_INTERNALS__;
    resizeTo(543);
    const before = keyboardTransitionCount();
    setVisibility('hidden');
    expect(keyboardTransitionCount()).toBe(before);
    expect(keyboardTransitionMoving()).toBe(false);
  });
});
