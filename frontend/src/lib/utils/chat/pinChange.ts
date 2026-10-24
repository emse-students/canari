/**
 * Moving this device from one device key to another, for BOTH ways the PIN can change.
 *
 * The device key is derived from the PIN, so a PIN change is a device key change, and it reaches a
 * device in one of two ways: the user changes the PIN HERE (`changePinImpl`), or the PIN was changed
 * on ANOTHER device and this one recovers with the old and the new PIN (`recoverPinImpl`). Both
 * derive the old key and the new key from the same server salt, so both can open what the old key
 * sealed. They differ only in where the MLS state comes from - the live client, or the stored blob
 * opened with the old key ({@link PinChangeOptions.storedMlsState}) - and everything else is ONE
 * path, {@link performPinChange}, because the two had drifted: the recovery re-sealed the messages
 * and forgot the Graine seeds, and both forgot the outbox.
 *
 * What the device key seals, and what this does with each, is the table in
 * `docs/wiki/frontend/modules/auth.md#what-the-device-key-seals-and-what-a-pin-change-does-with-each`.
 *
 * Unlike the destructive "forgot PIN" reset, this preserves everything. The account-wide PIN
 * verifier is rotated (change) or checked (recovery) by the caller BEFORE this runs. The user's other
 * devices keep their old key locally and recover at their next login - the device key never leaves
 * the device.
 */
import { openSealedBytes, sealBytes } from '$lib/encryption';
import { resealDeviceRecoveryCode } from '$lib/crypto/deviceRecoveryCode';
import { getStorage, type IStorage, type SealedPayloadSwap, type SealedStore } from '$lib/db';
import {
  KeyChangeSupersededError,
  holdOtherRealmsForKeyChange,
  holdStorageForKeyChange,
} from '$lib/db/deviceKeyGate';

export { KeyChangeSupersededError };
import {
  clearDeviceKey,
  clearDeviceKeyAndWrapKey,
  retireUnlabelledDeviceKeyIfOwnedBy,
  saveDeviceKey,
} from '$lib/utils/deviceKeyVault';
import { BiometricService } from '$lib/services/biometric';
import { getTabLeadership } from '$lib/mls-client/tabLeader';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import type { IMlsService, StateLoadFailure } from '$lib/mls-client';

/** Rows sealed and swapped per step: bounds the new ciphertexts held at once. */
const RESEAL_BATCH_SIZE = 200;

/**
 * Every store `IStorage` seals under the device key. The MLS state is the other one, outside
 * `IStorage`, and is re-sealed by {@link IMlsService.changeDeviceKey}. A `Record` over the union, so
 * a store added to `SealedStore` without being added here fails `check` rather than being skipped.
 */
const SEALED_STORE_SET: Record<SealedStore, true> = { messages: true, graine: true, outbox: true };
const SEALED_STORES = Object.keys(SEALED_STORE_SET) as SealedStore[];

/** Identifies the current step of a device key change or cross-device recovery flow. */
export type PinOperationStage =
  | 'verify'
  | 'server'
  | 'mls'
  | 'messages_decrypt'
  | 'messages_encrypt'
  | 'finalize'
  | 'login'
  /** Another tab of the account still holds the lock: the change waits for it to let go. */
  | 'waiting_tabs';

/** User-facing progress snapshot for device key change / recovery modals. */
export interface PinOperationProgress {
  /** 0-100 inclusive. */
  percent: number;
  stage: PinOperationStage;
  /** Optional counter for message decrypt/encrypt steps. */
  current?: number;
  /** Optional total for message decrypt/encrypt steps. */
  total?: number;
}

export type PinProgressCallback = (progress: PinOperationProgress) => void;

function reportProgress(
  onProgress: PinProgressCallback | undefined,
  progress: PinOperationProgress
): void {
  onProgress?.(progress);
}

