/**
 * Authenticated PIN change for a logged-in user.
 *
 * Unlike the destructive "forgot PIN" reset, this preserves all messages: the
 * in-memory MLS state (already decrypted at login) is re-encrypted under the new
 * PIN via {@link IMlsService.changePIN}, the local message DB is re-encrypted via
 * {@link reencryptLocalMessages}, and the account-wide verifier is rotated
 * server-side after proving knowledge of the current PIN.
 *
 * Because the verifier is account-wide, the user's other devices keep their old
 * PIN locally and will hit a mismatch at their next login - they must re-enter the
 * new PIN (and re-enrol biometric). That is inherent: the PIN never leaves a device.
 */
import { decryptData } from '$lib/encryption';
import { getStorage, type IStorage, type StoredMessage } from '$lib/db';
import { computePinVerifier } from '$lib/utils/chat/auth';
import { savePin } from '$lib/utils/pinVault';
import { getToken } from '$lib/stores/auth';
import { BiometricService } from '$lib/services/biometric';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { m } from '$lib/paraglide/messages';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import type { IMlsService } from '$lib/mls-client';

/** Batch size for local message re-encryption (avoids memory spikes on large histories). */
const REENCRYPT_BATCH_SIZE = 200;

/** How often re-encryption reports progress and yields to the UI thread. */
const REENCRYPT_PROGRESS_INTERVAL = 25;

/** Identifies the current step of a PIN change or cross-device recovery flow. */
export type PinOperationStage =
  | 'verify'
  | 'server'
  | 'mls'
  | 'messages_decrypt'
  | 'messages_encrypt'
  | 'finalize'
  | 'login';

/** User-facing progress snapshot for PIN change / recovery modals. */
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
 * Re-encrypts every locally stored message from `oldPin` to `newPin`.
 * Conversation metadata is plaintext and untouched; only message payloads use the PIN.
 *
 * @returns The number of messages successfully re-encrypted.
 * @throws When encrypted rows exist but none decrypt with `oldPin` (wrong PIN or corruption).
 */
export async function reencryptLocalMessages(
  storage: IStorage,
  oldPin: string,
  newPin: string,
  log: (msg: string) => void = () => {},
  onProgress?: PinProgressCallback,
  percentRange: { start: number; end: number } = { start: 30, end: 80 }
): Promise<number> {
  if (oldPin === newPin) return 0;

  const rows = await storage.getAllEncryptedRows();
  if (rows.length === 0) return 0;

  const { start, end } = percentRange;
  const span = end - start;

  log(`[PIN_CHANGE] Re-chiffrement de ${rows.length} message(s) local(aux)…`);

  const decrypted: StoredMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    try {
      const payload = await decryptData(row.cipherText, row.iv, row.salt, oldPin);
      decrypted.push({
        id: row.id,
        conversationId: row.conversationId,
        timestamp: row.timestamp,
        senderId: payload.senderId,
        content: payload.content,
        readBy: Array.isArray(payload.readBy) ? payload.readBy : undefined,
        reactions: Array.isArray(payload.reactions) ? payload.reactions : undefined,
        readAt:
          typeof payload.readAt === 'number' && payload.readAt > 0 ? payload.readAt : undefined,
        serverTimestamp:
          typeof payload.serverTimestamp === 'number' && payload.serverTimestamp > 0
            ? payload.serverTimestamp
            : undefined,
        isDeleted: payload.isDeleted === true ? true : undefined,
        isEdited: payload.isEdited === true ? true : undefined,
      });
    } catch {
      console.warn('[PIN_CHANGE] Failed to decrypt message', row.id);
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
      `[PIN_CHANGE] Warning: ${rows.length - decrypted.length} message(s) skipped (decryption failed).`
    );
  }

  const batchCount = Math.ceil(decrypted.length / REENCRYPT_BATCH_SIZE);
  for (let i = 0; i < decrypted.length; i += REENCRYPT_BATCH_SIZE) {
    await storage.saveMessages(decrypted.slice(i, i + REENCRYPT_BATCH_SIZE), newPin);
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

  log(`[PIN_CHANGE] ${decrypted.length} message(s) re-encrypted with the new PIN.`);
  return decrypted.length;
}

/**
 * Refreshes this device's locally stored PIN material after the account PIN changed:
 * updates the session PIN vault and, on Tauri, re-enrols biometric so the keystore holds
 * the new PIN instead of the stale one. Shared by both the change and recovery flows.
 */
export async function applyNewPinLocally(
  newPin: string,
  log: (msg: string) => void
): Promise<void> {
  await savePin(newPin).catch(() => {});
  if (isTauriRuntime() && (await BiometricService.isConfigured().catch(() => false))) {
    await BiometricService.enableBiometric(newPin).catch((e) =>
      log(`[PIN] Biometric re-enrolment failed: ${e instanceof Error ? e.message : String(e)}`)
    );
  }
}

export interface PinChangeOptions {
  /** ID of the logged-in user whose PIN is changing. */
  userId: string;
  /** Live MLS service whose in-memory state will be re-encrypted under the new PIN. */
  mlsService: IMlsService;
  /** Updates the session's in-memory PIN so subsequent encryption uses the new value. */
  setPin: (pin: string) => void;
  /** Debug log sink. */
  log: (msg: string) => void;
  /** Optional progress reporter for modal progress bars. */
  onProgress?: PinProgressCallback;
}

/**
 * Performs the full PIN change. Throws with a user-facing (localized) message on
 * failure (e.g. wrong current PIN).
 *
 * Server-first ordering: the verifier rotation is the operation gated on the old
 * PIN, so it runs first; the local re-encryption follows. If the local step were
 * to fail afterwards the user can still recover by re-logging in with the new PIN.
 */
export async function performPinChange(
  opts: PinChangeOptions,
  currentPin: string,
  newPin: string
): Promise<void> {
  const { userId, mlsService, setPin, log, onProgress } = opts;
  log('[PIN_CHANGE] Starting PIN change…');
  reportProgress(onProgress, { percent: 5, stage: 'server' });

  const [oldVerifier, newVerifier, token] = await Promise.all([
    computePinVerifier(userId, currentPin),
    computePinVerifier(userId, newPin),
    getToken(),
  ]);

  const res = await fetch('/api/mls/security/pin-change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId, oldVerifier, newVerifier }),
  });
  if (res.status === 403) throw new Error(m.profile_pin_error_wrong_current());
  if (!res.ok) throw new Error(m.profile_pin_error_server_failed());

  reportProgress(onProgress, { percent: 20, stage: 'mls' });
  // Verifier rotated - re-encrypt MLS state and local message DB under the new PIN.
  await mlsService.changePIN(newPin);
  log('[PIN_CHANGE] MLS state re-encrypted with the new PIN.');

  const storage = await getStorage(userId);
  await reencryptLocalMessages(storage, currentPin, newPin, log, onProgress, {
    start: 25,
    end: 85,
  });

  reportProgress(onProgress, { percent: 92, stage: 'finalize' });
  setPin(newPin);

  // Refresh this device's stored PIN + biometric so silent re-login keeps working.
  await applyNewPinLocally(newPin, log);
  reportProgress(onProgress, { percent: 100, stage: 'finalize' });
  log('[PIN_CHANGE] Done.');
}
