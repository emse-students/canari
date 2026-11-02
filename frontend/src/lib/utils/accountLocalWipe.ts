import { closeCachedStore, closeOpenIndexedDbStores } from '$lib/db';
import { closeOutboxBlobStores } from '$lib/db/outboxBlob';
import { closeMlsDb } from '$lib/utils/hex';
import { clearDeviceKey } from '$lib/utils/deviceKeyVault';
import { deleteIndexedDbByName } from '$lib/utils/indexedDbDelete';
import { dropUploadReleaseMarksOf } from '$lib/utils/chat/uploadReleaseMarks';
import { isTauriRuntime } from '$lib/utils/openExternal';
import {
  ACCOUNT_KEY,
  accountLocalStorageKeysIn,
  caseCollidingAccountIdsIn,
  isWipeableAccountId,
  keystoreAlias,
  legacyConversationKeysIn,
  SESSION_META_STORE,
} from '$lib/utils/accountLocalKeys';
import {
  clearDeletedAccountWipePending,
  noteDeletedAccountWipeStarted,
  pendingDeletedAccountWipes,
} from '$lib/utils/deletedAccountMarker';

// The marker's writers, where the deletion's callers already import the wipe from.
export {
  markDeletedAccountWipePending,
  pendingDeletedAccountWipes,
} from '$lib/utils/deletedAccountMarker';

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
 * would destroy A - who still exists - on this device. So the wipe ALWAYS names the token's subject:
 *
 * - `wipe`: the token's subject, which is also the account on screen - its stores ran in this realm;
 * - `wipe-other-account`: the token's subject, which is NOT the account on screen. That account is
 *   certainly gone (the server answered 204 for it), so its data goes too - it would otherwise stay
 *   forever, since nothing else ever names it - but the account on screen is never touched, and
 *   this realm's handles are not closed for it (they belong to the account on screen);
 * - `no-subject`: the token named nobody we could read - nothing is wiped;
 * - `unwipeable-id`: the id is outside the allowlist ({@link isWipeableAccountId}) - nothing is wiped.
 *
 * Every refusal and the mismatch are logged at ERROR here, at the decision.
 */
export type DeletedAccountWipeDecision =
  | { kind: 'wipe'; userId: string }
  | { kind: 'wipe-other-account'; userId: string; displayedUserId: string | null }
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
  if (!isWipeableAccountId(tokenSubject)) {
    console.error(
      `[DEL-LOCAL] the deleted account id is outside the allowlist - local data NOT wiped (${tokenSubject.slice(0, 8)})`
    );
    return { kind: 'unwipeable-id', userId: tokenSubject };
  }
  if (tokenSubject !== displayedUserId) {
    console.error(
      `[DEL-LOCAL] the server deleted ${tokenSubject.slice(0, 8)} but this page shows ${displayedUserId?.slice(0, 8) ?? 'nobody'} - wiping the DELETED account only, the account on screen still exists`
    );
    return { kind: 'wipe-other-account', userId: tokenSubject, displayedUserId };
  }
  console.log(`[DEL-LOCAL] deleted account ${tokenSubject.slice(0, 8)} matches this page - wiping`);
  return { kind: 'wipe', userId: tokenSubject };
}

/**
 * What the resume asks of the auth layer, injected so it is testable and so this module does not
 * load the session stack. Every answer is read AT THE MOMENT of asking - never cached across an await.
 */
export interface AccountLiveness {
  /**
   * Whether `userId` SIGNED IN AGAIN: a token that landed in this process (an OIDC callback, a
   * refresh) names it. Never the saved user, which a kill before `clearAuth()` leaves naming the
   * deleted account - an answer read from it dropped the marker and kept the data for ever.
   */
  isLive: (userId: string) => boolean;
  /** Whether a sign-in (a refresh, an OIDC callback) is in flight, whose account is not known yet. */
  signInInFlight: () => boolean;
  /** Settles once no sign-in is in flight - immediately when none is. */
  whenSignInSettled: () => Promise<void>;
}

