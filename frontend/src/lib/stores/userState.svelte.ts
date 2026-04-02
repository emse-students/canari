/**
 * Reactive wrapper around the current user ID.
 *
 * localStorage is not a Svelte reactive source, so reading it from `$derived`
 * only evaluates once.  This module keeps a `$state` mirror that is updated by
 * `saveUserLocally` / `clearUserLocally` so that any component using
 * `currentUserId()` inside `$derived` or `$effect` will re-run automatically.
 */

const initial =
  typeof localStorage !== 'undefined' ? localStorage.getItem('canari_saved_user') : null;

let _userId = $state<string | null>(initial);

export function currentUserId(): string | null {
  return _userId;
}

export function setCurrentUserId(id: string | null): void {
  _userId = id;
}
