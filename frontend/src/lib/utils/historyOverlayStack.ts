import { Log } from './Log';
import { isOverlayLayout } from './viewport';
/**
 * History-based overlay stack - Android Back button support.
 *
 * How it works on Android (Tauri / WebView):
 *  1. When a modal/drawer opens, `pushHistoryOverlay(close)` adds a
 *     `history.pushState` entry (same URL, no SvelteKit route change).
 *  2. When the user presses the physical Back button, Android delegates
 *     the event to the WebView. Since there is a history entry, the WebView
 *     fires a `popstate` event instead of exiting the app.
 *  3. `onPopState` closes every overlay pushed after the entry the traversal
 *     landed on (`settleArrival`) - Back behaves like tapping the X button.
 *  4. If the stack is empty, `popstate` propagates normally:
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
 * Ghost-entry problem & fix:
 *  When `drainHistoryOverlayStack` (called in `beforeNavigate`) clears the JS
 *  stack, the corresponding `history.pushState` entries are NOT removed - they
 *  become "ghost" entries in the browser history.  Calling `history.go(-n)`
 *  after SvelteKit has already pushed the new route would move the history
 *  pointer backwards and cause SvelteKit to navigate back - exactly the bug
 *  "the first back gesture lands on the previous page".
 *
 *  Instead, `onPopState` detects ghost entries by their `{ canariOverlay: id }`
 *  state object: an entry of ours whose id no live overlay holds is a ghost.
 *  A ghost is also what `releaseHistoryOverlay` leaves when an owner closes
 *  its overlay by state, and it may sit ABOVE a live overlay. A landing that
 *  closes nothing walks one more entry with `history.back()`, so a Back
 *  always closes the overlay the person sees (`settleArrival`).
 *
 *  `skipPops` (a counter, formerly the boolean `ignoreNextPop`) is used when
 *  we deliberately call `history.back()` in `abandonHistoryOverlay` to remove
 *  an entry that was already spliced from the JS stack - we don't want
 *  `onPopState` to misinterpret that event.
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
 * The entry the history pointer is on, as far as this module moved it: the id of an entry this load
 * pushed, or 0 for any other entry. With `hereHref`, it tells a landing whether the Back that caused
 * it LEFT a ghost (see `settleArrival`).
 */
let here = 0;
/** The page address when `here` was last set: a ghost and its router entry share it. */
let hereHref = '';
/** A `history.back()` issued by `settleArrival` has not landed yet: its landing is not a Back. */
let walking = false;

/** The page address now; empty where there is none (a test without a `location`). */
function currentHref(): string {
  return globalThis.location?.href ?? '';
}
let initialized = false;
/**
 * How many upcoming `popstate` events to absorb silently.
 * Incremented by `abandonHistoryOverlay` (and only that) before calling
 * `history.back()`.  This replaces the former boolean `ignoreNextPop`,
 * allowing multiple concurrent absorptions.
 */
let skipPops = 0;
/**
 * The entry each of our entries was pushed ABOVE: the id of an entry of this load, or 0 for the
 * router's own (or an earlier load's). It is where a `history.back()` from that entry lands, which
 * is what lets a landing be recognised as OURS (`awaited`).
 */
const below = new Map<number, number>();
/**
 * Traversals this module started (`history.back()` from an abandon, a UI close or a walk) and has
 * not seen land, oldest first, each as the entry it will land on. While one is in flight, a push is
 * HELD (`pending`), see {@link pushHistoryOverlay}.
 *
 * ONLY A TRAVERSAL PROVEN TO LAND IS AWAITED: one that leaves an entry of ours, which was pushed
 * above another and so has one below it. A `history.back()` from the router's entry may be at the
 * history's FIRST entry, where it moves nothing and fires no `popstate` - a hold waiting for it would
 * never end, and every later overlay would get no entry at all (review of #1925). And a landing ends
 * the hold only when it arrives WHERE our traversal goes (`to`): a member's Back landing elsewhere
 * is theirs, never counted as ours.
 */
const awaited: { to: number }[] = [];
/**
 * Overlays opened while a traversal was in flight: on the JS side they are open, but their history
 * entry is written only once that traversal has landed (`flushPending`), in the order they opened.
 */
const pending: OverlayClose[] = [];

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
 */