/**
 * The old key does not open this device's MLS state: the old PIN the user typed in a recovery is
 * wrong. Decided from the MLS blob - the one store every device has and that the old key provably
 * sealed - and never from the message stores, whose rows may sit under an even older key (a seed the
 * pre-2026-10-15 recovery left behind, an outbox row no earlier change moved). Thrown before
 * anything is written. Typed so the caller words it without reading a message.
 */
export class DeviceKeyMismatchError extends Error {
  constructor() {
    super('the old device key does not open the local MLS state');
    this.name = 'DeviceKeyMismatchError';
  }
}

/**
 * The stored MLS state refused to open for a reason NO PIN can fix: another device's identity
 * (`mismatch`), or a failure `mls-core` does not type (`unknown`, `keystore_unavailable`). Worded
 * apart from {@link DeviceKeyMismatchError}, which it used to be - and which sent the user round the
 * same keypad for ever. Thrown before anything is written.
 */
export class LocalStateUnopenableError extends Error {
  constructor(
    readonly failure: Exclude<StateLoadFailure, 'undecryptable' | 'rotated' | 'unreadable_now'>
  ) {
    super(`the local MLS state cannot be opened by any PIN (${failure})`);
    this.name = 'LocalStateUnopenableError';
  }
}

/**
 * The stored MLS state could not be read RIGHT NOW (`unreadable_now`: the browser's WebCrypto refused
 * it and nothing proved the bytes wrong - `MlsStateUnreadableNowError`). Neither "old PIN incorrect"
 * nor {@link LocalStateUnopenableError}, whose message sends the user to a reset: a reset would
 * destroy a state nothing showed to be broken. Thrown before anything is written; retrying later is
 * the whole remedy.
 */
export class LocalStateUnreadableNowError extends Error {
  constructor() {
    super('the local MLS state could not be read right now - nothing moved');
    this.name = 'LocalStateUnreadableNowError';
  }
}

/**
 * The change threw after it started moving this device. Carries the stage, never key material, and
 * the stage decides what the caller owes:
 *
 *  - `stores` / `mls`: data has moved - stores and MLS state may sit under two keys. The session
 *    must end into the recovery (which opens the MLS state with the old key and finishes the move)
 *    rather than keep running on the old key ({@link dataMoved}).
 *  - `keystore` / `vault`: no row and no state moved. The session's key is still the one everything
 *    here is sealed under, so it may run on; only the unlock changed (this account's vault slot is
 *    cleared before anything else, and on native the keystore may have moved: {@link keystoreMoved}),
 *    so the NEXT unlock asks for the PIN and is the one sent to the recovery. `vault` is also the
 *    stage of a failure in that first clearing (the unlabelled slot's retirement).
 */
export class KeyChangeInterruptedError extends Error {
  constructor(
    readonly stage: 'keystore' | 'vault' | 'stores' | 'mls',
    readonly keystoreMoved: boolean,
    readonly reason: unknown
  ) {
    super(`the device key change was interrupted at the ${stage} step: ${String(reason)}`);
    this.name = 'KeyChangeInterruptedError';
  }

  /** Whether a row or the MLS state may already be under the new key. */
  get dataMoved(): boolean {
    return this.stage === 'stores' || this.stage === 'mls';
  }
}

/** What {@link resealDeviceKeyStores} found and did, per store and in total. */
export interface ResealReport {
  /** Rows moved from the old key to the new one, per store. */
  resealed: Record<SealedStore, number>;
  /** Rows already under the new key: an earlier, interrupted run had moved them. */
  alreadyNew: number;
  /**
   * Rows that open under neither key - under a key older still, or damaged. Left exactly as they
   * are: the caller has already PROVEN the old key (server verifier or MLS blob), so these say
   * nothing about it, and refusing the change over them would lock the account out for good.
   */
  unreadable: number;
  /** Rows deleted or rewritten between the read and the swap - left to their writer. */
  changedSinceRead: number;
}

