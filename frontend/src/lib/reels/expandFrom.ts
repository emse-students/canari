/**
 * THE REEL VIEWER GROWS OUT OF THE BUTTON THAT OPENED IT (owner, 2026-10-31), instead of appearing.
 *
 * Two ways to draw it, chosen once per opening, and neither is a correctness path - the viewer is
 * mounted by `commit` in every case, so a missing API or a refused transition only changes the look:
 *
 * - the View Transitions API where `document.startViewTransition` exists: the button and the viewer
 *   share the transition name `reel-open` (the viewer's is in `app.css`), the browser morphs one
 *   into the other. The page stays hit-testable (`::view-transition { pointer-events: none }`),
 *   the viewer is live in the new snapshot, and its first frame is not waited for: only the mount
 *   (one `tick`) is.
 * - otherwise, `commit` receives the button's centre and the viewer plays a transform-only
 *   scale-from-origin entrance (`motion-expand-in`). Android WebView before 111 and WKWebView before
 *   18 land here. It is the PRESENTATION fallback, so it is logged at debug, never as a signal.
 *
 * A reader who asked for reduced motion gets neither: `commit(null)` at once.
 */
import { tick } from 'svelte';

/** Where the viewer grows from when the View Transitions API is absent: the button's centre. */
export interface ExpandOrigin {
  x: number;
  y: number;
}

/** The transition name the button and the viewer share. */
export const REEL_OPEN_TRANSITION_NAME = 'reel-open';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => { finished: Promise<void> };
};

/**
 * Runs `commit` (which mounts the viewer) as an expansion from `source`. `commit` gets an origin
 * only when the CSS fallback must draw the entrance.
 */
export function expandFrom(source: HTMLElement, commit: (origin: ExpandOrigin | null) => void) {
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    console.debug('[reels-expand] reduced motion - the viewer opens without an entrance');
    commit(null);
    return;
  }
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition === 'function') {
    console.debug('[reels-expand] view transition');
    source.style.viewTransitionName = REEL_OPEN_TRANSITION_NAME;
    try {
      const transition = doc.startViewTransition(async () => {
        // Two elements may not carry one name at once: the button gives it up as the viewer mounts.
        source.style.viewTransitionName = '';
        commit(null);
        await tick();
      });
      transition.finished.catch((err: unknown) => {
        // A skipped transition (a hidden tab, a newer one) still ran `commit`: nothing to repair.
        console.debug('[reels-expand] view transition skipped', err);
      });
    } catch (err) {
      source.style.viewTransitionName = '';
      console.debug('[reels-expand] view transition refused, entrance by CSS', err);
      commitFromCss(source, commit);
    }
    return;
  }
  console.debug('[reels-expand] no View Transitions API - entrance by CSS');
  commitFromCss(source, commit);
}

function commitFromCss(source: HTMLElement, commit: (origin: ExpandOrigin | null) => void) {
  const box = source.getBoundingClientRect();
  commit({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
}