export function initHistoryOverlayStack(): () => void {
  if (!isBrowser || initialized) return () => {};
  initialized = true;

  const onPopState = (event: PopStateEvent) => {
    const arrival = readArrival(event.state).id;
    if (awaited.length > 0 && awaited[0].to === arrival) {
      awaited.shift();
    } else if (pending.length > 0) {
      // The member's Back while overlays are held: those are what is on screen, on top of
      // everything with an entry, so they close first - never an overlay below them.
      Log.d('historyOverlay', `a Back during a hold closes the ${pending.length} held overlay(s)`);
      while (pending.length > 0) pending.pop()?.('back');
    }
    settlePopState(event);
    if (awaited.length === 0) flushPending();
  };

  const settlePopState = (event: PopStateEvent) => {
    const from = here;
    const fromHref = hereHref;
    here = readArrival(event.state).id;
    hereHref = currentHref();
    // Absorb events that are the deliberate side-effect of `abandonHistoryOverlay`
    // calling `history.back()` after already splicing the entry from the JS stack.
    if (skipPops > 0) {
      skipPops--;
      return;
    }
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
    skipPops = 0;
    awaited.length = 0;
    below.clear();
    pending.length = 0;
    here = 0;
    hereHref = '';
    walking = false;
  };
}

/**
 * Push a history entry; Android/iOS back will invoke `close`.
 *
 * A PUSH WAITS FOR A TRAVERSAL IN FLIGHT. `history.back()` is asynchronous and `pushState` is not,
 * so an overlay opened in the same task as another one is abandoned (a menu entry that opens the
 * camera) wrote its entry FIRST, and the abandon's traversal then went back off THAT entry: the
 * pointer sat on the menu's ghost, the next push truncated the camera's entry, and one Back on the
 * camera's review closed the review AND the camera (Mi 9T, v1.2.9-alpha.1, `Back closed 2
 * overlay(s)`, 2 of 2). The order is a fact this module holds (`awaited`), so the entry is
 * written when the traversal has landed - never after a delay.
 */
export function pushHistoryOverlay(close: OverlayClose): void {
  if (!isBrowser) return;
  if (awaited.length > 0) {
    Log.d('historyOverlay', `push held until ${awaited.length} traversal(s) in flight have landed`);
    pending.push(close);
    return;
  }
  writeEntry(close);
}

/** Writes `close`'s history entry and puts it on the stack. */
function writeEntry(close: OverlayClose): void {
  const id = ++lastId;
  stack.push({ close, id });
  history.pushState({ [STATE_KEY]: id, [LOAD_KEY]: LOAD_ID }, '');
  below.set(id, here);
  here = id;
  hereHref = currentHref();
}

/** Writes the entries held while a traversal was in flight, in the order their overlays opened. */
function flushPending(): void {
  if (pending.length === 0) return;
  Log.d('historyOverlay', `the traversal landed - writing ${pending.length} held entry(ies)`);
  for (const close of pending.splice(0)) writeEntry(close);
}

/**
 * `history.back()`, awaited when it is proven to land (`awaited`): it leaves an entry of ours, so
 * the entry it lands on is the one that entry was pushed above.
 */
function goBack(): void {
  const to = below.get(here);
  if (to === undefined) {
    Log.d('historyOverlay', 'going back from an entry not ours - its landing is not awaited');
  } else {
    awaited.push({ to });
  }
  history.back();
}

/** Takes `close` out of the held pushes; true when it was there (it has no history entry yet). */
function dropPending(close: OverlayClose): boolean {
  const idx = pending.indexOf(close);
  if (idx < 0) return false;
  pending.splice(idx, 1);
  return true;
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
 * Brings the stack in line with the history entry a traversal landed on.
 *
 * EVERY OVERLAY PUSHED AFTER THE ENTRY WE LANDED ON IS CLOSED, and nothing else. This used to pop the
 * top of the stack on any landing, which was right only while every open overlay held an entry and
 * every closed one had given its entry back. Neither holds: an overlay closed by its owner's state
 * (`releaseHistoryOverlay`: a tapped action, a publish) leaves its entry behind as a GHOST, and a
 * ghost above a live overlay turned one Back into the wrong one - it closed the overlay below and
 * left the history one entry out of step, so the next Back did nothing.
 *
 * When the landing closes nothing, the Back pressed still has to close something, so the walk goes
 * on one more entry: a ghost is stepped off (what the old code did only on an empty stack), and so is
 * a live entry reached from a ghost above it - the next landing closes that overlay. The walk ends at
 * the first landing that closes an overlay, or on a router entry with nothing open.
 *
 * `leftGhost` covers the last case: a Back pressed while the pointer sat ON a ghost (a picker that
 * closed on its choice, a confirmation answered, nothing else open) lands on the page's own router
 * entry and closes nothing - the press was spent on the ghost and the page did not move. It walks one
 * more entry too, so the Back does what it does on the page: the previous page, or nothing at the
 * history's first entry (where Android's next Back leaves the app).
 */
