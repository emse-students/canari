import { Log } from './Log';
import { isOverlayLayout } from './viewport';
/**
 * History-based overlay stack - Android Back button support.
 *
 * How it works on Android (Tauri / WebView):
 *  1. When a modal/drawer opens, `pushHistoryOverlay(close)` gives it a history entry (same URL, no
 *     SvelteKit route change).
 *  2. When the user presses the physical Back button, Android delegates the event to the WebView.
 *     Since there is a history entry, the WebView fires a `popstate` event instead of exiting the app.
 *  3. `onPopState` closes the overlay the person sees (`settleArrival`) - Back behaves like the X.
 *  4. If nothing is open, `popstate` propagates normally:
 *     - SvelteKit navigates back (if there is router history), OR
 *     - Android exits the app (correct behaviour at the root screen).
 *
 * ⚠️  Every modal/drawer that should be closable via Back MUST call
 *     `pushHistoryOverlay` on open (use `bindHistoryOverlay.svelte.ts`).
 *     Modals that skip this step will not be intercepted by the Back button.
 *
 * No native Kotlin or Tauri plugin is required - `TauriActivity` already
 * delegates Back presses to the WebView by default.
 *
 * THIS MODULE NEVER TRAVERSES THE HISTORY TO CLOSE AN OVERLAY (2026-10-15, the Mi 9T reading of
 * v1.2.9-alpha.1 and two reviews of #1925). `history.back()` lands LATER and `pushState` does not,
 * so every close that walked the history (an abandon, a UI close) raced the next overlay's push: the
 * "+" menu abandoned its entry and the in-app camera pushed its own in the same task, the traversal
 * went back off the CAMERA's entry, and one Back on a taken photo closed the photo AND the camera.
 * Waiting for the traversal was tried and could be left waiting for good (a back that cannot land,
 * two backs predicted from one pointer, a shallow navigation re-labelling the landing). So:
 *
 *  - A close by the app (the X, an abandon, an owner's state) closes NOW and leaves its entry as a
 *    GHOST under the pointer - an entry of ours that no live overlay owns.
 *  - The next overlay opened REUSES a ghost under the pointer (`replaceState`, same depth): a
 *    hand-off from one overlay to the next costs no traversal, which is what the camera needed.
 *  - A member's Back closes exactly the top overlay: the ones above the entry it landed on, or, when
 *    it landed on a ghost or on the live entry under one, the top one.
 *
 *  The one traversal left is a WALK after a Back that closed nothing because it was spent on a ghost
 *  with nothing open - it does what the Back does on the page. Nothing waits for it.
 *
 *  `drainHistoryOverlayStack` (in `beforeNavigate`) leaves ghosts too: `history.go(-n)` after
 *  SvelteKit pushed the new route would move the pointer back off it - "the first back gesture
 *  lands on the previous page".
 *
 * WHERE NOTHING EVER POPS AN ENTRY, NONE IS WRITTEN (`systemBack: false`, the iOS app, 2026-10-16).
 * Its WKWebView has no back-forward swipe, so its only Back is the app's own edge swipe
 * (`backHistoryOverlayFromGesture`), which needs the stack and never the history. Entries there were
 * pure cost and grew without bound: closing N nested overlays by swipe leaves N ghosts and only the
 * one under the pointer is ever taken again, so each such cycle added N-1 entries for good (review
 * of #1936). The stack is kept; the history is left to the router.
 */
const STATE_KEY = 'canariOverlay';
/** Which page load pushed an entry: an id is only comparable with ids of the same load. */
const LOAD_KEY = 'canariLoad';
const isBrowser = typeof window !== 'undefined';
/**
 * This page load's mark. History entries outlive a reload while this module's counter does not, so
 * an entry from an earlier load could otherwise carry the same id as a live one.
 */
const LOAD_ID = Math.random().toString(36).slice(2);

/**
 * Why a close handler runs. `back` is the member's gesture (Back, X, backdrop): an overlay holding
 * something precious may ask about it. `navigation` is the app leaving the screen (`beforeNavigate`
 * drains the stack): the member is already elsewhere, so a handler must tidy up and NEVER ask - a
 * question there lands over the destination page.
 */
export type OverlayCloseReason = 'back' | 'navigation';

/** A close handler; the reason is optional so the many that ignore it stay `() => void`. */
export type OverlayClose = (reason?: OverlayCloseReason) => void;