/** How {@link resealDeviceKeyStores} reports, and how many rows it seals and swaps per step. */
export interface ResealOptions {
  /** Debug log sink (counts only). */
  log?: (msg: string) => void;
  /** Progress reporter for the modal's bar. */
  onProgress?: PinProgressCallback;
  /** The share of the bar this pass fills. */
  percentRange?: { start: number; end: number };
  /** Rows sealed and swapped per step; {@link RESEAL_BATCH_SIZE} unless a test needs a small one. */
  batchSize?: number;
}

/**
 * Moves every row of every device-key-sealed store from `oldDeviceKeyB64` to `newDeviceKeyB64`.
 * Call it on a store nothing else writes to - {@link performPinChange} runs it under the storage gate.
 *
 * **RESUMABLE, BECAUSE IT CANNOT BE ATOMIC.** SQLite through the Tauri plugin has no multi-statement
 * transaction (`sqliteBatch.ts`), a history can be thousands of rows, and a phone can be killed half
 * way. So each row is classified by the key its own tag verifies under - the only record of which
 * key sealed it - and a row already under the new key is DONE, not damaged. A run cut anywhere leaves
 * every row under one of the two keys, and the next run (the recovery the user is sent to, with the
 * same two PINs) finishes it. Nothing is ever deleted.
 *
 * **ONE STORE'S CIPHERTEXTS IN MEMORY, NOT TWO COPIES OF EVERYTHING.** A store is read whole (the
 * footprint the old message pass already had, and what a backup export reads), then sealed and
 * swapped `RESEAL_BATCH_SIZE` rows at a time, so the new ciphertexts held at once are one batch.
 *
 * Each write is a compare-and-swap ({@link IStorage.swapSealedPayloads}), so even a writer that
 * escaped the gate cannot be overwritten with an older payload or have a deleted row brought back.
 * The plaintext BYTES are re-sealed, never parsed: this is a re-seal, not a rewrite of the payload.
 * Logs counts only - never a row id, never key material.
 */
export async function resealDeviceKeyStores(
  storage: IStorage,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string,
  options: ResealOptions = {}
): Promise<ResealReport> {
  const {
    log = () => {},
    onProgress,
    percentRange = { start: 10, end: 85 },
    batchSize = RESEAL_BATCH_SIZE,
  } = options;
  const report: ResealReport = {
    resealed: { messages: 0, graine: 0, outbox: 0 },
    alreadyNew: 0,
    unreadable: 0,
    changedSinceRead: 0,
  };
  if (oldDeviceKeyB64 === newDeviceKeyB64) return report;

  const { start, end } = percentRange;
  const span = end - start;
  const storeSpan = span / SEALED_STORES.length;

  for (const [storeIndex, store] of SEALED_STORES.entries()) {
    const rows = await storage.getSealedPayloads(store);
    let storeUnreadable = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const swaps: SealedPayloadSwap[] = [];
      for (const row of batch) {
        const plain = await openSealedBytes(row.cipherText, row.iv, oldDeviceKeyB64);
        if (plain) {
          const sealed = await sealBytes(plain, newDeviceKeyB64);
          swaps.push({ id: row.id, expected: row.cipherText, ...sealed });
        } else if (await openSealedBytes(row.cipherText, row.iv, newDeviceKeyB64)) {
          report.alreadyNew++;
        } else {
          storeUnreadable++;
        }
      }
      const swapped = await storage.swapSealedPayloads(store, swaps);
      report.resealed[store] += swapped;
      report.changedSinceRead += swaps.length - swapped;
      const done = Math.min(i + batchSize, rows.length);
      reportProgress(onProgress, {
        percent: Math.round(start + storeSpan * (storeIndex + done / rows.length)),
        stage: 'messages_encrypt',
        current: done,
        total: rows.length,
      });
      await yieldToMainThread();
    }
    if (storeUnreadable > 0) {
      // EVERY SWALLOWED BRANCH LOGS: these rows stay unreadable on this device, and this says how many.
      log(
        `[DEVICEKEY_CHANGE] Warning: ${storeUnreadable} ${store} row(s) open under neither key - left as they are.`
      );
    }
    report.unreadable += storeUnreadable;
  }

  log(
    `[DEVICEKEY_CHANGE] Re-sealed under the new device key: messages=${report.resealed.messages} ` +
      `seeds=${report.resealed.graine} outbox=${report.resealed.outbox}; already new=${report.alreadyNew}, ` +
      `unreadable=${report.unreadable}, changed since read=${report.changedSinceRead}`
  );
  if (report.changedSinceRead > 0) {
    // Under the gate nothing else writes, so a row that moved under us is a writer that escaped it.
    log(
      `[DEVICEKEY_CHANGE] ERROR: ${report.changedSinceRead} row(s) changed during the re-seal - a writer bypassed the storage gate.`
    );
  }
  return report;
}

