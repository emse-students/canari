// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKeyboardViewport, initKeyboardViewport } from './keyboardViewport.svelte';
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

const glide = vi.hoisted(() => ({ takeOff: vi.fn((_scroller: Element) => false) }));
vi.mock('$lib/utils/chat/threadGrowthObserver', () => ({ takeThreadGlideOff: glide.takeOff }));

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

  /** An element whose `animate` is recorded and whose top follows the layout through `top()`. */
  function piece(top: () => number) {
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => ({ top: top() }) as DOMRect);
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
    cancel = vi.fn();
    // The composer stands on the keyboard; the thread's rows are pinned to the bottom above it.
    const composer = piece(() => 880 - inset());
    composer.el.dataset.keyboardRide = 'box';
    composerAnimate = composer.animate;
    const thread = piece(() => 0);
    thread.el.dataset.keyboardRide = 'last-row';
    threadAnimate = thread.animate;
    const rows = [piece(() => 700 - inset()), piece(() => 800 - inset())];
    rowAnimates = rows.map((r) => r.animate);
    thread.el.append(...rows.map((r) => r.el));
    document.body.append(thread.el, composer.el);
    teardown = initKeyboardViewport({ afterLayout: (_targets, start) => (start(), () => {}) });
  });

  afterEach(() => {
    teardown();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    glide.takeOff.mockClear();
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

  it('a new announcement during a ride cancels it before capturing again', () => {
    hooks().canariImeTarget?.(RISE);
    expect(cancel).not.toHaveBeenCalled();
    hooks().canariImeTarget?.(FALL);
    expect(cancel).toHaveBeenCalledTimes(3); // the composer and the two rows
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

  it('teardown takes the occlusion variable away with the others', () => {
    hooks().canariImeTarget?.({ px: KB });
    teardown();
    expect(root().getPropertyValue('--keyboard-occlusion-bottom')).toBe('');
    teardown = () => {};
  });
});
