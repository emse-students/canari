// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  declareKeyboardOverlay,
  getKeyboardViewport,
  initKeyboardViewport,
  onKeyboardInsetChange,
} from './keyboardViewport.svelte';
import { rideKeyframes } from './keyboardRide';
import { Log } from '$lib/utils/Log';

/**
 * THE ANDROID KEYBOARD RIDE AS `initKeyboardViewport` WIRES IT (keyboard ride, 2026-11-14): the shell
 * announces `{ px, durationMs, curve }`, the page captures every riding piece where it stands, lays
 * itself out over the keyboard at once (the shell keeps its height, the insets carry the room), and
 * the pieces ride from where they stood - the composer by its box, the thread by its rows - once the
 * layout reactions have run (the seam runs them at once).
 */
vi.mock('$lib/mls-client/mlsPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/mls-client/mlsPlatform')>()),
  detectRuntimeDeviceOs: () => 'android',
}));

const glide = vi.hoisted(() => ({
  takeOff: vi.fn((_scroller: Element) => false),
  attachRide: vi.fn((_scroller: Element, _fromPx: number, _animations: Animation[]) => {}),
}));
vi.mock('$lib/utils/chat/threadGrowthObserver', () => ({
  takeThreadGlideOff: glide.takeOff,
  attachThreadRide: glide.attachRide,
}));

type Hooks = { canariImeTarget?: (v: unknown) => boolean };
const hooks = () => window as unknown as Hooks;

// Mi 9T: a 945 CSS px window, a 357.98 CSS px keyboard, the synced animation's 285 ms.
const BASELINE = 945;
const KB = 357.98;
const CURVE = [0, 0.4, 0.7, 0.9, 1];
const RISE = { px: KB, durationMs: 285, curve: CURVE };
const FALL = { px: 0, durationMs: 285, curve: CURVE };
const TIMING = { duration: 285, easing: 'linear(0, 0.4, 0.7, 0.9, 1)' };

const root = () => document.documentElement.style;
/** What the page laid out: the keyboard's room, read back from the variable the CSS reads. */
const inset = () => parseFloat(root().getPropertyValue('--keyboard-layout-inset-bottom')) || 0;