/**
 * Deletes the feed's stored first pages instead of re-sealing them under the new device key.
 *
 * They are a COPY the server's next answer rewrites (`$lib/posts/feedStore`), so re-sealing them is
 * work for nothing, and leaving them under the old key would make every later read fail to open
 * them - a warning on every launch about a copy nobody needs. Never fatal: a page left behind is
 * deleted by the first read that cannot open it.
 */
export async function dropStoredFeedPages(
  storage: IStorage,
  log: (msg: string) => void = () => {}
): Promise<void> {
  try {
    const dropped = await storage.deleteFeedPages();
    log(
      `[DEVICEKEY_CHANGE] ${dropped} stored feed page(s) dropped - the next feed answer rewrites them.`
    );
  } catch (e) {
    log(`[DEVICEKEY_CHANGE] Warning: the stored feed pages could not be dropped: ${String(e)}`);
  }
}

/**
 * Moves the device's backup recovery code to the new device key, beside the sealed stores
 * (`deviceRecoveryCode.ts`). NEVER FATAL to the key change: a code that could not be re-sealed is
 * logged at ERROR, and the next export finds it unreadable, replaces it and TELLS the user - whereas
 * failing the change here would leave the stores half moved for a code.
 */
export async function moveDeviceRecoveryCode(
  userId: string,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string,
  log: (msg: string) => void
): Promise<void> {
  try {
    await resealDeviceRecoveryCode(userId, oldDeviceKeyB64, newDeviceKeyB64, log);
  } catch (e) {
    log(`[DEVICEKEY_CHANGE] ERROR: the backup recovery code was not re-sealed: ${String(e)}`);
  }
}

/**
 * Takes the OLD device key out of this device's vault - the first thing {@link performPinChange}
 * writes, BEFORE the keystore ({@link IMlsService.pointUnattendedUnlockAt}).
 *
 * A vault slot - this account's own, or the unlabelled one of an older build when it holds this very
 * key - that kept the old key past a failed step or a kill would unlock, without the server PIN check,
 * an MLS state not yet re-sealed: a silent login on the OLD PIN, no recovery ever offered, and a later
 * change deriving its "old" key from a PIN the rows were never sealed under. It ran after the keystore
 * until 2026-10-15, so a keystore refusal (an iPhone with no passcode) left the vault on the old key.
 * Only an unlock is removed here: the next launch asks for the PIN, which the server checks.
 */
export async function retireOldDeviceKeyFromVault(
  userId: string,
  oldDeviceKeyB64: string,
  log: (msg: string) => void
): Promise<void> {
  clearDeviceKey(userId);
  await retireUnlabelledDeviceKeyIfOwnedBy(userId, oldDeviceKeyB64);
  log('[DEVICEKEY] Old device key retired from the local vault.');
}

/**
 * Points this device's vault at the new device key, once the keystore holds it - the tail of
 * {@link performPinChange}'s first step. The old key already left in {@link retireOldDeviceKeyFromVault}.
 *
 * The keystore entry is NOT touched here: it was rewritten with the new key just before. Deleting it
 * would destroy the entry that was just written and turn biometric unlock off behind the user's back.
 */