/** Why a resumed wipe stopped before a destructive step. */
export type WipeStop = 'account-live-again' | 'sign-in-in-flight' | 'no-longer-owed';

/**
 * The check the resume runs before EACH destructive step of `userId`'s wipe. The marker is re-read
 * each time because another tab may drop it - its OIDC callback signed `userId` in again (the case
 * that matters: this tab's token cannot see it), or its own resume finished the same wipe.
 */
function resumeStopFor(userId: string, live: AccountLiveness): () => WipeStop | null {
  return () => {
    if (live.isLive(userId)) return 'account-live-again';
    if (!pendingDeletedAccountWipes().includes(userId)) return 'no-longer-owed';
    if (live.signInInFlight()) return 'sign-in-in-flight';
    return null;
  };
}

/**
 * Finishes the wipes a previous run owed, at start-up, SERIALISED AGAINST SIGN-IN.
 *
 * The danger it is shaped against: a marker left for `X`, and `X` (the same MiConnect subject, now a
 * new account) signing back in while the resume runs - a wipe then deletes `CanariDB_X`, the device
 * id and the vault slot UNDER THE NEW LIVE SESSION. So:
 *
 * - it first waits for any sign-in already in flight to land, so the identity it reads is settled;
 * - before EVERY destructive step it asks again ({@link resumeStopFor}): `X` signed in AGAIN (a
 *   token naming it landed in this process, `account-live-again`) stops the wipe and drops the
 *   marker at ERROR - that account is live, and its data is no longer the deleted one's; a NEW
 *   sign-in in flight (`sign-in-in-flight`) stops the wipe and KEEPS the marker, since whose sign-in
 *   it is cannot be known yet - the next start resumes; the marker gone (`no-longer-owed`) stops
 *   it too - another tab's callback signed `X` in again (`forgetDeletedAccountOnSignIn`).
 *
 * A token is enough for `isLive` because the two ways `X` can open a session WITHOUT one are closed
 * elsewhere: a sign-in drops the marker at its callback, and every login refuses an account deleted
 * here before it opens a store (`isDeletedAccountHere`) - the offline unlock included.
 *
 * What it cannot close: a sign-in that STARTS while one step's own await runs (an IndexedDB delete).
 * A session opening `CanariDB_X` then queues behind the delete and opens an empty database - which
 * removes only rows of the deleted account, never the new session's.
 */
