/**
 * Watches whether a line-clamped box hides text - measured, so a short text shows no "Voir plus".
 * Call it only WHILE the box is clamped: expanded, it shows everything and would report no
 * overflow, which would hide the "Voir moins" that folds it back. Returns the teardown.
 *
 * Shared by the post card (`PostContent`, 8 lines) and the reel caption (`ReelSlide`, 2 lines).
 *
 * THE OBSERVER'S FIRST CALLBACK IS THE FIRST READ - there is no read inside the mount. Reading
 * `scrollHeight` right after a card's nodes are inserted forces a full style + layout of the page,
 * and a feed mounts its cards one after another: one forced layout per card, interleaved with the
 * writes of the next (43 ms of self time in the tab tap on a Mi 9T, 2026-11-02 profile). A
 * ResizeObserver reports every newly observed box in the rendering step that lays it out, after
 * the requestAnimationFrame callbacks and BEFORE paint, so (a) layout is already clean when
 * `measure` reads, which forces nothing, and (b) a card mounted at any point of the frame, even
 * from inside a rAF callback, is answered before it is painted, so "Voir plus" never appears a
 * frame late and shifts the page. No timer, no batch. The same observer keeps the answer current.
 *
 * No per-call log: this runs once per card on the feed's hot path and its outcome is a boolean
 * the caller renders; a line per card is the noise this function exists to avoid.
 */
export function watchClampOverflow(el: HTMLElement, onChange: (overflows: boolean) => void) {
  // Server rendering (and any host without the API) has no layout to measure: nothing to watch.
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(() => onChange(el.scrollHeight > el.clientHeight + 1));
  observer.observe(el);
  return () => observer.disconnect();
}
