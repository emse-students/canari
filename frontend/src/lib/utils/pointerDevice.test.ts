// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { isCoarsePointerDevice, onCoarsePointerChange } from './pointerDevice';

/**
 * The predicate that decides whether a drag-and-drop canvas is offered at all, so the two answers
 * it must never get wrong are: "coarse" on a phone, and "fine" on a laptop that merely has a
 * touchscreen. Both come from asking about the PRIMARY pointer rather than about a screen width.
 */
describe('pointerDevice', () => {
  const original = window.matchMedia;

  afterEach(() => {
    window.matchMedia = original;
  });

  /** Minimal `MediaQueryList` double: records the query asked and the listeners attached. */
  function stubMatchMedia(matches: boolean) {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const asked: string[] = [];
    window.matchMedia = ((query: string) => {
      asked.push(query);
      return {
        matches,
        media: query,
        addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) =>
          listeners.delete(fn),
      };
    }) as unknown as typeof window.matchMedia;
    return { listeners, asked };
  }

  it('reports a coarse pointer where the platform says so', () => {
    stubMatchMedia(true);
    expect(isCoarsePointerDevice()).toBe(true);
  });

  it('reports a fine pointer otherwise - a touchscreen laptop keeps the feature', () => {
    stubMatchMedia(false);
    expect(isCoarsePointerDevice()).toBe(false);
  });

  it('asks about the primary pointer, never about a screen width', () => {
    const { asked } = stubMatchMedia(true);
    isCoarsePointerDevice();
    expect(asked).toEqual(['(pointer: coarse)']);
  });

  it('answers false when it cannot ask, so SSR never hides a usable control', () => {
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    expect(isCoarsePointerDevice()).toBe(false);
  });

  it('notifies on change and detaches on teardown', () => {
    const { listeners } = stubMatchMedia(false);
    const seen: boolean[] = [];
    const stop = onCoarsePointerChange((coarse) => seen.push(coarse));
    expect(listeners.size).toBe(1);

    for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent);
    expect(seen).toEqual([true]);

    stop();
    expect(listeners.size).toBe(0);
  });

  it('puts ONE listener on the query however many subscribe - one per bubble is what it replaced', () => {
    const { listeners } = stubMatchMedia(false);
    const seen: boolean[][] = [[], [], []];
    const stops = seen.map((log) => onCoarsePointerChange((coarse) => log.push(coarse)));
    expect(listeners.size).toBe(1);

    for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent);
    expect(seen).toEqual([[true], [true], [true]]);

    stops[0]();
    stops[0](); // a second teardown of the same subscription takes nothing else down
    expect(listeners.size).toBe(1);
    stops[1]();
    stops[2]();
    expect(listeners.size).toBe(0);
  });

  it('still notifies every subscriber when one of them throws', () => {
    const { listeners } = stubMatchMedia(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: boolean[] = [];
    const stopBad = onCoarsePointerChange(() => {
      throw new Error('boom');
    });
    const stopGood = onCoarsePointerChange((coarse) => seen.push(coarse));

    for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent);

    expect(seen).toEqual([true]);
    expect(error).toHaveBeenCalledTimes(1);
    stopBad();
    stopGood();
    error.mockRestore();
  });

  it('returns a teardown that is safe to call when nothing could be observed', () => {
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    const stop = onCoarsePointerChange(vi.fn());
    expect(() => stop()).not.toThrow();
  });
});
