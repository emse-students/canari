// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKeyboardViewport, initKeyboardViewport } from './keyboardViewport.svelte';
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
      () => ({ top: composerTop, bottom: composerTop }) as DOMRect
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

describe('the baseline follows the window width, never a clock (review of #3556, F1)', () => {
  it('a rotation is a new window: the first update at the new width takes its height as the baseline', () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const teardown = initKeyboardViewport();
    // Landscape: 390 tall, 844 wide. Against the portrait baseline that is 454 px "taken" - a
    // keyboard - until a timer 400 ms after `orientationchange` reset it.
    vi.stubGlobal('innerWidth', 844);
    vi.stubGlobal('innerHeight', 390);
    vv.height = 390;
    window.dispatchEvent(new Event('resize'));
    expect(getKeyboardViewport().isOpen).toBe(false);
    // A keyboard in landscape is measured against the landscape baseline.
    vv.height = 190;
    vi.stubGlobal('innerHeight', 190);
    window.dispatchEvent(new Event('resize'));
    expect(getKeyboardViewport().isOpen).toBe(true);
    expect(getKeyboardViewport().keyboardHeight).toBe(200);
    teardown();
    vi.unstubAllGlobals();
  });
});

describe('a keyboard changing height while open reveals the focused field, through update() (second review of #3556, P2)', () => {
  let vv: EventTarget & { height: number; offsetTop: number; scale: number };
  let teardown: () => void;
  let scrollIntoView: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>;

  /** The iOS shell resizes the WebView: the layout and the visual viewport follow the keyboard. */
  const resizeTo = (h: number) => {
    vi.stubGlobal('innerHeight', h);
    vv.height = h;
    window.dispatchEvent(new Event('resize'));
  };

  beforeEach(() => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    vv = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    // A field outside the shell's layout (a modal's), which only the store reveals.
    const field = document.createElement('input');
    scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
    field.scrollIntoView = scrollIntoView;
    document.body.append(field);
    field.focus();
    teardown = initKeyboardViewport();
  });

  afterEach(() => {
    teardown();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const behaviours = () =>
    scrollIntoView.mock.calls.map((c) => (c[0] as ScrollIntoViewOptions).behavior);

  it('the emoji keyboard taller than the letters: the visible height moves, the inset stays 0 - smooth', () => {
    resizeTo(543); // the keyboard opens
    expect(behaviours()).toEqual(['auto']);
    expect(getKeyboardViewport().insetBottom).toBe(0);
    resizeTo(503); // ~40 px taller, the WebView shrunk again, with no announcement
    expect(getKeyboardViewport().insetBottom).toBe(0);
    expect(behaviours()).toEqual(['auto', 'smooth']);
  });

  it('the hand-off: the announced rise, the resize that spends it, then a change of height', () => {
    (window as unknown as { canariImeTarget: (v: unknown) => boolean }).canariImeTarget(301);
    resizeTo(543);
    expect(behaviours()).toEqual(['auto', 'auto']);
    resizeTo(583); // the predictive bar hidden: 40 px shorter
    expect(behaviours()).toEqual(['auto', 'auto', 'smooth']);
  });

  it('a resize that changes nothing reveals nothing', () => {
    resizeTo(543);
    resizeTo(543);
    vv.dispatchEvent(new Event('resize'));
    expect(behaviours()).toEqual(['auto']);
  });
});

describe('the baseline after a rotation is a SETTLED reading (second review of #3556)', () => {
  it('a first update at the new width carrying a transient, taller height ends on the settled one', () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    const vv = Object.assign(new EventTarget(), {
      width: 390,
      height: 844,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const teardown = initKeyboardViewport();
    // The turn: the layout reports the new width while its height is not final yet (430), and the
    // visual viewport, already final, disagrees with it.
    vi.stubGlobal('innerWidth', 844);
    vi.stubGlobal('innerHeight', 430);
    vv.width = 844;
    vv.height = 390;
    window.dispatchEvent(new Event('resize'));
    // Settled: the two viewports agree on 844 x 390.
    vi.stubGlobal('innerHeight', 390);
    window.dispatchEvent(new Event('resize'));
    expect(getKeyboardViewport().isOpen).toBe(false);
    // A keyboard in landscape is measured against 390, not the transient 430 a max() kept.
    vv.height = 190;
    vi.stubGlobal('innerHeight', 190);
    window.dispatchEvent(new Event('resize'));
    expect(getKeyboardViewport().keyboardHeight).toBe(200);
    teardown();
    vi.unstubAllGlobals();
  });
});
