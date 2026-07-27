/**
 * Device-key-based change for a logged-in user.
 *
 * Unlike the destructive "forgot PIN" reset, this preserves all messages: the
 * in-memory MLS state (already decrypted at login) is re-encrypted under the new
 * device key via {@link IMlsService.changeDeviceKey}, and the local message DB is
 * re-encrypted via {@link reencryptLocalMessages}.
 *
 * The account-wide PIN verifier rotation is handled by the caller BEFORE calling
 * {@link performPinChange} — this module only handles the local re-encryption.
 * Because the verifier is account-wide, the user's other devices keep their old
 * key locally and will hit a mismatch at their next login - they must re-enter the
 * new PIN (and re-enrol biometric). That is inherent: the device key never leaves
 * the device.
 */
import { decryptData } from '$lib/encryption';
import { getStorage, type IStorage, type StoredMessage } from '$lib/db';
import { clearDeviceKeyAndWrapKey, saveDeviceKey } from '$lib/utils/deviceKeyVault';
import { BiometricService } from '$lib/services/biometric';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { m } from '$lib/paraglide/messages';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import type { IMlsService } from '$lib/mls-client';

/** Batch size for local message re-encryption (avoids memory spikes on large histories). */
const REENCRYPT_BATCH_SIZE = 200;

/** How often re-encryption reports progress and yields to the UI thread. */
const REENCRYPT_PROGRESS_INTERVAL = 25;

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
 * Re-encrypts every locally stored message from `oldDeviceKeyB64` to `newDeviceKeyB64`.
 * Conversation metadata is plaintext and untouched; only message payloads use the device key.
 *
 * @returns The number of messages successfully re-encrypted.
 * @throws When encrypted rows exist but none decrypt with `oldDeviceKeyB64` (wrong key or corruption).
 */
export async function reencryptLocalMessages(
  storage: IStorage,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string,
  log: (msg: string) => void = () => {},
  onProgress?: PinProgressCallback,
  percentRange: { start: number; end: number } = { start: 30, end: 80 }
): Promise<number> {
  if (oldDeviceKeyB64 === newDeviceKeyB64) return 0;

  const rows = await storage.getAllEncryptedRows();
  if (rows.length === 0) return 0;

  const { start, end } = percentRange;
  const span = end - start;

  log(`[DEVICEKEY_CHANGE] Re-encrypting ${rows.length} local message(s)…`);

  const decrypted: StoredMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    try {
      const payload = (await decryptData(row.cipherText, row.iv, oldDeviceKeyB64)) as Record<
        string,
        unknown
      >;
      decrypted.push({
        id: row.id,
        conversationId: row.conversationId,
        timestamp: row.timestamp,
        senderId: payload.senderId as string,
        content: payload.content as string,
        readBy: Array.isArray(payload.readBy) ? (payload.readBy as string[]) : undefined,
        reactions: Array.isArray(payload.reactions)
          ? (payload.reactions as Array<{ emoji: string; userId: string }>)
          : undefined,
        readAt:
          typeof payload.readAt === 'number' && payload.readAt > 0
            ? (payload.readAt as number)
            : undefined,
        serverTimestamp:
          typeof payload.serverTimestamp === 'number' && payload.serverTimestamp > 0
            ? (payload.serverTimestamp as number)
            : undefined,
        isDeleted: payload.isDeleted === true ? true : undefined,
        isEdited: payload.isEdited === true ? true : undefined,
      });
    } catch {
      console.warn('[DEVICEKEY_CHANGE] Failed to decrypt message', row.id);
    }

    if (onProgress && (i % REENCRYPT_PROGRESS_INTERVAL === 0 || i === rows.length - 1)) {
      const frac = (i + 1) / rows.length;
      reportProgress(onProgress, {
        percent: Math.round(start + frac * span * 0.5),
        stage: 'messages_decrypt',
        current: i + 1,
        total: rows.length,
      });
    }
    if (i > 0 && i % REENCRYPT_PROGRESS_INTERVAL === 0) {
      await yieldToMainThread();
    }
  }

  if (decrypted.length === 0) {
    throw new Error(m.profile_pin_error_local_decrypt());
  }

  if (decrypted.length < rows.length) {
    log(
      `[DEVICEKEY_CHANGE] Warning: ${rows.length - decrypted.length} message(s) skipped (decryption failed).`
    );
  }

  const batchCount = Math.ceil(decrypted.length / REENCRYPT_BATCH_SIZE);
  for (let i = 0; i < decrypted.length; i += REENCRYPT_BATCH_SIZE) {
    await storage.saveMessages(decrypted.slice(i, i + REENCRYPT_BATCH_SIZE), newDeviceKeyB64);
    const batchIdx = Math.floor(i / REENCRYPT_BATCH_SIZE) + 1;
    if (onProgress) {
      const frac = batchIdx / batchCount;
      reportProgress(onProgress, {
        percent: Math.round(start + span * (0.5 + frac * 0.5)),
        stage: 'messages_encrypt',
        current: Math.min(batchIdx * REENCRYPT_BATCH_SIZE, decrypted.length),
        total: decrypted.length,
      });
    }
    if (batchIdx < batchCount) await yieldToMainThread();
  }

  log(`[DEVICEKEY_CHANGE] ${decrypted.length} message(s) re-encrypted with the new device key.`);
  return decrypted.length;
}