type StackEntry = {
  close: OverlayClose;
  /** The id written into this overlay's history entry; ids grow with every push of a load. */
  id: number;
};

const stack: StackEntry[] = [];
/** The id of the last entry pushed by this load. */
let lastId = 0;
/**
 * The entry the history pointer is on, as far as this module last saw it: the id of an entry this
 * load wrote, or 0 for any other entry. With `hereHref`, it tells a landing whether the Back that
 * caused it LEFT a ghost (see `settleArrival`).
 */
let here = 0;
/** The page address when `here` was last set: a ghost and its router entry share it. */
let hereHref = '';
/** A walk issued by `settleArrival` has not landed yet: its landing is not a Back. */
let walking = false;
/** False where no system Back exists to pop an entry (see the module comment): none is written. */
let writesEntries = true;

/** The page address now; empty where there is none (a test without a `location`). */
function currentHref(): string {
  return globalThis.location?.href ?? '';
}
let initialized = false;

/**
 * Viewports where chat/drawers use full-screen overlays.
 *
 * The query itself lives in `viewport.ts` - four hand-written breakpoints had drifted apart, two of
 * them by a pixel. This one asks about WIDTH ALONE and deliberately not about the pointer: a narrow
 * mouse-driven window needs the full-screen drawers just as much as a phone does.
 */
export function isMobileOverlayLayout(): boolean {
  if (!isBrowser) return false;
  return isOverlayLayout();
}

/**
 * Registers a global `popstate` listener. Call once from the root layout.
 * Returns a teardown function.
 *
 * `systemBack: false` is for a runtime with NO system Back (the iOS app): overlays are stacked for
 * the app's own gesture Back, and no history entry is written for them.
 */
export function initHistoryOverlayStack(options: { systemBack?: boolean } = {}): () => void {
  if (!isBrowser || initialized) return () => {};
  initialized = true;
  writesEntries = options.systemBack ?? true;
  Log.d(
    'historyOverlay',
    `stack ready - ${writesEntries ? 'entries written' : 'no system Back, no entries'}`
  );

  const onPopState = (event: PopStateEvent) => {
    const from = here;
    const fromHref = hereHref;
    here = readArrival(event.state).id;
    hereHref = currentHref();
    const byWalk = walking;
    walking = false;
    // A Back pressed ON a ghost of this load, landing on the same page: the press went into the
    // ghost and must still do what a Back does on the page.
    const leftGhost =
      !byWalk && from > 0 && fromHref === currentHref() && !stack.some((e) => e.id === from);
    settleArrival(event.state, leftGhost);
  };

  window.addEventListener('popstate', onPopState);
  return () => {
    window.removeEventListener('popstate', onPopState);
    initialized = false;
    stack.length = 0;
    here = 0;
    hereHref = '';
    walking = false;
    writesEntries = true;
  };
}

/**
 * Gives `close` a history entry; Android/iOS back will invoke it.
 *
 * A GHOST UNDER THE POINTER IS REUSED (`replaceState`): an overlay that hands over to another (a
 * menu entry that opens the camera, a sheet that opens a picker) closed first and left its entry as
 * a ghost, and the next overlay takes that entry at the same depth - no traversal, nothing to race.
 * The entry under the pointer is read from `history.state`, never assumed: a shallow navigation by
 * the router may have moved the pointer, and its entry is not ours to take.
 */
export function pushHistoryOverlay(close: OverlayClose): void {
  if (!isBrowser) return;
  const id = ++lastId;
  if (!writesEntries) {
    stack.push({ close, id });
    return;
  }
  const state = { [STATE_KEY]: id, [LOAD_KEY]: LOAD_ID };
  if (readArrival(history.state).ghost) {
    Log.d('historyOverlay', `overlay ${id} takes the ghost entry under the pointer (a hand-off)`);
    history.replaceState(state, '');
  } else {
    history.pushState(state, '');
  }
  stack.push({ close, id });
  here = id;
  hereHref = currentHref();
}

/**
 * Where a traversal landed, read off the entry's state: the id of an entry this load pushed, or 0
 * for anything else (the router's own entry, or one an earlier load pushed - every live overlay sits
 * ABOVE those, since a push truncates whatever was forward of it). `ghost` is an entry of ours whose
 * overlay is no longer on the stack.
 */
