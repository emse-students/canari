/**
 * Watches whether a line-clamped box hides text - measured, so a short text shows no "Voir plus".
 * Call it only WHILE the box is clamped: expanded, it shows everything and would report no
 * overflow, which would hide the "Voir moins" that folds it back. Returns the teardown.
 *
 * Shared by the post card (`PostContent`, 8 lines) and the reel caption (`ReelSlide`, 2 lines).
 *
 * THE FIRST READ IS BATCHED ONTO THE NEXT FRAME, NEVER TAKEN INSIDE THE MOUNT. Reading
 * `scrollHeight` right after a card's nodes are inserted forces a full style + layout of the page,
 * and a feed mounts its cards one after another: one forced layout per card, interleaved with the
 * writes of the next (43 ms of self time in the tab tap on a Mi 9T, 2026-11-02 profile). Every box
 * that asks in the same frame is read together in one pass - the first read pays the layout, the
 * others find it clean - which is what a layout-thrash cure is. The observer then keeps the answer
 * current, as before.
 */
const pendingReads = new Set<() => void>();
let readFrame: number | null = null;

/** Queues `read` for the next frame, together with every other pending first read. Returns its cancel. */
function scheduleFirstRead(read: () => void): () => void {
  if (typeof requestAnimationFrame === 'undefined') {
    read();
    return () => {};
  }
  pendingReads.add(read);
  readFrame ??= requestAnimationFrame(() => {
    readFrame = null;
    const batch = [...pendingReads];
    pendingReads.clear();
    for (const run of batch) run();
  });
  return () => pendingReads.delete(read);
}

export function watchClampOverflow(el: HTMLElement, onChange: (overflows: boolean) => void) {
  const measure = () => onChange(el.scrollHeight > el.clientHeight + 1);
  const cancelFirstRead = scheduleFirstRead(measure);
  if (typeof ResizeObserver === 'undefined') return cancelFirstRead;
  const observer = new ResizeObserver(measure);
  observer.observe(el);
  return () => {
    cancelFirstRead();
    observer.disconnect();
  };
}
