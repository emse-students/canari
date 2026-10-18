import { isWipeableAccountId } from '$lib/utils/accountLocalKeys';

/**
 * WHICH ACCOUNTS WERE DELETED FROM THIS DEVICE, and nothing else: the durable marker of an owed
 * wipe, and the ids whose wipe this process started. Kept apart from `accountLocalWipe.ts` because
 * the auth store and the login read it, and neither may load the store stack that module closes.
 */

/**
 * THE DURABLE "A WIPE IS OWED FOR THIS ACCOUNT" MARKER, so a wipe the app did not finish - killed
 * mid-way, a store another tab held open - is finished at the next start instead of never.
 *
 * Written only after the server CONFIRMED the deletion (204) and before the first local deletion;
 * cleared by `wipeDeletedAccountLocalData` once every step succeeded, or by a sign-in of the same
 * subject ({@link forgetDeletedAccountOnSignIn}). An allowlist: it holds only ids a confirmed
 * deletion named, and the resume touches nothing else.
 */
const PENDING_WIPES_KEY = 'canari_deleted_account_wipe_pending:v1';

/** The account ids a wipe is still owed for. Unreadable or malformed entries are reported, never used. */
export function pendingDeletedAccountWipes(): string[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PENDING_WIPES_KEY);
  } catch (e) {
    console.error('[DEL-LOCAL] the pending-wipe marker cannot be read:', e);
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not a list');
    const ids = parsed.filter((v): v is string => typeof v === 'string' && isWipeableAccountId(v));
    if (ids.length !== parsed.length) {
      console.error(
        '[DEL-LOCAL] the pending-wipe marker holds entries outside the allowlist - ignored'
      );
    }
    return ids;
  } catch (e) {
    console.error('[DEL-LOCAL] the pending-wipe marker is malformed - ignored:', e);
    return [];
  }
}

function writePendingWipes(ids: string[]): void {
  if (ids.length === 0) localStorage.removeItem(PENDING_WIPES_KEY);
  else localStorage.setItem(PENDING_WIPES_KEY, JSON.stringify(ids));
}

/**
 * Records that `userId`'s local data is owed a wipe. Call ONLY after the server confirmed the
 * deletion. A marker that cannot be written is logged: the wipe still runs, it just cannot resume.
 */
export function markDeletedAccountWipePending(userId: string): void {
  try {
    const ids = pendingDeletedAccountWipes();
    if (!ids.includes(userId)) writePendingWipes([...ids, userId]);
  } catch (e) {
    console.error(
      `[DEL-LOCAL] the pending-wipe marker for ${userId.slice(0, 8)} was not written - an interrupted wipe will not resume:`,
      e
    );
  }
}

/** Removes `userId` from the pending-wipe marker. */
export function clearDeletedAccountWipePending(userId: string): void {
  try {
    writePendingWipes(pendingDeletedAccountWipes().filter((id) => id !== userId));
  } catch (e) {
    console.error(
      `[DEL-LOCAL] the pending-wipe marker for ${userId.slice(0, 8)} was not cleared:`,
      e
    );
  }
}

/**
 * The accounts whose wipe this process has started RIGHT AFTER THE DELETE - never a resumed one,
 * which a sign-in in ANOTHER tab could not clear from this process's set. A wipe that FINISHES drops its marker, so without this an offline unlock of `X` that
 * read its key before the resume deleted it would find no marker left by the time it asks, and
 * re-create `CanariDB_X` under a session of an account that no longer exists. Cleared only by a
 * sign-in of that account ({@link forgetDeletedAccountOnSignIn}).
 */
const wipesStartedThisRun = new Set<string>();

/** Called by the wipe before its first step: `userId` is deleted, for the rest of this process. */
export function noteDeletedAccountWipeStarted(userId: string): void {
  wipesStartedThisRun.add(userId);
}

/**
 * Whether `userId` is an account deleted from this device and not signed in since: a wipe is owed
 * for it (the durable marker, shared by every tab) or one ran in this process. A session for it may
 * open NOTHING - its stores are being removed, and the account exists nowhere to sync them with.
 * Asked by every login before it opens a store (`loginImpl`); online the server refuses such an
 * account anyway, so what this decides is the OFFLINE unlock, which has no server to ask.
 */
export function isDeletedAccountHere(userId: string): boolean {
  return wipesStartedThisRun.has(userId) || pendingDeletedAccountWipes().includes(userId);
}

/**
 * THE ACCOUNT SIGNED IN AGAIN, SO NOTHING IS OWED FOR IT ANY MORE: called by a successful OIDC
 * callback naming `userId`, before its session opens anything.
 *
 * Why a sign-in proves it. `users.id` IS the OIDC subject, and the server refuses that subject's
 * sign-in while its erasure is running (`ACCOUNT_ERASURE_PENDING`, `account-erasure.service.ts`):
 * a callback that SUCCEEDS for `X` therefore comes after the erasure completed, and `X` is a NEW
 * account whose local data no wipe may touch. Without this, the marker of the old `X` (kept by a
 * refused case collision, a delete another tab blocked, a native failure) outlived the deletion and
 * a later resume - a second tab before its refresh, an offline cold start - wiped the new account
 * under its live session. The resume re-reads the marker before every step, which is what carries
 * this to another tab mid-wipe.
 */
export function forgetDeletedAccountOnSignIn(userId: string): void {
  wipesStartedThisRun.delete(userId);
  if (!pendingDeletedAccountWipes().includes(userId)) return;
  console.warn(
    `[DEL-LOCAL] ${userId.slice(0, 8)} signed in again after its erasure - the owed wipe of the deleted account is dropped, this is a new account`
  );
  clearDeletedAccountWipePending(userId);
}