function readArrival(state: unknown): { id: number; ghost: boolean } {
  if (state === null || typeof state !== 'object' || !(STATE_KEY in state)) {
    return { id: 0, ghost: false };
  }
  const record = state as Record<string, unknown>;
  const id = record[STATE_KEY];
  if (record[LOAD_KEY] !== LOAD_ID || typeof id !== 'number') return { id: 0, ghost: true };
  return { id, ghost: !stack.some((e) => e.id === id) };
}

/**
 * Brings the stack in line with the history entry a member's Back landed on: ONE Back closes the
 * overlay the person sees.
 *
 * The overlays pushed after the landed entry are closed (ids grow with position, so they are the
 * ones above it). When none is, the Back went INTO an entry no live overlay owns any more - a ghost
 * left by an overlay the app closed, or the live entry under one - and the press still closes the
 * top overlay: its entry, now at or below the pointer, becomes a ghost the next overlay reuses.
 *
 * With NOTHING open, a Back that landed on a ghost walks one more entry (`history.back()`), and so
 * does one pressed while the pointer sat ON a ghost (`leftGhost`: a picker closed on its choice, a
 * confirmation answered) that landed on the page's own router entry - so the Back does what it does
 * on the page: the previous page, or nothing at the history's first entry (where Android's next Back
 * leaves the app). Nothing waits for that walk: no overlay is open to be closed by it, and a push
 * made before it lands is an overlay closed by the member's Back, which it is.
 */
function settleArrival(state: unknown, leftGhost: boolean): void {
  const arrival = readArrival(state);
  const above: StackEntry[] = [];
  while (stack.length > 0 && stack[stack.length - 1].id > arrival.id) above.push(stack.pop()!);
  if (above.length === 0 && stack.length > 0) {
    Log.d('historyOverlay', 'Back landed on an entry no overlay above owns - closing the top one');
    above.push(stack.pop()!);
  }
  for (const entry of above) entry.close('back');
  if (above.length > 0) {
    Log.d('historyOverlay', `Back closed ${above.length} overlay(s), ${stack.length} left open`);
    return;
  }
  if (arrival.ghost || leftGhost) {
    const where = arrival.ghost ? 'a ghost entry' : 'the router entry from a ghost above it';
    Log.d('historyOverlay', `Back landed on ${where} with nothing open - walking one more`);
    walking = true;
    history.back();
  }
}

/**
 * Close from UI (X, backdrop): the overlay closes NOW, and its entry stays as a ghost for the next
 * overlay to reuse or the next Back to cross (see the module comment: no traversal).
 */
export function closeHistoryOverlayFromUi(close: () => void): void {
  if (!isBrowser) {
    close();
    return;
  }
  releaseHistoryOverlay(close);
  close();
}

/**
 * A Back the APP'S OWN gesture carries - the left-edge swipe, which is the only Back the iOS app has
 * (its WKWebView does not enable the back-forward swipe, so no `popstate` ever comes from the edge).
 * It closes exactly the TOP overlay, as a system Back does, and tells it so (`'back'`, which is what
 * makes a held take ASK). Its entry stays as a ghost, like every close here (no traversal).
 *
 * Returns false when no overlay is open: the gesture then belongs to whatever drew it. Without this,
 * the conversation's swipe closed the conversation from under its own "+" menu, and a swipe over a
 * portalled layer (the camera's review) reached nothing at all (iPhone 12, v1.2.9-alpha.2, 2 of 2).
 *
 * `arm` is {@link armHistoryOverlayGesture}'s record from the touch's start: when the overlay on top
 * then is no longer on top, the gesture is SPENT and closes nothing more (returns true, so the
 * owner does not act either). Without it, a menu closed by anything during the stroke left the
 * conversation on top for the commit to close.
 */
export function backHistoryOverlayFromGesture(arm: HistoryGestureArm | null): boolean {
  if (!arm) {
    // A commit no touch armed - a second commit of a gesture already spent (two pending slide-out
    // ends): unarmed, it would close the next overlay down, which is "the menu AND the conversation".
    Log.i('historyOverlay', 'gesture Back with no armed touch - spent, nothing closed');
    return true;
  }
  const topId = stack.length > 0 ? stack[stack.length - 1].id : 0;
  if (arm.topId !== topId) {
    // ONE GESTURE, ONE CLOSE. The overlay on top when the finger came down is gone (something
    // else closed it during the stroke: a tap-outside, a keyboard, its own owner): the gesture has
    // been spent on it, and it must not go on to close what lay UNDER it - the conversation under
    // the "+" menu (iPhone 12, v1.2.9-alpha.2 and alpha.3, 3 of 3). Info, not debug: the in-app
    // log records no debug, and the alpha.3 reading could not be diagnosed without this line.
    Log.i(
      'historyOverlay',
      `gesture Back spent: overlay ${arm.topId} was on top at the touch, ${topId || 'nothing'} is now - nothing more closed`
    );
    return true;
  }
  const top = stack.pop();
  if (!top) {
    Log.d('historyOverlay', 'gesture Back with no overlay open - the gesture owner decides');
    return false;
  }
  Log.i('historyOverlay', `gesture Back closes overlay ${top.id}, ${stack.length} left open`);
  top.close('back');
  return true;
}

