// @vitest-environment happy-dom
/**
 * The reactive viewport questions: each answers what `$lib/utils/viewport` decides, and a reader
 * re-runs when the answer changes. `overlayLayout` is what keeps the feed's conversations panel - drawn
 * only at `xl` - from being MOUNTED on a phone (2026-10-15, community-open-budget).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, tick } from 'svelte';
import { overlayLayout, phoneViewport } from './phoneViewport.svelte';
import { OVERLAY_LAYOUT_QUERY, PHONE_VIEWPORT_QUERY } from '$lib/utils/viewport';

/** One media query list per query, whose answer the test moves and announces. */
class FakeQueryList {
  listeners = new Set<(e: { matches: boolean }) => void>();
  constructor(public matches: boolean) {}
  addEventListener(_type: 'change', fn: (e: { matches: boolean }) => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_type: 'change', fn: (e: { matches: boolean }) => void) {
    this.listeners.delete(fn);
  }
  set(matches: boolean) {
    this.matches = matches;
    for (const fn of this.listeners) fn({ matches });
  }
}

let lists: Map<string, FakeQueryList>;
const original = window.matchMedia;

beforeEach(() => {
  lists = new Map([
    [PHONE_VIEWPORT_QUERY, new FakeQueryList(true)],
    [OVERLAY_LAYOUT_QUERY, new FakeQueryList(true)],
  ]);
  window.matchMedia = ((query: string) =>
    lists.get(query) ?? new FakeQueryList(false)) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = original;
});

describe('reactive viewport questions', () => {
  it('answer what the media query answers', () => {
    expect(phoneViewport()).toBe(true);
    expect(overlayLayout()).toBe(true);
    lists.get(OVERLAY_LAYOUT_QUERY)!.matches = false;
    expect(overlayLayout()).toBe(false);
  });

  it('re-run a reader when the window crosses the breakpoint, and stop listening after it', async () => {
    const seen: boolean[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(overlayLayout());
      });
    });
    flushSync();
    lists.get(OVERLAY_LAYOUT_QUERY)!.set(false);
    flushSync();
    expect(seen).toEqual([true, false]);
    expect(lists.get(OVERLAY_LAYOUT_QUERY)!.listeners.size).toBe(1);
    stop();
    await tick();
    expect(lists.get(OVERLAY_LAYOUT_QUERY)!.listeners.size).toBe(0);
  });
});
