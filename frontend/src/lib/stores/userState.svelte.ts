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

let _isEventValidator = $state<boolean>(false);

/**
 * Returns `true` when the current user may validate calendar events platform-wide: a member of a
 * BDE association holding `VALIDATE_EVENTS`. Mirrors the server's `isUserBdeAdmin`.
 *
 * Populated lazily by `ensureMyAssociations()`, from the same one answer as the two flags around
 * it - a second probe over the same endpoint would drift the moment one is force-refreshed.
 */
export function eventValidatorState(): boolean {
  return _isEventValidator;
}

/** Updates the reactive event-validator flag. */
export function setEventValidator(value: boolean): void {
  _isEventValidator = value;
}

let _isContentModerator = $state<boolean>(false);

/**
 * Returns `true` when the current user may moderate content platform-wide: a member of a BDE
 * association holding `MODERATE`. Mirrors the server's `isContentModerator`.
 *
 * Populated lazily by `ensureContentModerator()`, for the same reason as the super-admin flag
 * above: it depends on social-service data that login does not know.
 */
export function contentModeratorState(): boolean {
  return _isContentModerator;
}

/** Updates the reactive content-moderator flag. */
export function setContentModerator(value: boolean): void {
  _isContentModerator = value;
}

const FEED_AUDIENCE_KEY = 'canari_feed_audience';

const initialFeedAudience =
  typeof localStorage !== 'undefined'
    ? { true: true, false: false }[localStorage.getItem(FEED_AUDIENCE_KEY) ?? '']
    : undefined;

let _feedAudience = $state<boolean | null>(initialFeedAudience ?? null);

/**
 * Whether this account was last told it may see the social feed, or `null` if it has never been
 * told at all.
 *
 * WHY THE VERDICT IS REMEMBERED AND NOT RE-ASKED. It used to be a `GET /api/users/me` awaited
 * before the feed route's `load` even created its posts promise, so opening the Fil tab cost a
 * round trip before anything rendered - measured at 2045 ms to first paint against 262 ms on a
 * healthy link, on an account whose feed then turned out to be EMPTY. The answer changes when a
 * registrar changes someone's formation, which is not a per-tab-switch event, so the last answer
 * is the right thing to render from while a fresh one is fetched behind it.
 *
 * It is persisted rather than kept in memory because a cold start is exactly when the network is
 * least likely to be there, and it is cleared on logout and on a switch of account so a verdict
 * never outlives the person it was about.
 */
export function feedAudienceState(): boolean | null {
  return _feedAudience;
}

/** Records the feed-audience verdict, or forgets it when given `null`. */
export function setFeedAudience(value: boolean | null): void {
  _feedAudience = value;
  if (typeof localStorage === 'undefined') return;
  if (value === null) localStorage.removeItem(FEED_AUDIENCE_KEY);
  else localStorage.setItem(FEED_AUDIENCE_KEY, value ? 'true' : 'false');
}