export async function resumePendingDeletedAccountWipes(live: AccountLiveness): Promise<void> {
  const ids = pendingDeletedAccountWipes();
  if (ids.length === 0) return;
  console.log(`[DEL-LOCAL] resuming ${ids.length} owed wipe(s) - waiting for any sign-in first`);
  await live.whenSignInSettled();
  for (const id of ids) {
    const failures = await wipeDeletedAccountLocalData(id, {
      closeThisRunsHandles: false,
      expectNativeDatabase: false,
      stopIf: resumeStopFor(id, live),
    });
    if (failures.includes(STOPPED_BY_SIGN_IN)) {
      console.warn(
        '[DEL-LOCAL] a sign-in started - the remaining owed wipes wait for the next start'
      );
      return;
    }
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
  /**
   * Asked before EACH destructive step; a non-null answer ends the wipe there. Passed by the resume
   * only ({@link resumePendingDeletedAccountWipes}): right after the deletion no sign-in can be
   * running for an account the server has just refused.
   */
  stopIf?: () => WipeStop | null;
}

/** The ids whose case collision this start already reported - see {@link wipeDeletedAccountLocalData}. */
const reportedCaseCollisions = new Set<string>();

/** The failure a wipe stopped by a sign-in in flight reports; its marker is KEPT. */
export const STOPPED_BY_SIGN_IN = 'stopped: a sign-in is in flight';
/** The failure a wipe stopped by its account being signed in again reports; its marker is DROPPED. */
export const STOPPED_ACCOUNT_LIVE = 'stopped: the account is signed in here again';
/** The failure a wipe whose marker disappeared under it reports; nothing more is removed. */
export const STOPPED_NO_LONGER_OWED = 'stopped: the wipe is no longer owed';
/** The failure a wipe refused for an id sharing storage with another by letter case reports. */
export const REFUSED_CASE_COLLISION = 'the account id (it differs from another only by case)';

/**
 * Removes what ONE deleted account left on this device: its local message database, its slot of the
 * device-key vault, its platform-keystore entry and its per-account `localStorage` keys. NOT a device
 * reset - another account signed in on the same install keeps its database, its vault slot, the
 * in-app log, the preferences and the `mls.bin` slot (the signed-in account's state). On a native
 * install the deleted account's own PARKED MLS state goes (`delete_user_mls_state`); the slot is
 * left alone, since only the teardown that ends a session may sweep it.
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
  // THE LIVE WIPE ONLY (no `stopIf`), before the first step: from here on an offline unlock of this
  // account is refused in this process even once the marker is gone (`isDeletedAccountHere`). NOT
  // the resume: a stale marker resumed in two web tabs would leave the flag in tab A after the user
  // signed in again from tab B, whose `forgetDeletedAccountOnSignIn` clears only its own process -
  // and tab A would refuse the new account. The resume's own guard is the marker, which tab B drops.
  if (!options.stopIf) noteDeletedAccountWipeStarted(userId);
  const twins = caseCollidingAccountIdsIn(localStorage, userId);
  if (twins.length > 0) {
    // Kept as owed on purpose: reported at ERROR once per start (the resume and the live wipe may
    // both ask), with the twins named, until a human looks.
    if (!reportedCaseCollisions.has(userId)) {
      reportedCaseCollisions.add(userId);
      console.error(
        `${tag} refusing to wipe, and the wipe stays OWED: ${twins.length} other account(s) on this device (${twins.map((t) => t.slice(0, 8)).join(', ')}) differ from it only by letter case, and three keys and the native database file would be shared - a human must decide`
      );
    }
    return [REFUSED_CASE_COLLISION];
  }
  const failures: string[] = [];
  console.log(`${tag} removing this account's local database, keys and vault slot`);

  let stopped: WipeStop | null = null;
  const step = async (what: string, run: () => Promise<void>) => {
    if (stopped) return;
    stopped = options.stopIf?.() ?? null;
    if (stopped) {
      console.error(`${tag} stopped before ${what}: ${stopped}`);
      return;
    }
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
    // The account's MLS state parked aside when another account took the install's slot
    // (`mls_account_state.rs`) - ONLY that account's directory, never the slot.
    await step('the parked MLS state', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const removed = await invoke<number>('delete_user_mls_state', { userId });
      console.log(`${tag} parked MLS state: ${removed} file(s) removed`);
    });
    // The push side's plaintext (unsent protos, push-decrypted messages, the bearer push token),
    // removed natively ONLY when `push_context.json` names this account - see `push.rs`.
    await step('the native push files', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const removed = await invoke<number>('delete_user_push_files', { userId });
      console.log(`${tag} native push files: ${removed} file(s) removed`);
    });
    // The notification replies still waiting for the page: ONLY this account's lines, since the file
    // can hold another account's (`delete_user_quick_replies`, `push.rs`). Always 0 off iOS.
    await step('the waiting quick replies', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const removed = await invoke<number>('delete_user_quick_replies', { userId });
      console.log(`${tag} waiting quick replies: ${removed} line(s) removed`);
    });
    // THE EXPLICIT RESET OF THE AT-REST KEY, and only once the data it seals is gone: while the
    // marker names the hardware-held key, the guard refuses the keystore delete below (`at_rest_key.rs`).
    // A database that survived keeps its marker, so the entry is refused too and the resume retries both.
    // The reset answers the entry the marker RECORDED - where the hardware-held key was written, which
    // a device identity rotated since no longer names (`cle_au_repos_oublier`).
    let markerAlias: string | null = null;
    await step('the at-rest key marker', async () => {
      if (failures.includes('the native message database')) {
        throw new Error('the native message database survived - its key stays guarded');
      }
      const { invoke } = await import('@tauri-apps/api/core');
      markerAlias = await invoke<string | null>('cle_au_repos_oublier', { userId });
    });
    // The device id is read BEFORE the keys below go: it is the other half of the alias.
    await step('the platform keystore entry', async () => {
      const deviceId = localStorage.getItem(ACCOUNT_KEY.deviceId(userId));
      const aliases = new Set<string>();
      if (markerAlias) aliases.add(markerAlias);
      if (deviceId) aliases.add(keystoreAlias(userId, deviceId));
      if (aliases.size === 0) {
        // The alias is `<userId>_<deviceId>`: without the id or a marker an entry cannot be named, so
        // one that exists (a device id lost to WebView eviction) is LEFT - said, never assumed absent.
        console.warn(
          `${tag} no device id and no at-rest marker for this account - no keystore entry can be named, none removed`
        );
        return;
      }
      const { BiometricService } = await import('$lib/services/biometric');
      for (const alias of aliases) {
        if (!(await BiometricService.isKeyPresent(alias))) continue;
        await BiometricService.deleteKeyEntry(alias);
        if (await BiometricService.isKeyPresent(alias))
          throw new Error('the entry survived its delete');
      }
    });
    // The native mirror of the last-active key (`sessionAuth.ts`), which no `localStorage` sweep reaches.
    await step('the native session metadata', async () => {
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load(SESSION_META_STORE, { autoSave: true, defaults: {} });
      if (await store.delete(ACCOUNT_KEY.lastActive(userId))) await store.save();
    });
  }

  // The device-wide release marks name this account: the server ended its sessions in the erasure
  // fan-out (media-service `cancelAllOwnedBy`), so they are dropped with the rest of its data.
  await step('the upload release marks', async () => {
    dropUploadReleaseMarksOf(userId, (line) => console.log(line));
  });

  await step('the per-account local keys', async () => {
    // A keystore entry that survived keeps the device id it is named by, or the resume could never
    // find it again.
    const keepDeviceId = failures.includes('the platform keystore entry');
    const keys = accountLocalStorageKeysIn(localStorage, userId).filter(
      (k) => !(keepDeviceId && k === ACCOUNT_KEY.deviceId(userId))
    );
    for (const key of keys) localStorage.removeItem(key);
    console.log(`${tag} removed ${keys.length} per-account local key(s)`);
    const { ambiguous } = legacyConversationKeysIn(localStorage, userId);
    if (ambiguous.length > 0) {
      console.warn(
        `${tag} ${ambiguous.length} legacy plaintext conversation key(s) KEPT: each may be another account's (an id starting with this one and '_')`
      );
    }
  });

  await step('the device-key vault slot', async () => {
    clearDeviceKey(userId);
  });

  // A widened read: TypeScript narrows `stopped` to `null` here, unaware the closure above sets it.
  const stoppedBy = stopped as WipeStop | null;
  if (stoppedBy === 'account-live-again') {
    console.error(
      `${tag} is signed in here again - the rest of the wipe is NOT run, marker dropped (its data is the live account's now)`
    );
    clearDeletedAccountWipePending(userId);
    return [...failures, STOPPED_ACCOUNT_LIVE];
  }
  if (stoppedBy === 'sign-in-in-flight') {
    console.error(
      `${tag} a sign-in is in flight - the wipe stops here and resumes at the next start`
    );
    return [...failures, STOPPED_BY_SIGN_IN];
  }
  if (stoppedBy === 'no-longer-owed') {
    console.warn(
      `${tag} the wipe is no longer owed (another tab finished it, or the account signed in again there) - stopped, nothing more removed`
    );
    return [...failures, STOPPED_NO_LONGER_OWED];
  }
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
