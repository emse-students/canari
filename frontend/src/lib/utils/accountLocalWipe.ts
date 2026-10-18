import { closeCachedStore, closeOpenIndexedDbStores } from '$lib/db';
import { closeOutboxBlobStores } from '$lib/db/outboxBlob';
import { closeMlsDb } from '$lib/utils/hex';
import { clearDeviceKey } from '$lib/utils/deviceKeyVault';
import { deleteIndexedDbByName } from '$lib/utils/indexedDbDelete';
import { isTauriRuntime } from '$lib/utils/openExternal';
import {
  ACCOUNT_KEY,
  accountLocalStorageKeysIn,
  isWipeableAccountId,
} from '$lib/utils/accountLocalKeys';

/** The IndexedDB databases keyed by an account id, all of which die with that account. */
export function accountIndexedDbNames(userId: string): string[] {
  return [`CanariDB_${userId}`, `CanariDBOutbox_${userId}`, `CanariDBMls_${userId}`];
}

/**
 * Whose local data a confirmed deletion may remove, decided from the ACCESS TOKEN THAT AUTHORISED
 * THE DELETE and never from what the page shows.
 *
 * The page's account (`currentUserId()`, read from `canari_saved_user`) and the server's account
 * (the token's `sub`) are two facts that can disagree: a second tab signed in as B rotates the
 * cookie while this tab still shows A, the DELETE then removes B, and wiping "the account on screen"
 * would destroy A - who still exists - on this device. So:
 *
 * - `wipe`: the token named an account, it is the one on screen, and its id passes the allowlist;
 * - `subject-mismatch`: the server deleted ANOTHER account than the one shown - nothing is wiped;
 * - `no-subject`: the token named nobody we could read - nothing is wiped;
 * - `unwipeable-id`: the id is outside the allowlist ({@link isWipeableAccountId}) - nothing is wiped.
 *
 * Every refusal is logged at ERROR here, at the decision: each is a deletion whose local data stays.
 */
export type DeletedAccountWipeDecision =
  | { kind: 'wipe'; userId: string }
  | { kind: 'subject-mismatch'; tokenSubject: string; displayedUserId: string | null }
  | { kind: 'no-subject' }
  | { kind: 'unwipeable-id'; userId: string };

/** See {@link DeletedAccountWipeDecision}. */
export function decideDeletedAccountWipe(
  tokenSubject: string | null,
  displayedUserId: string | null
): DeletedAccountWipeDecision {
  if (!tokenSubject) {
    console.error(
      '[DEL-LOCAL] the DELETE was authorised by a token naming no subject - local data NOT wiped'
    );
    return { kind: 'no-subject' };
  }
  if (tokenSubject !== displayedUserId) {
    console.error(
      `[DEL-LOCAL] the server deleted ${tokenSubject.slice(0, 8)} but this page shows ${displayedUserId?.slice(0, 8) ?? 'nobody'} - local data NOT wiped, the account on screen still exists`
    );
    return { kind: 'subject-mismatch', tokenSubject, displayedUserId };
  }
  if (!isWipeableAccountId(tokenSubject)) {
    console.error(
      `[DEL-LOCAL] the deleted account id is outside the allowlist - local data NOT wiped (${tokenSubject.slice(0, 8)})`
    );
    return { kind: 'unwipeable-id', userId: tokenSubject };
  }
  console.log(`[DEL-LOCAL] deleted account ${tokenSubject.slice(0, 8)} matches this page - wiping`);
  return { kind: 'wipe', userId: tokenSubject };
}

/**
 * THE DURABLE "A WIPE IS OWED FOR THIS ACCOUNT" MARKER, so a wipe the app did not finish - killed
 * mid-way, a store another tab held open - is finished at the next start instead of never.
 *
 * Written only after the server CONFIRMED the deletion (204) and before the first local deletion;
 * cleared by {@link wipeDeletedAccountLocalData} once every step succeeded. An allowlist: it holds
 * only ids a confirmed deletion named, and the resume touches nothing else.
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
function clearDeletedAccountWipePending(userId: string): void {
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
 * Finishes the wipes a previous run owed. At start-up, before any session for those ids exists.
 *
 * An id that is the account this install is SIGNED IN AS is never wiped: that account is live here
 * again (a new account with the same MiConnect subject), its data is not the deleted one's, and the
 * marker for it is dropped with an ERROR.
 */
export async function resumePendingDeletedAccountWipes(savedUserId: string | null): Promise<void> {
  const ids = pendingDeletedAccountWipes();
  if (ids.length === 0) return;
  console.log(`[DEL-LOCAL] resuming ${ids.length} owed wipe(s)`);
  for (const id of ids) {
    if (id === savedUserId) {
      console.error(
        `[DEL-LOCAL] a wipe is owed for ${id.slice(0, 8)}, which is signed in here again - NOT wiped, marker dropped`
      );
      clearDeletedAccountWipePending(id);
      continue;
    }
    await wipeDeletedAccountLocalData(id, {
      closeThisRunsHandles: false,
      expectNativeDatabase: false,
    });
  }
}

/**
 * Closes the handles this realm holds on the deleted account's stores, so the deletes that follow
 * do not BLOCK on them. Also called by another tab told of the deletion (`deletedAccountGuards.ts`).
 *
 * @returns whether a message store was open for that account in this run
 */
