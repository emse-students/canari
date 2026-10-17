/**
 * Watches whether a line-clamped box hides text - measured, so a short text shows no "Voir plus".
 * Call it only WHILE the box is clamped: expanded, it shows everything and would report no
 * overflow, which would hide the "Voir moins" that folds it back. Returns the teardown.
 *
 * Shared by the post card (`PostContent`, 8 lines) and the reel caption (`ReelSlide`, 2 lines).
 */
export function watchClampOverflow(el: HTMLElement, onChange: (overflows: boolean) => void) {
  const measure = () => onChange(el.scrollHeight > el.clientHeight + 1);
  measure();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(measure);
  observer.observe(el);
  return () => observer.disconnect();
}
