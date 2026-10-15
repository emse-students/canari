/**
 * Moving this device from one device key to another, for BOTH ways the PIN can change.
 *
 * The device key is derived from the PIN, so a PIN change is a device key change, and it reaches a
 * device in one of two ways: the user changes the PIN HERE ({@link performPinChange} from
 * `changePinImpl`), or the PIN was changed on ANOTHER device and this one recovers with the old and
 * the new PIN (`recoverPinImpl`). Both derive the old key and the new key from the same server salt,
 * so both can open what the old key sealed - they differ only in where the MLS state comes from (the
 * live client, or the blob opened with the old key), and that difference is the one callback
 * {@link PinChangeOptions.resealMlsState}. Everything else is ONE path, because the two had drifted:
 * the recovery re-sealed the messages and forgot the Graine seeds, and both forgot the outbox.
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
import { getStorage, type IStorage, type SealedPayloadSwap, type SealedStore } from '$lib/db';
import { clearDeviceKeyAndWrapKey, saveDeviceKey } from '$lib/utils/deviceKeyVault';
import { BiometricService } from '$lib/services/biometric';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';

/** Rows per compare-and-swap write (avoids one huge transaction on a large history). */
const RESEAL_BATCH_SIZE = 200;

/** How often the re-seal reports progress and yields to the UI thread. */
const RESEAL_PROGRESS_INTERVAL = 25;

/**
 * Every store `IStorage` seals under the device key. The MLS state is the other one, outside
 * `IStorage`, and is {@link PinChangeOptions.resealMlsState}. A `Record` over the union, so a store
 * added to `SealedStore` without being added here fails `check` rather than being skipped.
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
  | 'login';

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
 * Sealed rows exist and NOT ONE of them opens under the old key or the new one: the old key is not
 * the key this device's data is under. Typed so each caller says it in its own words (a wrong
 * current PIN, a wrong old PIN) without reading a message. Thrown before anything is written.
 */
export class DeviceKeyMismatchError extends Error {
  constructor(readonly sealedRows: number) {
    super(`none of the ${sealedRows} sealed local row(s) opens under the old device key`);
    this.name = 'DeviceKeyMismatchError';
  }
}

/** What {@link resealDeviceKeyStores} found and did, per store and in total. */
export interface ResealReport {
  /** Rows moved from the old key to the new one, per store. */
  resealed: Record<SealedStore, number>;
  /** Rows already under the new key: an earlier, interrupted run had moved them. */
  alreadyNew: number;
  /** Rows that open under neither key - damaged. Left exactly as they are. */
  unreadable: number;
  /** Rows deleted or rewritten between the read and the swap - left to their writer. */
  changedSinceRead: number;
}

/**
 * Moves every row of every device-key-sealed store from `oldDeviceKeyB64` to `newDeviceKeyB64`.
 *
 * **RESUMABLE, BECAUSE IT CANNOT BE ATOMIC.** SQLite through the Tauri plugin has no multi-statement
 * transaction (`sqliteBatch.ts`), a history can be thousands of rows, and a phone can be killed half
 * way. So each row is classified by the key its own tag verifies under - the only record of which
 * key sealed it - and a row already under the new key is DONE, not damaged. A run cut anywhere leaves
 * every row under one of the two keys, and the next run (the recovery the user is sent to, with the
 * same two PINs) finishes it. Nothing is ever deleted, and a row that opens under neither key is
 * left as it is and counted.
 *
 * Each write is a compare-and-swap ({@link IStorage.swapSealedPayloads}): the in-session change runs
 * with the session live, and a row the outbox sent and deleted must not come back.
 *
 * The plaintext BYTES are re-sealed, never parsed: this is a re-seal, not a rewrite of the payload.
 *
 * @throws {DeviceKeyMismatchError} when sealed rows exist and none opens under either key - before
 *         anything is written.
 */