export async function applyNewDeviceKeyLocally(
  userId: string,
  newDeviceKeyB64: string,
  log: (msg: string) => void
): Promise<void> {
  if (isTauriRuntime() && (await BiometricService.isConfigured().catch(() => false))) {
    // Biometrics on: the keystore is the source of truth. Keep the vault empty so the next
    // launch still takes the biometric path rather than a silent vault login.
    clearDeviceKeyAndWrapKey();
    log('[DEVICEKEY] New device key kept in the keystore - biometric unlock preserved.');
    return;
  }
  try {
    await saveDeviceKey(userId, newDeviceKeyB64);
    log('[DEVICEKEY] New device key saved to the local vault.');
  } catch (e) {
    // EVERY SWALLOWED BRANCH LOGS. The vault was cleared first, so a failed save leaves NO
    // unattended key: the next launch asks for the PIN, and this says why.
    log(`[DEVICEKEY] Saving the new device key to the local vault failed: ${String(e)}`);
  }
}

/**
 * Whether an IN-SESSION PIN change may start in this tab: only in the account's MLS leader tab.
 * Asked BEFORE the server verifier is rotated, so a refusal changes nothing anywhere.
 *
 * WHY THE LEADER ONLY, AND NOT A RE-SEAL OF THE STORED STATE. The change re-seals the MLS state from
 * the LIVE client ({@link IMlsService.changeDeviceKey}). A follower's client was loaded from a
 * snapshot older than the leader's last checkpoint, so the version guard refuses that write and the
 * change always ended into a recovery prompt. Re-sealing the stored state instead would not save it:
 * the change makes the leader go stale and reload, the reload frees the leader lock, the follower is
 * PROMOTED, and the promotion handler reloads it (`useChatSession.svelte.ts`) - in the middle of its
 * own change. Holding that promotion is a new cross-tab mechanism; refusing is a fact known here.
 *
 * `undecided` is refused too: the login decides leadership before any session exists, so a change
 * cannot honestly be asked before it is known, and a write is never made on a guess.
 */
export function thisTabMayChangeDeviceKey(log: (msg: string) => void): boolean {
  const leadership = getTabLeadership();
  if (leadership === 'leader') return true;
  log(
    `[DEVICEKEY_CHANGE] Refused in this tab (${leadership}): a PIN change runs in the leader tab only - nothing asked, nothing moved.`
  );
  return false;
}

export interface PinChangeOptions {
  /** ID of the user whose device key is changing. */
  userId: string;
  /** The MLS client: live for a change, freshly built for a recovery. */
  mls: IMlsService;
  /**
   * For a RECOVERY only: the stored MLS blob, opened with the old key as the proof the old PIN is
   * right. Absent for an in-session change, whose live client is already open and whose old key the
   * server verifier has just proven.
   */
  storedMlsState?: Uint8Array;
  /** Updates the session's in-memory device key so subsequent encryption uses the new value. */
  setDeviceKey: (deviceKeyB64: string) => void;
  /** Debug log sink. */
  log: (msg: string) => void;
  /** Optional progress reporter for modal progress bars. */
  onProgress?: PinProgressCallback;
}

