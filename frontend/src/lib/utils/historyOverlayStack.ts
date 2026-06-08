/**
 * History-based overlay stack — Android Back button support.
 *
 * How it works on Android (Tauri / WebView):
 *  1. When a modal/drawer opens, `pushHistoryOverlay(close)` adds a
 *     `history.pushState` entry (same URL, no SvelteKit route change).
 *  2. When the user presses the physical Back button, Android delegates
 *     the event to the WebView. Since there is a history entry, the WebView
 *     fires a `popstate` event instead of exiting the app.
 *  3. `onPopState` pops the top of the stack and calls `close()`,
 *     dismissing the overlay — Back behaves like tapping the X button.
 *  4. If the stack is empty, `popstate` propagates normally:
 *     - SvelteKit navigates back (if there is router history), OR
 *     - Android exits the app (correct behaviour at the root screen).
 *
 * ⚠️  Every modal/drawer that should be closable via Back MUST call
 *     `pushHistoryOverlay` on open (use `bindHistoryOverlay.svelte.ts`).
 *     Modals that skip this step will not be intercepted by the Back button.
 *
 * No native Kotlin or Tauri plugin is required — `TauriActivity` already
 * delegates Back presses to the WebView by default.
 *
 * Ghost-entry problem & fix:
 *  When `drainHistoryOverlayStack` (called in `beforeNavigate`) clears the JS
 *  stack, the corresponding `history.pushState` entries are NOT removed — they
 *  become "ghost" entries in the browser history.  Calling `history.go(-n)`
 *  after SvelteKit has already pushed the new route would move the history
 *  pointer backwards and cause SvelteKit to navigate back — exactly the bug
 *  "la première action ramène à la page précédente".
 *
 *  Instead, `onPopState` detects ghost entries by their `{ canariOverlay: N }`
 *  state object: when the JS stack is empty but the state is ours, the entry
 *  is a ghost.  We skip it with `history.back()`, which fires another
 *  popstate.  The chain repeats until we reach a real SvelteKit state or the
 *  stack is no longer empty.  This makes ghost entries transparent to the user.
 *
 *  `skipPops` (a counter, formerly the boolean `ignoreNextPop`) is used when
 *  we deliberately call `history.back()` in `abandonHistoryOverlay` to remove
 *  an entry that was already spliced from the JS stack — we don't want
 *  `onPopState` to misinterpret that event.
 */
const STATE_KEY = 'canariOverlay';
const isBrowser = typeof window !== 'undefined';

type StackEntry = {
  close: () => void;
};

const stack: StackEntry[] = [];
let initialized = false;
/**
 * How many upcoming `popstate` events to absorb silently.
 * Incremented by `abandonHistoryOverlay` (and only that) before calling
 * `history.back()`.  This replaces the former boolean `ignoreNextPop`,
 * allowing multiple concurrent absorptions.
 */
let skipPops = 0;

/** Viewports where chat/drawers use full-screen overlays (matches Tailwind `xl`). */
export function isMobileOverlayLayout(): boolean {
  if (!isBrowser) return false;
  return window.matchMedia('(max-width: 1279px)').matches;
}

/**
 * Registers a global `popstate` listener. Call once from the root layout.
 * Returns a teardown function.
 */
export function initHistoryOverlayStack(): () => void {
  if (!isBrowser || initialized) return () => {};
  initialized = true;

  const onPopState = (event: PopStateEvent) => {
    // Absorb events that are the deliberate side-effect of `abandonHistoryOverlay`
    // calling `history.back()` after already splicing the entry from the JS stack.
    if (skipPops > 0) {
      skipPops--;
      return;
    }

    // Ghost-entry detection: the state belongs to us (canariOverlay key) but the
    // JS stack is empty because `drainHistoryOverlayStack` already cleared it.
    // Skip transparently so the user doesn't notice the phantom history entry.
    if (
      event.state !== null &&
      typeof event.state === 'object' &&
      STATE_KEY in event.state &&
      stack.length === 0
    ) {
      // Go back one more step. The resulting popstate will be processed by this
      // same handler: if the next entry is also a ghost, we skip again; if it is
      // a SvelteKit state, we fall through to the no-op `stack.pop()` branch.
      history.back();
      return;
    }

    const entry = stack.pop();
    entry?.close();
  };

  window.addEventListener('popstate', onPopState);
  return () => {
    window.removeEventListener('popstate', onPopState);
    initialized = false;
    stack.length = 0;
    skipPops = 0;
  };
}

/** Push a history entry; Android/iOS back will invoke `close`. */
export function pushHistoryOverlay(close: () => void): void {
  if (!isBrowser) return;
  stack.push({ close });
  history.pushState({ [STATE_KEY]: stack.length }, '');
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
  const idx = stack.findIndex((e) => e.close === close);
  if (idx < 0) {
    close();
    return;
  }
  if (idx === stack.length - 1) {
    // Do NOT increment skipPops here: the resulting popstate SHOULD reach
    // `onPopState` so it pops the stack entry and calls close().
    history.back();
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
  const idx = stack.findIndex((e) => e.close === close);
  if (idx < 0) return;
  const wasTop = idx === stack.length - 1;
  stack.splice(idx, 1);
  if (wasTop) {
    skipPops++;
    history.back();
  }
}

/**
 * Close every overlay and call their close handlers.
 *
 * Called by `beforeNavigate` in the root layout before every SvelteKit
 * navigation.  The corresponding `history.pushState` entries are NOT removed
 * here — they become ghost entries.  Ghost entries are handled transparently
 * by `onPopState` (see module-level comment above).
 *
 * ⚠️  Do NOT call `history.go(-count)` here.  That call is asynchronous and
 * fires AFTER SvelteKit has already pushed the new route, which moves the
 * history pointer backwards and causes SvelteKit to navigate back — the bug
 * known as "la première navigation ramène à la page précédente".
 */
export function drainHistoryOverlayStack(): void {
  while (stack.length > 0) {
    stack.pop()?.close();
  }
  // Do not reset skipPops: any pending absorptions from abandonHistoryOverlay
  // must still fire.
}

/** Drop stack entries without invoking close handlers (app teardown). */
export function clearHistoryOverlayStack(): void {
  stack.length = 0;
  skipPops = 0;
}

export function historyOverlayStackDepth(): number {
  return stack.length;
}
