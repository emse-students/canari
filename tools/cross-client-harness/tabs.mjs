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
 *
 * ONE PRECONDITION, and it is ours, not the browser's: `client()` turns FOCUS EMULATION on so three
 * clients can each be "the focused window" at once, and an emulated-focus page is pinned `visible`
 * whatever the tab strip does. The note here used to claim otherwise - measured again on 12 August
 * it is simply false, and MSG-8 died on `page stayed visible after opening a sibling tab` with the
 * app perfectly healthy. `background()` therefore turns it OFF for the duration and back on after,
 * which is invisible to every caller and fixes the whole TAB phase in one place.
 */
import { evaluate, listTargets } from './cdp.mjs';
import { SITE } from './names.mjs';

/**
 * Closes every app tab but the front one, and every blank, so the browser has ONE identity.
 *
 * A second tab of the app is not a variant of the device - it is another device wearing its name:
 * same profile, same login, same IndexedDB, its own gateway socket and its own in-memory counters.
 * `client()` resolves a client by the first URL that matches, which is a position among the tabs, so
 * an ambiguous browser hands every check an answer about a client nobody chose. See rule 5 of
 * `docs/wiki/testing-methodology.md` for the run this cost.
 *
 * `/json/list` is ordered most-recently-activated first, so index 0 is the tab in front - the one a
 * user would call theirs. Which tab holds the app's own leader Web Lock is not visible from here and
 * does not need to be: closing one releases it and another takes it.
 *
 * @returns the number of tabs closed.
 */
export async function closeExtraAppTabs(port) {
  const targets = await listTargets(port);
  const doomed = [
    ...targets.filter((t) => String(t.url).includes(SITE)).slice(1),
    ...targets.filter((t) => String(t.url).startsWith('about:blank')),
  ];
  for (const t of doomed) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
  return doomed.length;
}

/** Focus emulation pins a page `visible`; toggle it around anything that needs a real hide. */
async function setFocusEmulation(cx, enabled) {
  if (!cx.focusEmulated) return;
  await cx.send('Emulation.setFocusEmulationEnabled', { enabled }).catch(() => {});
}

/**
 * Pushes the page to the background and returns the function that brings it back.
 *
 * Throws rather than reporting a false negative if the page did not actually go hidden - a check
 * that silently runs in the foreground would pass for the wrong reason.
 */
export async function background(cx, timeoutMs = 5000) {
  await setFocusEmulation(cx, false);
  const opened = await evaluate(
    cx,
    `(function () { window.__bgTab = window.open('about:blank', '_blank'); return !!window.__bgTab; })()`
  );
  if (!opened) {
    await setFocusEmulation(cx, true);
    throw new Error('window.open was blocked - cannot background this page');
  }

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await evaluate(cx, 'document.visibilityState')) === 'hidden') {
      return async function restore() {
        await evaluate(
          cx,
          '(function () { if (window.__bgTab) { window.__bgTab.close(); window.__bgTab = null; } return true; })()'
        );
        // Closing the sibling does not necessarily re-select US - Chrome activates whichever tab it
        // likes, and the app can stay hidden behind another one. Ask for it explicitly.
        await cx.send('Page.bringToFront').catch(() => {});
        const t1 = Date.now();
        while (Date.now() - t1 < timeoutMs) {
          if ((await evaluate(cx, 'document.visibilityState')) === 'visible') {
            await setFocusEmulation(cx, true);
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        await setFocusEmulation(cx, true);
        throw new Error('page did not come back to the foreground');
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Leave no emulation off behind a failure: the next check would inherit an unfocused client.
  await evaluate(
    cx,
    '(function () { if (window.__bgTab) { window.__bgTab.close(); window.__bgTab = null; } return true; })()'
  ).catch(() => {});
  await setFocusEmulation(cx, true);
  throw new Error('page stayed visible after opening a sibling tab');
}
