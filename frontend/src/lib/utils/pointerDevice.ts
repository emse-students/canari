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
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

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
  return sharedQuery().matches;
}

/** The one `MediaQueryList` for the coarse query, with the `matchMedia` that made it. */
let shared: { ask: typeof window.matchMedia; query: MediaQueryList } | null = null;

/**
 * THE ONE LIVE `MediaQueryList`, created on first use and read by everybody. Every message bubble
 * asks on mount (its `$state` initialiser runs before any subscriber exists), and a `matchMedia`
 * call per bubble was ~3 ms of the salon open on the Mi 9T (2026-11-02 profile) for an answer that is
 * the same for all of them. A live list's `matches` is always current. It is rebuilt if
 * `window.matchMedia` is a different function than the one that made it (a test swapping the stub),
 * which a browser never does.
 */
function sharedQuery(): MediaQueryList {
  const ask = window.matchMedia;
  if (!shared || shared.ask !== ask)
    shared = { ask, query: ask.call(window, COARSE_POINTER_QUERY) };
  return shared.query;
}

/** Everyone listening through {@link onCoarsePointerChange}; one entry per subscription. */
const coarseSubscribers = new Set<{ listener: (coarse: boolean) => void }>();

/** The ONE `change` listener all subscribers share, attached while there is at least one. */
let coarseWatch: { query: MediaQueryList; handler: (event: MediaQueryListEvent) => void } | null =
  null;

/**
 * Calls `listener` whenever the primary pointer changes kind - a tablet gaining a mouse, a desktop
 * browser toggling device emulation. Returns a teardown; a no-op one where nothing can be observed.
 *
 * ONE `MediaQueryList` LISTENER FOR EVERY SUBSCRIBER. Every message bubble subscribes, and the
 * thread's render window only grows (`renderWindow.ts`), so a listener per subscription put one on
 * the query per bubble ever mounted - for an answer that is the same for all of them. The first
 * subscriber attaches it, the last one to leave detaches it.
 */
export function onCoarsePointerChange(listener: (coarse: boolean) => void): () => void {
  if (!canQuery()) return () => {};
  const subscription = { listener };
  coarseSubscribers.add(subscription);
  if (!coarseWatch) {
    const query = sharedQuery();
    const handler = (event: MediaQueryListEvent) => {
      for (const { listener: notify } of coarseSubscribers) {
        // Isolated per subscriber: one throwing component must not leave the others on the old answer.
        try {
          notify(event.matches);
        } catch (err) {
          console.error('[POINTER] A coarse-pointer subscriber threw on a pointer change:', err);
        }
      }
    };
    query.addEventListener('change', handler);
    coarseWatch = { query, handler };
  }
  return () => {
    if (!coarseSubscribers.delete(subscription) || coarseSubscribers.size > 0 || !coarseWatch)
      return;
    coarseWatch.query.removeEventListener('change', coarseWatch.handler);
    coarseWatch = null;
  };
}

/** A mouse or trackpad that can hover: the desktop, never a phone or a tablet's finger. */
export const FINE_HOVER_QUERY = '(hover: hover) and (pointer: fine)';

/**
 * Whether the reader can HOVER with a fine pointer (the video volume slider opens on hover, which a
 * finger cannot do - owner, 2026-11-11). `false` where it cannot know (SSR, a bare test environment).
 */
export function isFineHoverDevice(): boolean {
  if (!canQuery()) return false;
  return window.matchMedia(FINE_HOVER_QUERY).matches;
}

/**
 * Calls `listener` now and whenever the answer of {@link isFineHoverDevice} changes (a tablet gaining
 * a mouse). Returns the teardown; a no-op one where nothing can be observed.
 */
export function watchFineHover(listener: (fineHover: boolean) => void): () => void {
  if (!canQuery()) return () => {};
  const query = window.matchMedia(FINE_HOVER_QUERY);
  const onChange = () => listener(query.matches);
  listener(query.matches);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}