/**
 * Moves this device from `oldDeviceKeyB64` to `newDeviceKeyB64`. Used by the in-session change AND
 * the recovery, in this order, each step chosen so a kill anywhere leaves a state the recovery
 * finishes:
 *
 *  1. PROOF (recovery only): the stored MLS blob opens with the old key, or {@link
 *     DeviceKeyMismatchError} - nothing written.
 *  2. THE UNATTENDED UNLOCK MOVES FIRST: the old key leaves the vault, then the keystore and the
 *     vault take the NEW key. Both skip the server PIN check, so had they kept the old key past a
 *     kill or a refusal, they would open the MLS state (not yet re-sealed) and run a session over
 *     stores already half moved - silently. With the new key, or none, every way in after a kill
 *     finds an MLS state it cannot open, or asks for the PIN, and is sent to the recovery. The vault
 *     save runs inside the other tabs' hold ({@link holdOtherRealmsForKeyChange}): every OTHER tab of
 *     this account has been told and has let go of the databases, and a second change started from
 *     another tab is ordered behind this one and stops before its vault save.
 *  3. THE STORES, under the storage gate: this realm's storage calls wait while they move, and the
 *     retired key is forwarded to the new one afterwards ({@link holdStorageForKeyChange}).
 *  4. The session adopts the new key.
 *  5. THE MLS STATE LAST, still inside the other tabs' hold - and every MLS state read and write goes
 *     through the same lock, so a tab that reloads reads it only once it has moved, and an old
 *     leader's checkpoint cannot land after it. It is the recovery's entry point (opened with the OLD
 *     key), so while it has not moved, the recovery is offered and finishes the stores. In the
 *     reverse order a kill left it under the new key and the remaining rows under a key no path would
 *     ever ask for again.
 *
 * A THROW from the vault retirement on is a {@link KeyChangeInterruptedError} with its stage; from the stores
 * on, the caller must end the session into the recovery rather than run on the old key.
 *
 * @throws {DeviceKeyMismatchError} in a recovery whose old key does not open the MLS state.
 * @throws {LocalStateUnopenableError} in a recovery whose MLS state no PIN can open.
 * @throws {LocalStateUnreadableNowError} in a recovery whose MLS state WebCrypto could not read right now.
 * @throws {KeyChangeInterruptedError} on any failure from the vault retirement on.
 * @throws {KeyChangeSupersededError} when another tab changed the key first; nothing here moved
 *         past the keystore.
 */
export async function performPinChange(
  opts: PinChangeOptions,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string
): Promise<void> {
  const { userId, mls, storedMlsState, setDeviceKey, log, onProgress } = opts;
  log('[DEVICEKEY_CHANGE] Starting device key change...');
  reportProgress(onProgress, { percent: 5, stage: 'mls' });

  if (storedMlsState) {
    const result = await mls.openLocalStateWithKey(userId, oldDeviceKeyB64, storedMlsState);
    if (!result.opened) {
      // ONLY A KEY REFUSAL IS THE OLD PIN'S FAULT. Another device's identity or an untyped failure
      // would refuse every PIN the user could type.
      log(`[DEVICEKEY_CHANGE] The local MLS state did not open (${result.cause}) - nothing moved.`);
      if (result.cause === 'undecryptable' || result.cause === 'rotated') {
        throw new DeviceKeyMismatchError();
      }
      if (result.cause === 'unreadable_now') throw new LocalStateUnreadableNowError();
      throw new LocalStateUnopenableError(result.cause);
    }
    log('[DEVICEKEY_CHANGE] The old key opens the local MLS state.');
  }

  // FROM HERE A THROW IS TYPED, with the stage it stopped at: from the stores on, data has moved and
  // the session must not run on the old key; before them nothing on this device has (see the error).
  // The keystore step is inside: on the change path the server verifier is ALREADY rotated, so an
  // untyped refusal here told the user to retry a change the server had already taken (iPhone 12
  // bench, 2026-10-15: the keystore refused every write on a phone with no passcode).
  // THE OLD KEY LEAVES THE VAULT BEFORE THE KEYSTORE IS ASKED ANYTHING: whichever later step fails,
  // no unattended unlock is left on the old key (see retireOldDeviceKeyFromVault).
  let stage: KeyChangeInterruptedError['stage'] = 'vault';
  let keystoreMoved = false;
  try {
    await retireOldDeviceKeyFromVault(userId, oldDeviceKeyB64, log);
    stage = 'keystore';
    keystoreMoved = await mls.pointUnattendedUnlockAt(newDeviceKeyB64);
    stage = 'vault';
    const storage = await getStorage(userId);
    // EVERYTHING FROM HERE RUNS WHILE THE OTHER TABS ARE HELD: two changes started from two tabs are
    // ordered by the exclusive lock, and the second stops before saving its key to the vault.
    await holdOtherRealmsForKeyChange(
      userId,
      async () => {
        reportProgress(onProgress, { percent: 8, stage: 'mls' });
        await applyNewDeviceKeyLocally(userId, newDeviceKeyB64, log);

        stage = 'stores';
        await holdStorageForKeyChange(storage, oldDeviceKeyB64, newDeviceKeyB64, async (store) => {
          const report = await resealDeviceKeyStores(store, oldDeviceKeyB64, newDeviceKeyB64, {
            log,
            onProgress,
            percentRange: { start: 10, end: 85 },
          });
          // The stored feed pages are a copy the server's next answer rewrites: dropped, not moved.
          await dropStoredFeedPages(store, log);
          await moveDeviceRecoveryCode(userId, oldDeviceKeyB64, newDeviceKeyB64, log);
          return report;
        });
        setDeviceKey(newDeviceKeyB64);

        stage = 'mls';
        reportProgress(onProgress, { percent: 88, stage: 'mls' });
        await mls.changeDeviceKey(newDeviceKeyB64);
      },
      () => reportProgress(onProgress, { percent: 6, stage: 'waiting_tabs' })
    );
  } catch (e) {
    if (e instanceof KeyChangeSupersededError) {
      log(
        '[DEVICEKEY_CHANGE] Another tab changed the device key first - this change did not start.'
      );
      throw e;
    }
    log(
      `[DEVICEKEY_CHANGE] ERROR: interrupted at the ${stage} step (keystore moved: ${keystoreMoved}) - ` +
        `the recovery finishes it: ${String(e)}`
    );
    throw new KeyChangeInterruptedError(stage, keystoreMoved, e);
  }
  log('[DEVICEKEY_CHANGE] MLS state re-sealed with the new device key.');
  reportProgress(onProgress, { percent: 100, stage: 'finalize' });
  log('[DEVICEKEY_CHANGE] Done.');
}

