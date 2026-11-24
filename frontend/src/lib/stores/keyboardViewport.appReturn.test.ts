// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKeyboardViewport } from './keyboardViewport.svelte';
import {
  keyboardTransitionCount,
  keyboardTransitionMoving,
  noteKeyboardAtRest,
} from './keyboardTransition';

/**
 * THE KEYBOARD COMES BACK WITH THE APP (iPhone 12, `1.8.0-alpha.4`, 2026-11-23): the app returns at the
 * WebView size it left with, so no resize starts a transition; the shell's will-show
 * (`canariKeyboardShows`) does, and its did-show or did-hide (`canariKeyboardAtRest`) rests it - a fact
 * at both ends (docs/wiki/frontend/modules/chat.md).
 */
vi.mock('$lib/mls-client/mlsPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/mlsPlatform')>()),
  detectRuntimeDeviceOs: () => 'ios',
}));

type Hooks = {
  canariKeyboardAtRest?: () => void;
  canariKeyboardShows?: () => void;
  canariImeTarget?: (v: unknown) => boolean;
  __TAURI_INTERNALS__?: unknown;
};
const hooks = () => window as unknown as Hooks;

describe('a keyboard the shell says will show', () => {
  let teardown: () => void;

  const resizeTo = (h: number) => {
    vi.stubGlobal('innerHeight', h);
    (window.visualViewport as unknown as { height: number }).height = h;
    window.dispatchEvent(new Event('resize'));
  };

  beforeEach(() => {
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts a transition at the same size, which the did-show rests', () => {
    resizeTo(543); // the keyboard is up, and the app leaves and returns at this size
    hooks().canariKeyboardAtRest?.();
    const before = keyboardTransitionCount();

    hooks().canariKeyboardShows?.();
    resizeTo(543); // nothing changes for the page's own reading
    expect(keyboardTransitionCount()).toBe(before + 1);
    expect(keyboardTransitionMoving()).toBe(true);

    hooks().canariKeyboardAtRest?.();
    expect(keyboardTransitionMoving()).toBe(false);
  });

  it('a show that is cancelled rests on its did-hide: nothing is left moving', () => {
    resizeTo(543);
    hooks().canariKeyboardAtRest?.();
    hooks().canariKeyboardShows?.();
    resizeTo(844); // the field lost the keyboard instead
    hooks().canariKeyboardAtRest?.(); // did-hide
    expect(keyboardTransitionMoving()).toBe(false);
  });

  it('a rise counts once: the will-show and the resize are one transition', () => {
    const before = keyboardTransitionCount();
    hooks().canariKeyboardShows?.();
    resizeTo(543);
    expect(keyboardTransitionCount()).toBe(before + 1);
    hooks().canariKeyboardAtRest?.();
    expect(keyboardTransitionMoving()).toBe(false);
  });

  it('a will-show while a transition is already moving belongs to it', () => {
    resizeTo(543);
    const moving = keyboardTransitionCount();
    expect(keyboardTransitionMoving()).toBe(true);
    hooks().canariKeyboardShows?.();
    expect(keyboardTransitionCount()).toBe(moving);
    hooks().canariKeyboardAtRest?.();
    expect(keyboardTransitionMoving()).toBe(false);
  });

  /**
   * THE KEYBOARD COMES BACK WITH NO ANIMATION (iPhone 12, `1.8.0-alpha.6`, 5 returns of 11): its rest can
   * reach the page before the WebView's frame is set, so the transition rests on BOTH - the shell's word
   * and the hand-off spent by the resize - in whichever order they come.
   */
  it('a rest before the hand-off is spent waits for the resize', () => {
    hooks().canariKeyboardShows?.();
    expect(hooks().canariImeTarget?.(301)).toBe(true);
    hooks().canariKeyboardAtRest?.(); // the did-show, ahead of the frame
    expect(keyboardTransitionMoving()).toBe(true);
    resizeTo(543); // the frame lands: the target is spent
    expect(keyboardTransitionMoving()).toBe(false);
  });

  it('a hand-off spent before the rest leaves the rest to the shell', () => {
    hooks().canariKeyboardShows?.();
    hooks().canariImeTarget?.(301);
    resizeTo(543);
    expect(keyboardTransitionMoving()).toBe(true);
    hooks().canariKeyboardAtRest?.();
    expect(keyboardTransitionMoving()).toBe(false);
  });

  /**
   * A FRESH FOCUS IN THE MAIN PAGE IS REVEALED BY THE PAGE (review of #4058): in the iOS shell WebKit's
   * reveal is detached with its keyboard observers, so the hand-off's opening must scroll a field of
   * `.app-layout` into view itself - once on the announced layout, once on the resize that spends it.
   */
  it("reveals a focused field of the main page on the keyboard's opening, the composer never", () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const layout = document.createElement('div');
    layout.className = 'app-layout';
    const field = document.createElement('input');
    const reveal = vi.fn();
    field.scrollIntoView = reveal;
    const footer = document.createElement('footer');
    footer.className = 'chat-composer-footer';
    const composer = document.createElement('textarea');
    const composerReveal = vi.fn();
    composer.scrollIntoView = composerReveal;
    footer.appendChild(composer);
    layout.append(field, footer);
    document.body.appendChild(layout);
    try {
      field.focus();
      hooks().canariImeTarget?.(301);
      resizeTo(543);
      expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
      resizeTo(844);
      hooks().canariKeyboardAtRest?.();
      composer.focus();
      hooks().canariImeTarget?.(301);
      resizeTo(543);
      expect(composerReveal).not.toHaveBeenCalled();
    } finally {
      layout.remove();
    }
  });

  it('the hook is withdrawn at teardown', () => {
    teardown();
    expect(hooks().canariKeyboardShows).toBeUndefined();
    teardown = () => {};
  });
});
