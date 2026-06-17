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

/** Returns the currently authenticated user's ID, or `null` if not logged in. */
export function currentUserId(): string | null {
  return _userId;
}

/** Updates the reactive user ID state (called by `saveUserLocally` and `clearUserLocally`). */
export function setCurrentUserId(id: string | null): void {
  _userId = id;
}

const initialAdmin =
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('canari_global_admin') === 'true'
    : false;

let _isAdmin = $state<boolean>(initialAdmin);

/** Returns `true` when the current user holds the global admin role. */
export function globalAdminState(): boolean {
  return _isAdmin;
}

/** Updates the reactive global-admin flag (called after login and token refresh). */
export function setGlobalAdmin(value: boolean): void {
  _isAdmin = value;
}

let _isAssocSuperAdmin = $state<boolean>(false);

/**
 * Returns `true` when the current user is a cross-association super-admin:
 * a member of a BDE association holding `MANAGE_ASSO`. Such a user may administer
 * any association as if a local admin. Populated lazily by
 * `ensureAssociationSuperAdmin()` (the status depends on social-service data not
 * known at login).
 */
export function associationSuperAdminState(): boolean {
  return _isAssocSuperAdmin;
}

/** Updates the reactive association-super-admin flag. */
export function setAssociationSuperAdmin(value: boolean): void {
  _isAssocSuperAdmin = value;
}
