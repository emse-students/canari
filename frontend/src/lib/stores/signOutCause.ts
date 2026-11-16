/**
 * WHO DECIDED A SIGN-OUT, named by every caller of `clearAuth` and carried to the native log.
 *
 * A store build forwards no WebView console to logcat, so on a phone the ONLY sign-out line a
 * reader has without an inspector is the native `[PushEnd]` one - and until 2026-11-15 it said that
 * a sign-out happened, never which. On the Mi 9T a tap on the "Se deconnecter" button of the PIN
 * gate (a reload had re-armed the gate, and the button sits where the "Discussions" tab is) was
 * filed as a P2 "a reload then a tab tap signed the account out", and suspected of being a refresh
 * rotated twice, because logcat read exactly like a session the server had ended
 * (`docs/wiki/sessions.md`, "A sign-out names who decided it").
 *
 * A LABEL, NEVER A BRANCH: nothing reads it to decide anything, it is written to the log only. A
 * closed union so the compiler makes every exit name itself, and a new exit cannot forget to.
 */
export type SignOutCause =
  /** The person tapped "Se deconnecter" in the navbar or on the dashboard (`signOutByChoice`). */
  | 'chosen'
  /** The PIN gate's own "Se deconnecter" - the one exit of a gate that cannot be dismissed. */
  | 'pin-gate'
  /** The platform gate (maintenance, a version too old) offered a way out and it was taken. */
  | 'platform-gate'
  /** The identity-split notice: the credential names another account than the local state. */
  | 'identity-split'
  /** The person deleted their account from the settings' danger zone. */
  | 'account-deleted'
  /** The server refused the session (a 401/403 from core-service itself): `endExpiredSession`. */
  | 'session-expired'
  /** This device was revoked by its owner from another device, and is being wiped. */
  | 'device-revoked'
  /** Another tab of this origin deleted the account; nothing shared is revoked from here. */
  | 'account-deleted-in-another-tab';
