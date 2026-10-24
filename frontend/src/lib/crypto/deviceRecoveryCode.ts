/**
 * ONE BACKUP RECOVERY CODE PER DEVICE (decision of 2026-10-22).
 *
 * Every `.canari` file this device exports is sealed under the SAME code, so the user keeps one code,
 * not one per file. The cost is written in `auth.md`: losing that code loses every backup the device
 * made, and knowing it opens all of them.
 *
 * WHERE THE CODE LIVES. In `localStorage` ({@link ACCOUNT_KEY}`.backupRecoveryCode`), SEALED under the
 * device key. Never in the clear: on a phone the device key is held by the hardware, and a plaintext
 * code beside the app's files would let a copy of those files open every backup of the device - the
 * thing the hardware key exists to prevent. Sealed, it moves with the key: every key change re-seals
 * it with the stores ({@link resealDeviceRecoveryCode}, called by `performPinChange`).
 *
 * A CODE IS KEPT ONLY ONCE A FILE WAS SAVED WITH IT ({@link DeviceRecoveryCode.keep}): a cancelled save
 * must not leave a code the user never saw, which a later export would then present as the one they
 * already hold.
 *
 * A stored code that the session's key does not open (the store was evicted with a stale entry, a
 * reset forgot the key) is REPLACED, and the outcome says so: the files made under the old code keep
 * opening with it, and the user is told the new one is new.
 */
import { liveDeviceKey, withDeviceKeyHeld } from '$lib/db/deviceKeyGate';
import { openSealedBytes, sealBytes } from '$lib/encryption';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { generateRecoveryCodeBytes, RECOVERY_CODE_BYTES } from './backupRecoveryCode';

/** Where the code an export uses came from. */
export type RecoveryCodeOrigin =
  /** The device's code, already shown at an earlier export. */
  | 'kept'
  /** The device had none: this is its first. */
  | 'new'
  /** The stored one does not open under this device key: a new one replaces it. */
  | 'replaced';

/** The code an export seals its file under. */
export interface DeviceRecoveryCode {
  bytes: Uint8Array;
  origin: RecoveryCodeOrigin;
  /**
   * Stores a `new` or `replaced` code once the file sealed with it exists, sealed under the device key
   * the stores are under NOW - not the one the export started under: a key change that ran during the
   * save (the move to the hardware-held key) re-sealed every store, and a code written under the old
   * key would read as `replaced` at the next export. A no-op for `kept`, which that change re-sealed.
   * Called through {@link keepDeviceRecoveryCode}, which runs it inside the storage gate.
   */
  keep: (currentDeviceKeyB64: string) => Promise<void>;
}

