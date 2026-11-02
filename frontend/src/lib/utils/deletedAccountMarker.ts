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

/**
 * WHY a wipe is owed, for the ids it is not a deletion for (round 8 of the review of #2919): a device
 * whose OWNER REVOKED it, on an install another account still uses, owes the same per-account wipe
 * (`wipeAccountOfRevokedDevice`), resumed by the same mechanism - but the account still exists, and
 * every line about it must say so. A separate key so the pending list keeps the shape every reader
 * already has; an id absent from it is a deletion.
 */
const WIPE_REASONS_KEY = 'canari_account_wipe_pending_reason:v1';

/** Why a per-account wipe is owed. */
export type AccountWipeReason = 'deleted' | 'revoked';

/** The tag every line about `reason`'s wipe carries: a revoked account is not a deleted one. */
export function wipeLogTag(reason: AccountWipeReason): string {
  return reason === 'revoked' ? '[REVOKED-LOCAL]' : '[DEL-LOCAL]';
}

function readWipeReasons(): Record<string, AccountWipeReason> {
  const raw = localStorage.getItem(WIPE_REASONS_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    const reasons: Record<string, AccountWipeReason> = {};
    for (const [id, reason] of Object.entries(parsed)) {
      if (reason === 'revoked' && isWipeableAccountId(id)) reasons[id] = reason;
    }
    return reasons;
  } catch (e) {
    console.error(
      '[REVOKED-LOCAL] the wipe-reason record is malformed - every owed wipe reads as a deletion:',
      e
    );
    return {};
  }
}

/** Why `userId`'s owed wipe is owed: `revoked` when its device was revoked, `deleted` otherwise. */
export function wipeReasonOf(userId: string): AccountWipeReason {
  try {
    return readWipeReasons()[userId] ?? 'deleted';
  } catch (e) {
    console.error(`[DEL-LOCAL] the wipe reason of ${userId.slice(0, 8)} cannot be read:`, e);
    return 'deleted';
  }
}

function writeWipeReason(userId: string, reason: AccountWipeReason | null): void {
  const reasons = readWipeReasons();
  if (reason === 'revoked') reasons[userId] = reason;
  else delete reasons[userId];
  if (Object.keys(reasons).length === 0) localStorage.removeItem(WIPE_REASONS_KEY);
  else localStorage.setItem(WIPE_REASONS_KEY, JSON.stringify(reasons));
}

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
 * deletion - or, with `reason: 'revoked'`, the owner's revocation of this device. A marker that cannot
 * be written is logged: the wipe still runs, it just cannot resume.
 */
export function markDeletedAccountWipePending(
  userId: string,
  reason: AccountWipeReason = 'deleted'
): void {
  try {
    writeWipeReason(userId, reason);
    const ids = pendingDeletedAccountWipes();
    if (!ids.includes(userId)) writePendingWipes([...ids, userId]);
  } catch (e) {
    console.error(
      `${wipeLogTag(reason)} the pending-wipe marker for ${userId.slice(0, 8)} was not written - an interrupted wipe will not resume:`,
      e
    );
  }
}

/** Removes `userId` from the pending-wipe marker. */
export function clearDeletedAccountWipePending(userId: string): void {
  try {
    writePendingWipes(pendingDeletedAccountWipes().filter((id) => id !== userId));
    writeWipeReason(userId, null);
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
  if (wipeReasonOf(userId) === 'revoked') {
    // The account was never deleted: its owner revoked THIS DEVICE, and has now signed in on it again
    // online - which enrols a new device. What is still owed belonged to the revoked one; the new
    // session's data is not it.
    console.warn(
      `[REVOKED-LOCAL] ${userId.slice(0, 8)} signed in again online on this device after its revocation - the owed wipe of the revoked device's data is dropped, the new session keeps its own`
    );
  } else {
    console.warn(
      `[DEL-LOCAL] ${userId.slice(0, 8)} signed in again after its erasure - the owed wipe of the deleted account is dropped, this is a new account`
    );
  }
  clearDeletedAccountWipePending(userId);
}
