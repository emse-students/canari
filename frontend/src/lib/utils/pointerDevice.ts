/**
 * What kind of pointer the reader actually has.
 *
 * For features that are not merely CRAMPED on a phone but unusable with a finger - dragging and
 * resizing objects on a canvas, where the hand covers the thing being placed and there is no hover
 * to aim with. A width breakpoint is the wrong question there: a narrow desktop window still has a
 * mouse, and a large tablet still does not.
 *
 * `(pointer: coarse)` describes the PRIMARY pointing device, so a laptop with a touchscreen stays
 * `fine` and keeps the feature, while a phone, a tablet and a Tauri mobile WebView all report
 * `coarse`. That makes it one predicate instead of a runtime check plus a screen-size guess.
 */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** Whether `matchMedia` can be asked at all - it cannot under SSR, nor in a bare test environment. */
function canQuery(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/**
 * True when the primary pointer is a finger or a stylus.
 *
 * Answers `false` when it cannot know (SSR): a server render must not hide a control the machine
 * receiving it may well be able to use, and the mount that follows corrects it immediately.
 */
export function isCoarsePointerDevice(): boolean {
  if (!canQuery()) return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/**
 * Calls `listener` whenever the primary pointer changes kind - a tablet gaining a mouse, a desktop
 * browser toggling device emulation. Returns a teardown; a no-op one where nothing can be observed.
 */
export function onCoarsePointerChange(listener: (coarse: boolean) => void): () => void {
  if (!canQuery()) return () => {};
  const query = window.matchMedia(COARSE_POINTER_QUERY);
  const handler = (event: MediaQueryListEvent) => listener(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
