const STATE_KEY = 'canariOverlay';
const isBrowser = typeof window !== 'undefined';

type StackEntry = {
  close: () => void;
};

const stack: StackEntry[] = [];
let initialized = false;
let ignoreNextPop = false;

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

  const onPopState = () => {
    if (ignoreNextPop) {
      ignoreNextPop = false;
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
    ignoreNextPop = false;
    history.back();
    return;
  }
  stack.splice(idx, 1);
  close();
}

/**
 * Removes an overlay from the stack when it is dismissed indirectly
 * (e.g. opening a conversation closes the list drawer).
 */
export function abandonHistoryOverlay(close: () => void): void {
  if (!isBrowser) return;
  const idx = stack.findIndex((e) => e.close === close);
  if (idx < 0) return;
  const wasTop = idx === stack.length - 1;
  stack.splice(idx, 1);
  if (wasTop) {
    ignoreNextPop = true;
    history.back();
  }
}

/** Close every overlay from the stack (e.g. before SvelteKit navigation). */
export function drainHistoryOverlayStack(): void {
  while (stack.length > 0) {
    stack.pop()?.close();
  }
  ignoreNextPop = false;
}

/** Drop stack entries without invoking close handlers (app teardown). */
export function clearHistoryOverlayStack(): void {
  stack.length = 0;
  ignoreNextPop = false;
}

export function historyOverlayStackDepth(): number {
  return stack.length;
}
