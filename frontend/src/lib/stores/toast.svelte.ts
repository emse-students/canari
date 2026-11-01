/**
 * Global toast notification store.
 *
 * Usage: call `showToast(message)` from anywhere; ToastContainer in +layout.svelte
 * renders and auto-dismisses them.
 */
import { m } from '$lib/paraglide/messages';

/** One button a toast carries - the "Undo" of a change that saved at once. */
export interface ToastAction {
  /** Localized button text. */
  label: string;
  /** Runs once, then the toast closes. */
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  /** Visual intent: 'error' (red), 'warning' (amber), 'info' (neutral). */
  type: 'error' | 'warning' | 'info';
  action?: ToastAction;
  /** `false` for a {@link showPinnedToast}: no close button, only its action ends it. */
  dismissible?: boolean;
  /** Runs when the user closes it with its close button - never on the timeout. */
  onClose?: () => void;
}

let _toasts = $state<Toast[]>([]);
let _nextId = 0;

/** Reactive list of active toasts (read by ToastContainer). */
export const toastStore = {
  get toasts(): Toast[] {
    return _toasts;
  },
};

/**
 * Show a toast notification that auto-dismisses after `durationMs` (default 4.5 s).
 * Safe to call from any context (components, stores, composables).
 */
export function showToast(
  message: string,
  type: Toast['type'] = 'error',
  durationMs = 4500,
  action?: ToastAction,
  onClose?: () => void
): void {
  const id = _nextId++;
  _toasts = [..._toasts, { id, message, type, action, onClose }];
  setTimeout(() => dismissToast(id), durationMs);
}

/**
 * Show a toast the member CANNOT close: no timeout and no close button, only `action` ends it. For a
 * page that no longer works while it still looks alive - a notice closed there leaves exactly that
 * page, with nothing on it to say so.
 */
export function showPinnedToast(message: string, type: Toast['type'], action: ToastAction): void {
  _toasts = [..._toasts, { id: _nextId++, message, type, action, dismissible: false }];
}

/** How long an "Undo" stays offered: longer than a plain notice, since it asks for a decision. */
export const UNDO_TOAST_MS = 6000;

/**
 * Announce a change that ALREADY saved, with an "Undo" button that runs `undo`.
 *
 * The change is never held back waiting for the toast to expire: undoing is a second, inverse
 * write, so closing the page while the toast is up loses nothing.
 */
export function showUndoToast(message: string, undo: () => void): void {
  showToast(message, 'info', UNDO_TOAST_MS, { label: m.common_undo_label(), run: undo });
}

/** Immediately remove a toast by its id. */
export function dismissToast(id: number): void {
  _toasts = _toasts.filter((t) => t.id !== id);
}