/**
 * {@link performPinChange} for an install with NO MLS state to carry: the old key leaves the vault,
 * then every sealed store moves, under the other tabs' hold and the storage gate - the same steps
 * in the same order, minus the MLS state. Used when an interrupted move to the hardware-held key is
 * finished at the unlock and nothing was ever stored (`finishMigrationAtUnlock`); the keystore
 * already holds the new key there, so it is not asked.
 *
 * @throws {KeyChangeInterruptedError} with its stage, as {@link performPinChange} does.
 */
export async function moveSealedStoresOnly(
  userId: string,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string,
  log: (msg: string) => void
): Promise<void> {
  log('[DEVICEKEY_CHANGE] Moving the sealed stores alone (no MLS state stored)...');
  let stage: KeyChangeInterruptedError['stage'] = 'vault';
  try {
    await retireOldDeviceKeyFromVault(userId, oldDeviceKeyB64, log);
    const storage = await getStorage(userId);
    await holdOtherRealmsForKeyChange(userId, async () => {
      stage = 'stores';
      await holdStorageForKeyChange(storage, oldDeviceKeyB64, newDeviceKeyB64, async (store) => {
        const report = await resealDeviceKeyStores(store, oldDeviceKeyB64, newDeviceKeyB64, {
          log,
        });
        await dropStoredFeedPages(store, log);
        await moveDeviceRecoveryCode(userId, oldDeviceKeyB64, newDeviceKeyB64, log);
        return report;
      });
    });
  } catch (e) {
    if (e instanceof KeyChangeSupersededError) {
      log('[DEVICEKEY_CHANGE] Another tab changed the device key first - the stores did not move.');
      throw e;
    }
    log(`[DEVICEKEY_CHANGE] ERROR: the store move stopped at the ${stage} step: ${String(e)}`);
    throw new KeyChangeInterruptedError(stage, true, e);
  }
  log('[DEVICEKEY_CHANGE] Sealed stores moved to the new device key.');
}
