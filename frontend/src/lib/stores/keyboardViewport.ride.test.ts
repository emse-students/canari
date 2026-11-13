// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKeyboardViewport } from './keyboardViewport.svelte';
import { rideKeyframes } from './keyboardRide';
import { Log } from '$lib/utils/Log';

/**
 * The fall ride as `initKeyboardViewport` wires it (`keyboardRide.ts`): the iOS shell's announcement
 * captures the pieces, the resize that closes the keyboard arms the ride, and the ride starts after
 * the resize's layout reactions - here run at once, the browser's `ResizeObserver` being the seam.
 */
vi.mock('$lib/mls-client/mlsPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/mlsPlatform')>()),
  detectRuntimeDeviceOs: () => 'ios',
}));

type Hooks = {
  canariKeyboardFall?: (v: unknown) => boolean;
  canariImeTarget?: (v: unknown) => boolean;
};
const hooks = () => window as unknown as Hooks;
const FALL = { durationMs: 250, curve: 7, fromPx: 301 };

describe('the keyboard fall ride, wired', () => {
  let vv: EventTarget & { height: number; offsetTop: number; scale: number };
  let teardown: () => void;
  let reduced = false;
  let composerTop = 508;
  let animate: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;

  const resizeTo = (h: number) => {
    vi.stubGlobal('innerHeight', h);
    vv.height = h;
    window.dispatchEvent(new Event('resize'));
  };

  beforeEach(() => {
    reduced = false;
    composerTop = 508;
    vi.stubGlobal('innerHeight', 844);
    vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce') }));
    const composer = document.createElement('div');
    composer.dataset.keyboardRide = 'box';
    vi.spyOn(composer, 'getBoundingClientRect').mockImplementation(
      () => ({ top: composerTop }) as DOMRect
    );
    cancel = vi.fn();
    animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel }));
    (composer as unknown as { animate: typeof animate }).animate = animate;
    document.body.append(composer);
    teardown = initKeyboardViewport({ afterLayout: (_targets, start) => (start(), () => {}) });
    resizeTo(543); // the keyboard is up
  });

  afterEach(() => {
    teardown();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the announcement captures; the resize that closes the keyboard starts the ride', () => {
    expect(hooks().canariKeyboardFall?.(FALL)).toBe(true);
    expect(animate).not.toHaveBeenCalled();
    composerTop = 787;
    resizeTo(844);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(rideKeyframes(279), {
      duration: 250,
      easing: expect.stringContaining('cubic-bezier'),
    });
  });

  it('a rise between the announcement and the resize clears the pending ride', () => {
    hooks().canariKeyboardFall?.(FALL);
    hooks().canariImeTarget?.(301);
    composerTop = 787;
    resizeTo(844);
    expect(animate).not.toHaveBeenCalled();
  });

  it('a rise during a running ride cancels its animations', () => {
    hooks().canariKeyboardFall?.(FALL);
    composerTop = 787;
    resizeTo(844);
    expect(cancel).not.toHaveBeenCalled();
    hooks().canariImeTarget?.(301);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a press during a running ride cancels it', () => {
    hooks().canariKeyboardFall?.(FALL);
    composerTop = 787;
    resizeTo(844);
    window.dispatchEvent(new Event('pointerdown'));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reduced motion: no ride, and nothing said above debug', () => {
    reduced = true;
    const warn = vi.spyOn(Log, 'w');
    expect(hooks().canariKeyboardFall?.(FALL)).toBe(false);
    composerTop = 787;
    resizeTo(844);
    expect(animate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a page already full height when the fall is announced: no ride, and a WARN - the order broke', () => {
    resizeTo(844);
    const warn = vi.spyOn(Log, 'w');
    expect(hooks().canariKeyboardFall?.(FALL)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(animate).not.toHaveBeenCalled();
  });

  it('a hardware shortcut bar never opened the page: no ride, silently', () => {
    resizeTo(844);
    const warn = vi.spyOn(Log, 'w');
    expect(hooks().canariKeyboardFall?.({ ...FALL, fromPx: 55 })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