export async function closeDeletedAccountHandles(userId: string): Promise<boolean> {
  const hadStore = await closeCachedStore(userId);
  // The registries below are per realm and close every open connection: called only once no
  // session is running here (after `clearAuth`), so nothing live loses a handle.
  await closeOpenIndexedDbStores();
  await closeOutboxBlobStores();
  await closeMlsDb();
  return hadStore;
}

/** What the caller knows that changes how a wipe runs. */
export interface WipeDeletedAccountOptions {
  /**
   * Close this realm's store handles first. TRUE right after the deletion, in the realm that ran
   * the session; FALSE when resuming at start-up, where the realm-wide closes would cut another
   * account's live session and no handle on the deleted account can exist.
   */
  closeThisRunsHandles: boolean;
  /**
   * A native database for this account is KNOWN to exist (a store was open in this run), so a
   * native delete that finds no file is a FAILURE - the command looked in the wrong place.
   */
  expectNativeDatabase: boolean;
}

/**
 * Removes what ONE deleted account left on this device: its local message database, its slot of the
 * device-key vault, its platform-keystore entry and its per-account `localStorage` keys. NOT a device
 * reset - another account signed in on the same install keeps its database, its vault slot, the
 * in-app log, the preferences and `mls.bin` (one file per install, which may hold another account's
 * state, so it is deliberately left alone).
 *
 * A sign-out keeps all of this on purpose ("keep the state"); a DELETION is the one exit after which
 * nobody can ever open it again, so leaving it is only a cost: every message row stays under the
 * device key.
 *
 * BEST-EFFORT PER STEP AND NEVER SILENT, like the device wipe: the account is already gone on the
 * server, so one failing store must not stop the others, and each failure is logged and returned.
 * The pending marker ({@link markDeletedAccountWipePending}) is cleared only when NOTHING failed.
 *
 * @returns the steps that failed, empty when everything was removed
 */
export async function wipeDeletedAccountLocalData(
  userId: string,
  options: WipeDeletedAccountOptions
): Promise<string[]> {
  const tag = `[DEL-LOCAL] ${userId.slice(0, 8)}`;
  if (!isWipeableAccountId(userId)) {
    console.error(`${tag} refusing to wipe an account id outside the allowlist`);
    return ['the account id'];
  }
  const failures: string[] = [];
  console.log(`${tag} removing this account's local database, keys and vault slot`);

  const step = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      failures.push(what);
      console.error(`${tag} could not clear ${what}:`, e);
    }
  };

  let expectNativeDatabase = options.expectNativeDatabase;
  if (options.closeThisRunsHandles) {
    // Handles first: a delete does not fail on an open connection, it BLOCKS (see `deviceReset.ts`).
    await step('the store handles', async () => {
      if (await closeDeletedAccountHandles(userId)) expectNativeDatabase = true;
    });
  }

  // The WebView's databases exist on every platform (a phone's MESSAGE store is SQLite, but its
  // outbox blobs are IndexedDB), and are named by the account, so no other account is reachable.
  await step('the local IndexedDB databases', async () => {
    const results = await Promise.all(
      accountIndexedDbNames(userId).map((name) => deleteIndexedDbByName(name, '[DEL-LOCAL]'))
    );
    if (results.includes(false)) throw new Error('an IndexedDB delete failed or is deferred');
  });

  if (isTauriRuntime()) {
    await step('the native message database', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const removed = await invoke<number>('delete_user_database', {
        userId,
        expectDatabase: expectNativeDatabase,
      });
      console.log(`${tag} native database: ${removed} file(s) removed`);
    });
    // The device id is read BEFORE the keys below go: it is the other half of the alias.
    await step('the platform keystore entry', async () => {
      const deviceId = localStorage.getItem(ACCOUNT_KEY.deviceId(userId));
      if (!deviceId) return;
      const alias = `mls_device_key_${userId}_${deviceId}`;
      const { BiometricService } = await import('$lib/services/biometric');
      if (!(await BiometricService.isKeyPresent(alias))) return;
      await BiometricService.deleteKeyEntry(alias);
      if (await BiometricService.isKeyPresent(alias))
        throw new Error('the entry survived its delete');
    });
  }

  await step('the per-account local keys', async () => {
    // A keystore entry that survived keeps the device id it is named by, or the resume could never
    // find it again.
    const keepDeviceId = failures.includes('the platform keystore entry');
    const keys = accountLocalStorageKeysIn(localStorage, userId).filter(
      (k) => !(keepDeviceId && k === ACCOUNT_KEY.deviceId(userId))
    );
    for (const key of keys) localStorage.removeItem(key);
    console.log(`${tag} removed ${keys.length} per-account local key(s)`);
  });

  await step('the device-key vault slot', async () => {
    clearDeviceKey(userId);
  });

  if (failures.length > 0) {
    console.error(
      `${tag} finished with ${failures.length} unfinished step(s): ${failures.join(', ')} - the wipe resumes at the next start`
    );
  } else {
    clearDeletedAccountWipePending(userId);
    console.log(`${tag} done`);
  }
  return failures;
}
