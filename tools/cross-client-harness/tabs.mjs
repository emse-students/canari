/**
 * Backgrounding a page, the ONLY way that works here.
 *
 * Three things do NOT work, each for its own reason:
 *   - covering the window: native occlusion detection is disabled on both browsers (without that,
 *     every synthetic click is discarded), so a covered window still reports `visible`;
 *   - `PUT /json/new` then `/json/activate`: that opens a separate WINDOW, so both pages stay
 *     `visible` and only `document.hasFocus()` flips - measured, not assumed;
 *   - `Page.setWebLifecycleState`: it freezes, it does not hide.
 *
 * What works is `window.open(..., '_blank')` from the page itself, which really is a sibling TAB
 * in the same window - the app page then reports `hidden`, which is what its own visibility
 * handlers listen to. It also closes cleanly, because a script may close what it opened.
 */
import { evaluate } from './cdp.mjs';

/**
 * Pushes the page to the background and returns the function that brings it back.
 *
 * Throws rather than reporting a false negative if the page did not actually go hidden - a check
 * that silently runs in the foreground would pass for the wrong reason.
 */
export async function background(cx, timeoutMs = 5000) {
  const opened = await evaluate(
    cx,
    `(function () { window.__bgTab = window.open('about:blank', '_blank'); return !!window.__bgTab; })()`
  );
  if (!opened) throw new Error('window.open was blocked - cannot background this page');

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await evaluate(cx, 'document.visibilityState')) === 'hidden') {
      return async function restore() {
        await evaluate(
          cx,
          '(function () { if (window.__bgTab) { window.__bgTab.close(); window.__bgTab = null; } return true; })()'
        );
        const t1 = Date.now();
        while (Date.now() - t1 < timeoutMs) {
          if ((await evaluate(cx, 'document.visibilityState')) === 'visible') return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('page did not come back to the foreground');
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('page stayed visible after opening a sibling tab');
}