/**
 * Points this device's local unlock path at the new device key after the account PIN changed.
 * Shared by both the change and recovery flows.
 *
 * The keystore entry is NOT touched here: {@link IMlsService.changeDeviceKey} has already
 * overwritten it (and `push_context.json`) with the new key. Deleting it at this point would
 * destroy the entry that was just written and turn biometric unlock off behind the user's back.
 */
export async function applyNewDeviceKeyLocally(
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
  await saveDeviceKey(newDeviceKeyB64).catch(() => {});
  log('[DEVICEKEY] New device key saved to the local vault.');
}

export interface PinChangeOptions {
  /** ID of the logged-in user whose device key is changing. */
  userId: string;
  /** Live MLS service whose in-memory state will be re-encrypted under the new device key. */
  mlsService: IMlsService;
  /** Updates the session's in-memory device key so subsequent encryption uses the new value. */
  setDeviceKey: (deviceKeyB64: string) => void;
  /** Debug log sink. */
  log: (msg: string) => void;
  /** Optional progress reporter for modal progress bars. */
  onProgress?: PinProgressCallback;
}

/**
 * Performs the full device key change (local re-encryption only).
 *
 * The caller MUST have already rotated the PIN verifier server-side before calling
 * this function. This function handles:
 * 1. Re-encrypting the in-memory MLS state under the new device key.
 * 2. Re-encrypting all locally stored messages.
 * 3. Persisting the new device key in the vault and keystore.
 *
 * Throws with a user-facing (localized) message on failure.
 */
export async function performPinChange(
  opts: PinChangeOptions,
  currentDeviceKeyB64: string,
  newDeviceKeyB64: string
): Promise<void> {
  const { userId, mlsService, setDeviceKey, log, onProgress } = opts;
  log('[DEVICEKEY_CHANGE] Starting device key change…');
  reportProgress(onProgress, { percent: 5, stage: 'mls' });

  // Re-encrypt MLS state under the new device key.
  await mlsService.changeDeviceKey(newDeviceKeyB64);
  log('[DEVICEKEY_CHANGE] MLS state re-encrypted with the new device key.');

  const storage = await getStorage(userId);
  await reencryptLocalMessages(storage, currentDeviceKeyB64, newDeviceKeyB64, log, onProgress, {
    start: 10,
    end: 85,
  });

  reportProgress(onProgress, { percent: 92, stage: 'finalize' });
  setDeviceKey(newDeviceKeyB64);

  // Point this device's local unlock path at the new key so re-login keeps working.
  await applyNewDeviceKeyLocally(newDeviceKeyB64, log);
  reportProgress(onProgress, { percent: 100, stage: 'finalize' });
  log('[DEVICEKEY_CHANGE] Done.');
}
