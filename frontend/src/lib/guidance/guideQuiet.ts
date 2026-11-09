/**
 * WHEN A HELP MAY BE ON SCREEN - the "quiet state" (owner, 2026-11-02: never over the PIN gate, the
 * login, a call, the camera or a modal).
 *
 * Every fact is REAL APP STATE, read by `GuideOverlay.svelte` from the store that owns it, and the
 * overlay re-asks whenever one changes - so a help starts on the event that made the app quiet, never
 * after a delay that hoped it would be. The same predicate SUSPENDS a help already on screen: a call
 * ringing, a sheet opening or the keyboard rising hides it, and it comes back where it was.
 */
export interface QuietFacts {
  /** The MLS session is up (`globalSession.isLoggedIn`): false behind the PIN gate and the login. */
  readonly signedIn: boolean;
  /** The login page, the legal pages, a public form - no app chrome, nothing to point at. */
  readonly authPage: boolean;
  /** The camera is the whole screen (`isFullScreenPlace`). */
  readonly fullScreenPlace: boolean;
  /** A modal, sheet, drawer, viewer, call or PIN lock covers the screen (`screenCover`). */
  readonly screenCovered: boolean;
  /** A call exists, ringing or live - even minimised to the banner (`globalSession.callState`). */
  readonly callActive: boolean;
  readonly keyboardOpen: boolean;
  /** Overlays on the history stack OTHER than the help's own (a menu, a picker). */
  readonly otherOverlays: number;
  /** `afterNavigate` has run for the current route, so every component of it has mounted. */
  readonly routeSettled: boolean;
  /** A blocking gate is up: the minimum version, or maintenance. */
  readonly gated: boolean;
  /** iOS: the native tab bar is still being configured, so its tabs are not registered yet. */
  readonly nativeBarPending: boolean;
}

/**
 * The first reason the app is not quiet, or `null` when it is. A reason rather than a boolean so the
 * log can say what a help is waiting for.
 */
export function quietBlocker(f: QuietFacts): string | null {
  if (!f.signedIn) return 'no unlocked session';
  if (f.authPage) return 'a page without the app';
  if (f.gated) return 'a blocking gate';
  if (!f.routeSettled) return 'the route has not settled';
  if (f.fullScreenPlace) return 'the camera';
  if (f.callActive) return 'a call';
  if (f.screenCovered) return 'something covers the screen';
  if (f.otherOverlays > 0) return 'an overlay is open';
  if (f.keyboardOpen) return 'the keyboard is up';
  if (f.nativeBarPending) return 'the native tab bar is not configured yet';
  return null;
}