describe('the Android keyboard ride, wired', () => {
  let teardown: () => void;
  let reduced = false;
  let composerAnimate: ReturnType<typeof vi.fn>;
  let threadAnimate: ReturnType<typeof vi.fn>;
  let rowAnimates: ReturnType<typeof vi.fn>[];
  let cancel: ReturnType<typeof vi.fn>;
  /** The test clock the rides are phased on. */
  let clock = 0;
  /** How far below its place a running ride draws the composer; a cancel puts it back to 0. */
  let drawnOffset = 0;
  /** What was read and written, in order, while `trace` is on (D3). */
  let trace: string[] | null = null;
  /** The ride starts the seam has not run yet, when it defers them. */
  let deferred: (() => void)[] | null = null;

  /** An element whose `animate` is recorded and whose top follows the layout through `top()`. */
  function piece(top: () => number) {
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => {
      trace?.push('read');
      const at = top();
      return { top: at, bottom: at } as DOMRect;
    });
    const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel }));
    (el as unknown as { animate: typeof animate }).animate = animate;
    return { el, animate };
  }

  beforeEach(() => {
    reduced = false;
    vi.stubGlobal('innerHeight', BASELINE);
    const vv = Object.assign(new EventTarget(), { height: BASELINE, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce') }));
    clock = 0;
    drawnOffset = 0;
    trace = null;
    deferred = null;
    cancel = vi.fn(() => {
      drawnOffset = 0;
    });
    // The composer stands on the keyboard; the thread's rows are pinned to the bottom above it.
    const composer = piece(() => 880 - inset() + drawnOffset);
    composer.el.dataset.keyboardRide = 'box';
    composerAnimate = composer.animate;
    const thread = piece(() => 0);
    thread.el.dataset.keyboardRide = 'last-row';
    threadAnimate = thread.animate;
    const rows = [piece(() => 700 - inset()), piece(() => 800 - inset())];
    rowAnimates = rows.map((r) => r.animate);
    thread.el.append(...rows.map((r) => r.el));
    document.body.append(thread.el, composer.el);
    teardown = initKeyboardViewport({
      afterLayout: (_targets, start) => {
        if (deferred) deferred.push(start);
        else start();
        return () => {};
      },
      now: () => clock,
    });
  });

  afterEach(() => {
    teardown();
    document.body.innerHTML = '';
    // The globals a case installs go back here, so a failing assertion cannot leak them into the
    // next case (review of #3556): the shell's bridge and the engine's keyboard API.
    delete (window as unknown as { canariIme?: unknown }).canariIme;
    Reflect.deleteProperty(navigator, 'virtualKeyboard');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    glide.takeOff.mockClear();
    glide.attachRide.mockClear();
  });

  it('a rise: the shell keeps its height, both insets carry the keyboard, and the pieces ride UP', () => {
    expect(hooks().canariImeTarget?.(RISE)).toBe(true);
    expect(root().getPropertyValue('--app-viewport-height')).toBe(`${BASELINE}px`);
    expect(root().getPropertyValue('--keyboard-layout-inset-bottom')).toBe(`${KB}px`);
    expect(root().getPropertyValue('--keyboard-occlusion-bottom')).toBe(`${KB}px`);
    expect(getKeyboardViewport().isOpen).toBe(true);
    // Each piece starts where it stood, KB lower, and rides up to its place.
    expect(composerAnimate).toHaveBeenCalledWith(rideKeyframes(-KB), TIMING);
    for (const animate of rowAnimates)
      expect(animate).toHaveBeenCalledWith(rideKeyframes(-KB), TIMING);
    // The thread's box never moves: its room for the keyboard is its padding.
    expect(threadAnimate).not.toHaveBeenCalled();
    expect(glide.takeOff).toHaveBeenCalledTimes(1);
  });

  it('a fall: the insets go back to 0 and the pieces ride DOWN', () => {
    hooks().canariImeTarget?.({ px: KB });
    composerAnimate.mockClear();
    expect(hooks().canariImeTarget?.(FALL)).toBe(true);
    expect(root().getPropertyValue('--keyboard-layout-inset-bottom')).toBe('0px');
    expect(root().getPropertyValue('--keyboard-occlusion-bottom')).toBe('0px');
    expect(getKeyboardViewport().isOpen).toBe(false);
    expect(composerAnimate).toHaveBeenCalledWith(rideKeyframes(KB), TIMING);
    for (const animate of rowAnimates)
      expect(animate).toHaveBeenCalledWith(rideKeyframes(KB), TIMING);
  });

  it('a change with no animation is laid out and not ridden', () => {
    expect(hooks().canariImeTarget?.({ px: KB })).toBe(true);
    expect(inset()).toBe(KB);
    expect(composerAnimate).not.toHaveBeenCalled();
    expect(glide.takeOff).not.toHaveBeenCalled();
  });

  it('reduced motion: laid out, never ridden', () => {
    reduced = true;
    expect(hooks().canariImeTarget?.(RISE)).toBe(true);
    expect(inset()).toBe(KB);
    expect(composerAnimate).not.toHaveBeenCalled();
    for (const animate of rowAnimates) expect(animate).not.toHaveBeenCalled();
  });

  it('a Back mid-rise: the fall starts from where the composer is DRAWN, then the rise is cancelled (F3)', () => {
    hooks().canariImeTarget?.(RISE);
    expect(cancel).not.toHaveBeenCalled();
    // 100 ms into the rise the composer is drawn 150 px below its place (880 - KB).
    drawnOffset = 150;
    composerAnimate.mockClear();
    hooks().canariImeTarget?.(FALL);
    expect(cancel).toHaveBeenCalledTimes(3); // the composer and the two rows
    // From 880 - KB + 150 to 880: it rides the 208 px left, not the whole keyboard from the top.
    expect(composerAnimate).toHaveBeenCalledWith(rideKeyframes(KB - 150), TIMING);
  });

  it("the ride starts at the keyboard's phase: as far into its curve as the keyboard is (D1)", () => {
    deferred = [];
    clock = 1000;
    hooks().canariImeTarget?.(RISE);
    expect(composerAnimate).not.toHaveBeenCalled();
    clock = 1068; // the layout reactions run 68 ms after the announcement arrived
    for (const start of deferred) start();
    // Started at the arrival itself, on the keyboard's timeline - never a delay measured now (D1).
    expect(composerAnimate).toHaveBeenCalledWith(rideKeyframes(-KB), TIMING);
    expect(composerAnimate.mock.results[0].value.startTime).toBe(1000);
    for (const animate of rowAnimates) {
      expect(animate).toHaveBeenCalledWith(rideKeyframes(-KB), TIMING);
      expect(animate.mock.results[0].value.startTime).toBe(1000);
    }
  });

  it('a ride that could only start after the keyboard landed does not animate (D1)', () => {
    deferred = [];
    clock = 1000;
    hooks().canariImeTarget?.(RISE);
    clock = 1000 + RISE.durationMs;
    for (const start of deferred) start();
    expect(composerAnimate).not.toHaveBeenCalled();
    expect(inset()).toBe(KB);
  });

  it('reads everything it needs before it writes the first variable (D3)', () => {
    deferred = [];
    let width = 412;
    let height = BASELINE;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => (trace?.push('read'), height),
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      get: () => (trace?.push('read'), width),
    });
    const setProperty = root().setProperty.bind(root());
    vi.spyOn(root(), 'setProperty').mockImplementation((...args) => {
      trace?.push('write');
      setProperty(...args);
    });
    for (const announcement of [RISE, FALL]) {
      trace = [];
      hooks().canariImeTarget?.(announcement);
      const firstWrite = trace.indexOf('write');
      expect(firstWrite).toBeGreaterThan(0);
      expect(trace.slice(firstWrite)).not.toContain('read');
    }
    width = 0;
    height = 0;
  });

  it("the navigation bar strip is the keyboard's while it is up: the safe area is pinned in the same task (D2)", () => {
    root().removeProperty('--safe-area-inset-bottom');
    hooks().canariImeTarget?.(RISE);
    expect(root().getPropertyValue('--safe-area-inset-bottom')).toBe('0px');
    hooks().canariImeTarget?.(FALL);
    expect(root().getPropertyValue('--safe-area-inset-bottom')).toBe('');
    // A keyboard shorter than the open threshold covers the bar as well.
    hooks().canariImeTarget?.({ px: 90 });
    expect(getKeyboardViewport().isOpen).toBe(false);
    expect(root().getPropertyValue('--safe-area-inset-bottom')).toBe('0px');
  });

  it('follows a window resized for another reason: the shell is the window, not the baseline (F1)', () => {
    vi.stubGlobal('innerHeight', 450);
    hooks().canariImeTarget?.({ px: 300 });
    expect(getKeyboardViewport().isOpen).toBe(true);
    // The baseline was 945 and only grows: the shell pinned to it stood 945 tall in a 450 window.
    expect(root().getPropertyValue('--app-viewport-height')).toBe('450px');
    expect(root().getPropertyValue('--keyboard-occlusion-bottom')).toBe('300px');
    expect(root().getPropertyValue('--keyboard-free-viewport-height')).toBe('');
  });

  it('tells the inset listeners when the band moves, and only then (F4)', () => {
    const heard = vi.fn();
    const off = onKeyboardInsetChange(heard);
    hooks().canariImeTarget?.({ px: KB });
    expect(heard).toHaveBeenCalledTimes(1);
    hooks().canariImeTarget?.({ px: KB });
    expect(heard).toHaveBeenCalledTimes(1);
    hooks().canariImeTarget?.({ px: 0 });
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    hooks().canariImeTarget?.({ px: KB });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("the WebView's no-op resizes after an announcement reveal nothing; a keyboard that grows does (N3, second review)", () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    // A field outside the shell's layout (a modal's), which only the store reveals.
    const field = document.createElement('input');
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    document.body.append(field);
    field.focus();
    const behaviours = () =>
      scrollIntoView.mock.calls.map((c) => (c[0] as ScrollIntoViewOptions).behavior);
    hooks().canariImeTarget?.({ px: KB });
    expect(behaviours()).toEqual(['auto']);
    // ~15 ms later, Mi 9T: a window and a visual-viewport resize with no size changed.
    window.dispatchEvent(new Event('resize'));
    window.visualViewport?.dispatchEvent(new Event('resize'));
    expect(behaviours()).toEqual(['auto']);
    // The emoji keyboard, 40 px taller.
    hooks().canariImeTarget?.({ px: KB + 40 });
    expect(behaviours()).toEqual(['auto', 'smooth']);
  });

  it('a keyboard UNDER the open threshold still reveals the field it covers, rising from 0 (review of #3556)', () => {
    // A one-row IME, a floating or split keyboard, the ADB keyboard: under 160 px it never counts as
    // OPEN, yet the overlay lifts the shell by it and Chromium no longer reveals the field (the page
    // declares the keyboard an overlay). The reveal follows the inset, not the threshold.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const field = document.createElement('input');
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    document.body.append(field);
    field.focus();
    const behaviours = () =>
      scrollIntoView.mock.calls.map((c) => (c[0] as ScrollIntoViewOptions).behavior);
    const SMALL = 48;
    hooks().canariImeTarget?.({ px: SMALL });
    expect(getKeyboardViewport().isOpen).toBe(false);
    expect(behaviours()).toEqual(['auto']);
    // A second field focused with that keyboard still up is revealed too.
    const second = document.createElement('input');
    second.scrollIntoView = scrollIntoView;
    document.body.append(second);
    second.focus();
    expect(behaviours()).toEqual(['auto', 'smooth']);
    // Gone: nothing covers, nothing is revealed.
    hooks().canariImeTarget?.({ px: 0 });
    field.focus();
    expect(behaviours()).toEqual(['auto', 'smooth']);
  });

  it('a press during a ride cancels it', () => {
    hooks().canariImeTarget?.(RISE);
    window.dispatchEvent(new Event('pointerdown'));
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it('the announcement holds against what the WebView reports of its own viewport', () => {
    hooks().canariImeTarget?.({ px: KB });
    const vv = window.visualViewport as unknown as EventTarget & { height: number };
    vv.height = 588;
    vv.dispatchEvent(new Event('resize'));
    expect(inset()).toBe(KB);
    expect(root().getPropertyValue('--app-viewport-height')).toBe(`${BASELINE}px`);
  });

  it('a broken announcement is refused with a WARN and changes nothing', () => {
    const warn = vi.spyOn(Log, 'w');
    expect(hooks().canariImeTarget?.({ px: KB, durationMs: 285 })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(inset()).toBe(0);
  });

  it('a refused ANIMATED announcement asks the shell again, once; a refused height does not (second review)', () => {
    teardown();
    const pageReady = vi.fn();
    (window as unknown as { canariIme?: unknown }).canariIme = { pageReady };
    teardown = initKeyboardViewport({ now: () => clock });
    // A new document says it is ready.
    expect(pageReady).toHaveBeenCalledTimes(1);
    // Half an animation: the shell re-announces the inset without one, which the page takes.
    expect(hooks().canariImeTarget?.({ px: KB, durationMs: 285 })).toBe(false);
    expect(pageReady).toHaveBeenCalledTimes(2);
    expect(hooks().canariImeTarget?.({ px: KB })).toBe(true);
    // A refusal with no animation in it would only be refused again: it does not ask.
    expect(hooks().canariImeTarget?.({ px: -1 })).toBe(false);
    expect(pageReady).toHaveBeenCalledTimes(2);
  });

  it('the Android app declares the keyboard an overlay to the engine, and teardown takes it back (Mi 9T, 2026-11-15)', () => {
    // Without it Chromium panned the visual viewport by the whole keyboard to reveal the riding
    // composer's caret, still drawn under the keys: the composer stood a keyboard above them.
    teardown();
    const keyboard = { overlaysContent: false };
    Object.defineProperty(navigator, 'virtualKeyboard', { value: keyboard, configurable: true });
    (window as unknown as { canariIme?: unknown }).canariIme = { pageReady: vi.fn() };
    teardown = initKeyboardViewport({ now: () => clock });
    expect(keyboard.overlaysContent).toBe(true);
    teardown();
    expect(keyboard.overlaysContent).toBe(false);
    teardown = () => {};
  });

  it("the declaration is the Android app's alone: a browser or the iOS app keeps the engine's own keyboard", () => {
    const keyboard = { overlaysContent: false };
    expect(declareKeyboardOverlay({ navigator: { virtualKeyboard: keyboard } })).toBe(false);
    expect(keyboard.overlaysContent).toBe(false);
    expect(
      declareKeyboardOverlay({ canariIme: {}, navigator: { virtualKeyboard: keyboard } })
    ).toBe(true);
    expect(keyboard.overlaysContent).toBe(true);
  });

  it('a WebView with no VirtualKeyboard API is accused at WARN, never silently', () => {
    const warn = vi.spyOn(Log, 'w');
    const userAgent = 'Mozilla/5.0 (Linux; Android 9; wv) Chrome/88.0.4324.93 Mobile Safari/537.36';
    expect(declareKeyboardOverlay({ canariIme: {}, navigator: { userAgent } })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // The line carries the engine's version: an old WebView is named, not guessed at.
    expect(String(warn.mock.calls[0][1])).toContain('Chrome 88.0.4324.93');
  });

  it('teardown takes the occlusion variable away with the others', () => {
    hooks().canariImeTarget?.({ px: KB });
    teardown();
    expect(root().getPropertyValue('--keyboard-occlusion-bottom')).toBe('');
    teardown = () => {};
  });
});
