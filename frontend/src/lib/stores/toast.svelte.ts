/**
 * Global toast notification store.
 *
 * Usage: call `showToast(message)` from anywhere; ToastContainer in +layout.svelte
 * renders and auto-dismisses them.
 */

export interface Toast {
  id: number;
  message: string;
  /** Visual intent: 'error' (red), 'warning' (amber), 'info' (neutral). */
  type: 'error' | 'warning' | 'info';
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
export function showToast(message: string, type: Toast['type'] = 'error', durationMs = 4500): void {
  const id = _nextId++;
  _toasts = [..._toasts, { id, message, type }];
  setTimeout(() => dismissToast(id), durationMs);
}

/** Immediately remove a toast by its id. */
export function dismissToast(id: number): void {
  _toasts = _toasts.filter((t) => t.id !== id);
}
