/**
 * The fact `routes/posts/+page.svelte` depends on to replace the cached paint with the answer.
 *
 * A `$state` wraps an array it is given in a proxy. So the list painted from the cache is NOT the
 * cached array, and comparing the two said "something else replaced the paint" every time anything
 * was cached. The answer was then dropped, so the feed was always one visit behind. A reel just
 * published never appeared on the feed it landed on (REEL-2, Mi 9T, 2026-10-02). The page now
 * compares against the proxy READ BACK after the paint, which keeps its identity until the list is
 * reassigned. If Svelte ever stops proxying, the first assertion fails, and the page's comment
 * must be re-read rather than this test silenced.
 */
import { describe, expect, it } from 'vitest';
import { untrack } from 'svelte';

describe('the feed paint identity', () => {
  it('a $state holds a proxy of the array it is given, and its read-back keeps its identity', () => {
    const cached = [{ id: 'a' }];
    let list = $state<{ id: string }[] | null>(null);
    list = cached;
    expect(list === cached).toBe(false);

    const painted = untrack(() => list);
    expect(list === painted).toBe(true);

    list = [...cached, { id: 'b' }];
    expect(list === painted).toBe(false);
  });
});