export async function resealDeviceKeyStores(
  storage: IStorage,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string,
  log: (msg: string) => void = () => {},
  onProgress?: PinProgressCallback,
  percentRange: { start: number; end: number } = { start: 10, end: 85 }
): Promise<ResealReport> {
  const report: ResealReport = {
    resealed: { messages: 0, graine: 0, outbox: 0 },
    alreadyNew: 0,
    unreadable: 0,
    changedSinceRead: 0,
  };
  if (oldDeviceKeyB64 === newDeviceKeyB64) return report;

  const stores = await Promise.all(
    SEALED_STORES.map(async (store) => ({ store, rows: await storage.getSealedPayloads(store) }))
  );
  const total = stores.reduce((n, s) => n + s.rows.length, 0);
  if (total === 0) return report;
  log(
    `[DEVICEKEY_CHANGE] Re-sealing ${total} local row(s): ` +
      stores.map((s) => `${s.store}=${s.rows.length}`).join(' ')
  );

  const { start, end } = percentRange;
  const span = end - start;

  // Phase 1 - classify and seal in memory. Nothing is written until every row has been looked at,
  // so a wrong old key is refused with the store untouched.
  const swaps = new Map<SealedStore, SealedPayloadSwap[]>();
  let seen = 0;
  for (const { store, rows } of stores) {
    const storeSwaps: SealedPayloadSwap[] = [];
    let storeUnreadable = 0;
    for (const row of rows) {
      const plain = await openSealedBytes(row.cipherText, row.iv, oldDeviceKeyB64);
      if (plain) {
        const sealed = await sealBytes(plain, newDeviceKeyB64);
        storeSwaps.push({ id: row.id, expected: row.cipherText, ...sealed });
      } else if (await openSealedBytes(row.cipherText, row.iv, newDeviceKeyB64)) {
        report.alreadyNew++;
      } else {
        storeUnreadable++;
      }
      seen++;
      if (seen % RESEAL_PROGRESS_INTERVAL === 0 || seen === total) {
        reportProgress(onProgress, {
          percent: Math.round(start + (seen / total) * span * 0.5),
          stage: 'messages_decrypt',
          current: seen,
          total,
        });
        await yieldToMainThread();
      }
    }
    if (storeUnreadable > 0) {
      log(
        `[DEVICEKEY_CHANGE] Warning: ${storeUnreadable} ${store} row(s) open under neither key - left as they are.`
      );
    }
    report.unreadable += storeUnreadable;
    swaps.set(store, storeSwaps);
  }

  const toWrite = [...swaps.values()].reduce((n, s) => n + s.length, 0);
  if (toWrite === 0 && report.alreadyNew === 0) {
    throw new DeviceKeyMismatchError(total);
  }

  // Phase 2 - write, batch by batch, each row only if it still holds what was read.
  let written = 0;
  for (const store of SEALED_STORES) {
    const storeSwaps = swaps.get(store) ?? [];
    for (let i = 0; i < storeSwaps.length; i += RESEAL_BATCH_SIZE) {
      const batch = storeSwaps.slice(i, i + RESEAL_BATCH_SIZE);
      const swapped = await storage.swapSealedPayloads(store, batch);
      report.resealed[store] += swapped;
      report.changedSinceRead += batch.length - swapped;
      written += batch.length;
      reportProgress(onProgress, {
        percent: Math.round(start + span * (0.5 + (written / toWrite) * 0.5)),
        stage: 'messages_encrypt',
        current: written,
        total: toWrite,
      });
      await yieldToMainThread();
    }
  }

  log(
    `[DEVICEKEY_CHANGE] Re-sealed under the new device key: messages=${report.resealed.messages} ` +
      `seeds=${report.resealed.graine} outbox=${report.resealed.outbox}; already new=${report.alreadyNew}, ` +
      `unreadable=${report.unreadable}, changed since read=${report.changedSinceRead}`
  );
  return report;
}

/**
 * Points this device's local unlock path at the new device key after the account PIN changed.
 * The tail of both the change and the recovery flow.
 *
 * The keystore entry is NOT touched here: {@link IMlsService.changeDeviceKey} has already
 * overwritten it (and `push_context.json`) with the new key. Deleting it at this point would
 * destroy the entry that was just written and turn biometric unlock off behind the user's back.
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
    // EVERY SWALLOWED BRANCH LOGS: the next launch then asks for the PIN, and this says why.
    log(`[DEVICEKEY] Saving the new device key to the local vault failed: ${String(e)}`);
  }
}

export interface PinChangeOptions {
  /** ID of the user whose device key is changing. */
  userId: string;
  /**
   * Re-seals the MLS state under the new device key - the ONE step the two paths do differently.
   * The in-session change re-seals the live client (`IMlsService.changeDeviceKey`); the recovery
   * opens the stored blob with the old key and re-seals that (`IMlsService.recoverAndRekey`).
   * Rejects when it cannot, with the caller's own user-facing error.
   */
  resealMlsState: (newDeviceKeyB64: string) => Promise<void>;
  /** Updates the session's in-memory device key so subsequent encryption uses the new value. */
  setDeviceKey: (deviceKeyB64: string) => void;
  /** Debug log sink. */
  log: (msg: string) => void;
  /** Optional progress reporter for modal progress bars. */
  onProgress?: PinProgressCallback;
}

/**
 * Moves this device from `oldDeviceKeyB64` to `newDeviceKeyB64`: every `IStorage` store, then the
 * MLS state, then the key this device unlocks with. Used by the in-session change AND the recovery.
 *
 * **THE STORES GO BEFORE THE MLS STATE**, because the MLS re-seal is the step that ends the way back:
 * the recovery's entry point is opening the MLS state with the OLD key. A run killed while the stores
 * are half moved therefore leaves the MLS state under the old key, the recovery is offered, and
 * {@link resealDeviceKeyStores} finishes what was started. In the reverse order a kill there left the
 * MLS state under the new key and every remaining row under a key no path would ever ask for again.
 *
 * @throws {DeviceKeyMismatchError} when the stores hold rows and none opens under either key -
 *         nothing written. Whatever `resealMlsState` throws, after the stores have moved.
 */
export async function performPinChange(
  opts: PinChangeOptions,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string
): Promise<void> {
  const { userId, resealMlsState, setDeviceKey, log, onProgress } = opts;
  log('[DEVICEKEY_CHANGE] Starting device key change...');
  reportProgress(onProgress, { percent: 5, stage: 'mls' });

  const storage = await getStorage(userId);
  await resealDeviceKeyStores(storage, oldDeviceKeyB64, newDeviceKeyB64, log, onProgress, {
    start: 10,
    end: 85,
  });

  reportProgress(onProgress, { percent: 88, stage: 'mls' });
  await resealMlsState(newDeviceKeyB64);
  log('[DEVICEKEY_CHANGE] MLS state re-sealed with the new device key.');

  reportProgress(onProgress, { percent: 92, stage: 'finalize' });
  setDeviceKey(newDeviceKeyB64);

  // Point this device's local unlock path at the new key so re-login keeps working.
  await applyNewDeviceKeyLocally(userId, newDeviceKeyB64, log);
  reportProgress(onProgress, { percent: 100, stage: 'finalize' });
  log('[DEVICEKEY_CHANGE] Done.');
}
