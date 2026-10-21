/**
 * The per-tab count of reloads a refused rotation has cost (`BaseMlsService.endDocumentAfterRefusedRotation`).
 *
 * Its own module because two layers clear it: the MLS service, once a key package round has
 * published, and the session teardown, once the account has left - and the teardown must not import
 * the service it tears down.
 *
 * NOT KEYED BY ACCOUNT, deliberately: every way an account leaves a tab passes the teardown, which
 * clears it, and the factory wipe empties `sessionStorage` whole. A per-account key would have to
 * join `accountLocalKeys.ts`, whose list is the `localStorage` sweep of an account deletion - a key
 * no deletion needs to sweep.
 */

/**
 * How many reloads IN A ROW, per tab, a refused rotation may cost before the page stops reloading.
 * Two: the first is the ordinary cure, the second covers a peer that was still mid-write; a third
 * would be the loop.
 */
export const MAX_REFUSED_ROTATION_RELOADS = 2;

/** The `sessionStorage` key of that count - per tab, kept across a reload, gone with the tab. */
export const REFUSED_ROTATION_RELOADS_KEY = 'canari.mls.refusedRotationReloads';

/**
 * Resets the count. Called when a key package round has PUBLISHED - the proof that this page holds
 * an identity the server accepts, so any run of refused rotations is over - and when the session
 * ends, so a sign-in after a sign-out in the same tab does not inherit a run it never had.
 * Best-effort: a count that could not be cleared only shortens a later bound in this tab.
 */
export function forgetRefusedRotationReloads(): void {
  try {
    sessionStorage.removeItem(REFUSED_ROTATION_RELOADS_KEY);
  } catch (e) {
    console.warn('[MLS] could not reset the refused-rotation reload count:', e);
  }
}
