import { untrack } from 'svelte';

/**
 * HOW MANY ITEMS OF A LONG LIST ARE MOUNTED RIGHT NOW: the first few at once, the rest a couple per
 * animation frame (CALL IT DURING COMPONENT INIT - it creates an effect).
 *
 * WHY (Mi 9T, 2026-10-02, measured): swiping back to the feed ran ONE 300-500 ms main-thread task
 * inside the view transition's update callback - Svelte mounting all twenty `PostCard`s (about 11 ms
 * each, 123 icons) - and the slide cannot begin until that callback returns, so the page the member
 * had just released sat frozen for that long. A card below the first screen is not needed to draw
 * the first screen, so only `initial` of them are mounted for the first paint and the remainder
 * follow `batch` per frame, each slice well under a frame budget of two.
 *
 * THE FRAME DRIVES THE SCHEDULE, NEVER THE RESULT: whatever the frame rate, the list ends up complete
 * and identical; `complete` is what a caller gates anything that assumes the whole list is mounted on
 * (the infinite-scroll sentinel would otherwise sit under the third card and fetch page two at once).
 * A change of `resetKey` (another feed replaces the whole list) starts over; a refresh that keeps the
 * key never unmounts what is on screen.
 */
export function progressiveCount(opts: {
  /** How many items exist now. */
  total: () => number;
  /** Changes when the whole list is replaced by another one. */
  resetKey: () => unknown;
  /** Mounted for the first paint. */
  initial: number;
  /** Added per animation frame afterwards. */
  batch: number;
}) {
  // THE COUNT BELONGS TO THE LIST IT WAS COUNTED FOR, SO A NEW LIST RESETS IT BY DERIVATION, NEVER
  // BY A WRITE FROM THE EFFECT. The effect used to write `count = initial` on a key change; a write
  // from an `$effect` re-runs the `{#each}` reading the count EAGERLY, and since Svelte 5.59 that run
  // registers a commit which re-reads the each's collection when its batch commits - after the page's
  // own tab-load effect had emptied the list and before the `{#if}` around the each was torn down.
  // The feed's first tab switch of each process crashed on `null.slice` (iPhone 12, 1.8.0-alpha.7 to
  // alpha.9; docs/wiki/frontend/architecture.md). Only the frame callback writes, outside any effect.
  // `key` notifies only when the key's VALUE changes, so a reload of the same list keeps its count.
  const key = $derived(opts.resetKey());
  // A writable derived: a new key derives the first screen again, a frame assigns the next count.
  let count = $derived.by(() => {
    void key;
    return opts.initial;
  });
  /** The key last announced in the log: a plain local, nothing is drawn from it. */
  let announced = untrack(() => key);

  $effect(() => {
    const total = opts.total();
    const mounted = count;
    if (key !== announced) {
      announced = key;
      console.debug(`[progressive-mount] list replaced - back to ${opts.initial} of ${total}`);
    }
    if (mounted >= total) return;
    const frame = requestAnimationFrame(() => {
      const next = Math.min(total, mounted + opts.batch);
      if (next >= total) console.debug(`[progressive-mount] all ${total} mounted`);
      count = next;
    });
    return () => cancelAnimationFrame(frame);
  });

  return {
    /** The number of leading items to render. */
    get count() {
      return count;
    },
    /** Every item that exists is mounted. */
    get complete() {
      return count >= opts.total();
    },
  };
}