function settleArrival(state: unknown, leftGhost: boolean): void {
  const arrival = readArrival(state);
  const above: StackEntry[] = [];
  while (stack.length > 0 && stack[stack.length - 1].id > arrival.id) above.push(stack.pop()!);
  for (const entry of above) entry.close('back');
  if (above.length > 0) {
    Log.d('historyOverlay', `Back closed ${above.length} overlay(s), ${stack.length} left open`);
    return;
  }
  if (arrival.ghost || stack.length > 0 || leftGhost) {
    const where = arrival.ghost
      ? 'a ghost entry'
      : stack.length > 0
        ? 'a live entry from a ghost above it'
        : 'the router entry from a ghost above it';
    Log.d('historyOverlay', `Back landed on ${where} - walking one more`);
    walking = true;
    goBack();
  }
}

/**
 * Close from UI (X, backdrop). Uses `history.back()` when this overlay is on top
 * so the history stack stays consistent.
 */
export function closeHistoryOverlayFromUi(close: () => void): void {
  if (!isBrowser) {
    close();
    return;
  }
  if (dropPending(close)) {
    close();
    return;
  }
  const idx = stack.findIndex((e) => e.close === close);
  if (idx < 0) {
    close();
    return;
  }
  if (idx === stack.length - 1) {
    // Do NOT increment skipPops here: the resulting popstate SHOULD reach
    // `onPopState` so it pops the stack entry and calls close().
    goBack();
    return;
  }
  stack.splice(idx, 1);
  close();
}

/**
 * Removes an overlay from the stack when it is dismissed indirectly
 * (e.g. opening a conversation closes the list drawer).
 *
 * The entry is spliced from the JS stack first, then `history.back()` removes
 * the pushState entry from the browser history.  We increment `skipPops` so
 * `onPopState` absorbs the resulting event without trying to close anything.
 */
export function abandonHistoryOverlay(close: () => void): void {
  if (!isBrowser) return;
  if (dropPending(close)) return;
  const idx = stack.findIndex((e) => e.close === close);
  if (idx < 0) return;
  const wasTop = idx === stack.length - 1;
  stack.splice(idx, 1);
  if (wasTop) {
    skipPops++;
    goBack();
  }
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
 * No `history.back()` here, unlike {@link abandonHistoryOverlay}: the owner is typically about to
 * navigate, and an asynchronous traversal landing after the router's own push would walk the
 * pointer back off the new route (the bug the drain's comment names). The entry becomes the same
 * ghost the drain leaves, which `onPopState` already skips transparently. A no-op when the overlay
 * is already gone, which is the case on every dismissal that went through the stack itself.
 */
export function releaseHistoryOverlay(close: () => void): void {
  if (!isBrowser) return;
  if (dropPending(close)) return;
  const idx = stack.findIndex((e) => e.close === close);
  if (idx >= 0) stack.splice(idx, 1);
}

/**
 * Close every overlay and call their close handlers.
 *
 * Called by `beforeNavigate` in the root layout before every SvelteKit
 * navigation.  The corresponding `history.pushState` entries are NOT removed
 * here - they become ghost entries.  Ghost entries are handled transparently
 * by `onPopState` (see module-level comment above).
 *
 * ⚠️  Do NOT call `history.go(-count)` here.  That call is asynchronous and
 * fires AFTER SvelteKit has already pushed the new route, which moves the
 * history pointer backwards and causes SvelteKit to navigate back - the bug
 * known as "the first back gesture lands on the previous page".
 */
export function drainHistoryOverlayStack(): void {
  // Held overlays are the topmost: they close first, and never get an entry.
  while (pending.length > 0) pending.pop()?.('navigation');
  while (stack.length > 0) {
    stack.pop()?.close('navigation');
  }
  // The router is about to push or REPLACE the entry the pointer is on: it is no longer a ghost of
  // ours, and a Back from the next page must not be read as one pressed on it.
  here = 0;
  hereHref = '';
  // Do not reset skipPops: any pending absorptions from abandonHistoryOverlay
  // must still fire.
}

/** Drop stack entries without invoking close handlers (app teardown). */
export function clearHistoryOverlayStack(): void {
  stack.length = 0;
  pending.length = 0;
  skipPops = 0;
  awaited.length = 0;
  below.clear();
  here = 0;
  hereHref = '';
  walking = false;
}

export function historyOverlayStackDepth(): number {
  // A held overlay is open on screen: it stands the tab swipe down like any other.
  return stack.length + pending.length;
}