/** What the overlay stack looked like when a gesture Back's finger came down. */
export interface HistoryGestureArm {
  /** The id of the overlay on top then, or 0 when none was open. */
  readonly topId: number;
}

/**
 * Records the stack's top as a Back gesture arms (its touch STARTS), for
 * {@link backHistoryOverlayFromGesture} to check at the commit: a gesture closes at most the
 * overlay that was on top when it began - never two things, whatever closed the first meanwhile.
 */
export function armHistoryOverlayGesture(): HistoryGestureArm {
  return { topId: stack.length > 0 ? stack[stack.length - 1].id : 0 };
}

/**
 * Removes an overlay from the stack when it is dismissed indirectly (opening a conversation closes
 * the list drawer, a take handed back closes the camera). Its entry stays as a ghost - see
 * {@link releaseHistoryOverlay}, which this now is: a traversal to remove it raced the next push.
 */
export function abandonHistoryOverlay(close: () => void): void {
  releaseHistoryOverlay(close);
}

/**
 * Takes an overlay off the JS stack when its OWNER closed it by state (a publish that sets
 * `open = false`), without touching the browser history.
 *
 * AN OVERLAY CLOSED THAT WAY USED TO STAY ON THE STACK FOR EVER, and `historyOverlayStackDepth() > 0`
 * is what stands the tab swipe down: on a fresh Feed after publishing a post, the swipe to the
 * camera did nothing three times, and worked after one round trip through another tab - the
 * `beforeNavigate` drain that finally emptied the stack (Mi 9T, 2026-10-06).
 *
 * The entry becomes a ghost, which the next push reuses and a Back crosses. A no-op when the overlay
 * is already gone, which is the case on every dismissal that went through the stack itself.
 */
export function releaseHistoryOverlay(close: () => void): void {
  if (!isBrowser) return;
  const idx = stack.findIndex((e) => e.close === close);
  if (idx >= 0) stack.splice(idx, 1);
}

/**
 * Close every overlay and call their close handlers.
 *
 * Called by `beforeNavigate` in the root layout before every SvelteKit
 * navigation.  The corresponding history entries are NOT removed here - they become ghost entries.
 *
 * ⚠️  Do NOT call `history.go(-count)` here.  That call is asynchronous and
 * fires AFTER SvelteKit has already pushed the new route, which moves the
 * history pointer backwards and causes SvelteKit to navigate back - the bug
 * known as "the first back gesture lands on the previous page".
 */
export function drainHistoryOverlayStack(): void {
  while (stack.length > 0) {
    stack.pop()?.close('navigation');
  }
  // The router is about to push or REPLACE the entry the pointer is on: it is no longer a ghost of
  // ours, and a Back from the next page must not be read as one pressed on it.
  here = 0;
  hereHref = '';
}

/**
 * Removes the fragment from the address of the entry under the pointer, keeping that entry's state
 * (the router's and this module's). Used for a fragment that is a secret - an invite link's
 * admission grant (channel-encryption section 25) - so a copied or bookmarked address does not
 * carry it along. Here because this module is the one writer of the History API: the router's own
 * `replaceState` refuses to run before it has started, which a page's first mount can precede.
 */
export function dropAddressFragment(): void {
  if (!isBrowser || !location.hash) return;
  const before = currentHref();
  history.replaceState(history.state, '', location.pathname + location.search);
  if (hereHref === before) hereHref = currentHref();
  Log.d('historyOverlay', 'fragment dropped from the address');
}

/** Drop stack entries without invoking close handlers (app teardown). */
export function clearHistoryOverlayStack(): void {
  stack.length = 0;
  here = 0;
  hereHref = '';
  walking = false;
}

export function historyOverlayStackDepth(): number {
  return stack.length;
}
