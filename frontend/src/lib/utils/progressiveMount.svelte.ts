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
  let count = $state(opts.initial);
  let lastKey = untrack(opts.resetKey);

  $effect(() => {
    const key = opts.resetKey();
    const total = opts.total();
    if (key !== lastKey) {
      lastKey = key;
      console.debug(`[progressive-mount] list replaced - back to ${opts.initial} of ${total}`);
      untrack(() => (count = opts.initial));
    }
    const mounted = count;
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