/** The stored shape: AES-GCM under the device key, base64. */
interface SealedCode {
  v: 1;
  iv: string;
  ct: string;
}

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** The stored entry, or `null` when there is none or it is not one this module wrote. */
function readSealed(store: Storage, userId: string, log: (msg: string) => void): SealedCode | null {
  const raw = store.getItem(ACCOUNT_KEY.backupRecoveryCode(userId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SealedCode>;
    if (parsed.v === 1 && typeof parsed.iv === 'string' && typeof parsed.ct === 'string') {
      return parsed as SealedCode;
    }
  } catch {
    // Logged below with the other shape refusal.
  }
  log('[BACKUP_CODE] ERROR: the stored recovery code is not one this build wrote - it is replaced');
  return null;
}

async function openWith(sealed: SealedCode, deviceKeyB64: string): Promise<Uint8Array | null> {
  const plain = await openSealedBytes(fromB64(sealed.ct), fromB64(sealed.iv), deviceKeyB64);
  return plain && plain.length === RECOVERY_CODE_BYTES ? plain : null;
}

async function writeSealed(
  store: Storage,
  userId: string,
  code: Uint8Array,
  deviceKeyB64: string
): Promise<void> {
  const { iv, cipherText } = await sealBytes(code, deviceKeyB64);
  const entry: SealedCode = { v: 1, iv: toB64(iv), ct: toB64(cipherText) };
  store.setItem(ACCOUNT_KEY.backupRecoveryCode(userId), JSON.stringify(entry));
}

/**
 * The code this device seals its next backup under: the stored one when the device key opens it,
 * otherwise a fresh one that {@link DeviceRecoveryCode.keep} stores once the file is saved.
 */
export async function deviceRecoveryCode(
  userId: string,
  deviceKeyB64: string,
  log: (msg: string) => void,
  store: Storage = localStorage
): Promise<DeviceRecoveryCode> {
  const sealed = readSealed(store, userId, log);
  if (sealed) {
    const bytes = await openWith(sealed, deviceKeyB64);
    if (bytes) {
      log('[BACKUP_CODE] the device recovery code is reused');
      return { bytes, origin: 'kept', keep: async () => {} };
    }
    log(
      '[BACKUP_CODE] ERROR: the stored recovery code does not open under this device key - a new one replaces it at the next saved export'
    );
  }
  const bytes = generateRecoveryCodeBytes();
  const hadEntry = store.getItem(ACCOUNT_KEY.backupRecoveryCode(userId)) !== null;
  const origin: RecoveryCodeOrigin = hadEntry ? 'replaced' : 'new';
  log(`[BACKUP_CODE] a recovery code is generated (${origin})`);
  return {
    bytes,
    origin,
    keep: async (currentDeviceKeyB64) => {
      await writeSealed(store, userId, bytes, currentDeviceKeyB64);
      log(
        currentDeviceKeyB64 === deviceKeyB64
          ? '[BACKUP_CODE] the device recovery code is stored'
          : '[BACKUP_CODE] the device recovery code is stored under the device key that replaced it during the export'
      );
    },
  };
}

/**
 * Keeps `code` once its file is saved, INSIDE the storage gate and under the key the stores are under
 * then ({@link liveDeviceKey} of the key the export started with). A device key change re-seals the
 * stored code inside the same gate (`moveDeviceRecoveryCode`), so the two are ordered: a keep that
 * enters first is moved by the change, and one that enters after writes under the new key - even
 * before the session adopts it, which happens only once the gate is released.
 */
export async function keepDeviceRecoveryCode(
  userId: string,
  code: DeviceRecoveryCode,
  exportKeyB64: string
): Promise<void> {
  await withDeviceKeyHeld(userId, () => code.keep(liveDeviceKey(exportKeyB64)));
}

/**
 * Re-seals the stored code from `oldDeviceKeyB64` to `newDeviceKeyB64` - a step of every device key
 * change, beside the sealed stores. Idempotent, so a change resumed after a kill runs it again: a code
 * already under the new key is left; one under neither is logged and left, and the next export
 * replaces it (and says so).
 */
export async function resealDeviceRecoveryCode(
  userId: string,
  oldDeviceKeyB64: string,
  newDeviceKeyB64: string,
  log: (msg: string) => void,
  store: Storage = localStorage
): Promise<void> {
  const sealed = readSealed(store, userId, log);
  if (!sealed) return;
  const underOld = await openWith(sealed, oldDeviceKeyB64);
  if (underOld) {
    await writeSealed(store, userId, underOld, newDeviceKeyB64);
    log('[BACKUP_CODE] the device recovery code is re-sealed under the new device key');
    return;
  }
  if (await openWith(sealed, newDeviceKeyB64)) return;
  log(
    '[BACKUP_CODE] ERROR: the stored recovery code opens under neither key - left, the next export replaces it'
  );
}

/**
 * Notes that backups made before the move to the hardware-held key no longer open on this device
 * (decision 4 of 2026-10-22), so the backup panel asks for a new one until it is made.
 */
export function noteBackupOwedAfterKeyMove(userId: string, store: Storage = localStorage): void {
  store.setItem(ACCOUNT_KEY.backupOwedAfterKeyMove(userId), '1');
}

/** Whether a new backup is owed since the move to the hardware-held key. */
export function backupOwedAfterKeyMove(userId: string, store: Storage = localStorage): boolean {
  return store.getItem(ACCOUNT_KEY.backupOwedAfterKeyMove(userId)) !== null;
}

/** A backup was saved: nothing is owed any more. */
export function clearBackupOwedAfterKeyMove(userId: string, store: Storage = localStorage): void {
  store.removeItem(ACCOUNT_KEY.backupOwedAfterKeyMove(userId));
}
