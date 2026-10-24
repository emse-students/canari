/**
 * The at-rest key held by the phone's secure hardware (user decision 2026-10-22).
 *
 * On a phone the key that seals `mls.bin`, the messages, the Graine seeds and the outbox is 32 random
 * bytes kept in the platform keystore (Android Keystore, iOS Keychain `ThisDeviceOnly`) - the entry
 * the background push already reads. The PIN no longer derives it: the server checks the PIN, and
 * only then is the key read from the keystore and installed. The native half, and the durable marker
 * saying which scheme seals this install, are `src-tauri/src/commands/at_rest_key.rs`.
 *
 * The web and desktop builds keep the PIN-derived key ({@link hardwareHeldKeyApplies} is false
 * there): a browser has no hardware keystore this code can bind a key to.
 *
 * Mechanism and the reasoning: docs/wiki/frontend/modules/auth.md, "The at-rest key on a phone is
 * held by the hardware".
 */

import { isMobileTauriRuntime } from '$lib/utils/appVersion';

/** Which key seals this install's data for an account - see `at_rest_key.rs`. */
export type AtRestKeyScheme = 'pin-derived' | 'migrating' | 'hardware' | 'unreadable';

/** Why the hardware-held key could not be read. */
export type HardwareKeyRefusal = 'not-hardware' | 'absent' | 'mismatch' | 'unreadable';

/** The answer of a keystore read: the key, or the refusal, typed. */
export type HardwareKeyRead = { key: string } | { refusal: HardwareKeyRefusal };

/**
 * The hardware-held key was asked for and is not there, or is not the key the marker names.
 *
 * Thrown at the read, as a type, carrying WHY: the login turns `absent` / `mismatch` into
 * `hardware_key_unavailable`, which offers the reset - no PIN can open data sealed under a random key
 * the keystore lost - and every other refusal into `hardware_key_unreadable`, which offers a retry
 * and no reset (`hardwareKeyLoginFailure`).
 */
export class HardwareKeyUnavailableError extends Error {
  constructor(readonly refusal: HardwareKeyRefusal) {
    super(`the hardware-held at-rest key is unavailable (${refusal})`);
    this.name = 'HardwareKeyUnavailableError';
  }
}

/** The native calls this module makes, passed in so the decisions can be tested without Tauri. */
export interface HardwareKeyPort {
  scheme(userId: string): Promise<AtRestKeyScheme>;
  /** Starts or resumes a re-key; the marker is `migrating` once this answers. */
  prepare(userId: string, deviceId: string): Promise<string>;
  /** `migrating` -> `hardware`, for this key only. */
  mark(userId: string, deviceKeyB64: string): Promise<void>;
  /**
   * The key at the entry the MARKER names (not one rebuilt from today's device id), checked against
   * the marker's check value.
   */
  read(userId: string): Promise<HardwareKeyRead>;
  /**
   * The explicit reset: forgets the marker, which is what lets the keystore entry be deleted or
   * rewritten again. Called only once this account's data on this install is gone.
   */
  forget(userId: string): Promise<void>;
}

/** True on the builds where the at-rest key is hardware-held: the phone apps. */
export function hardwareHeldKeyApplies(): boolean {
  return isMobileTauriRuntime();
}

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** The port over the five `cle_au_repos_*` commands. */
export const tauriHardwareKeyPort: HardwareKeyPort = {
  async scheme(userId) {
    return tauriInvoke<AtRestKeyScheme>('cle_au_repos_schema', { userId });
  },
  async prepare(userId, deviceId) {
    const key = await tauriInvoke<string>('cle_au_repos_preparer', { userId, deviceId });
    noteHardwareHeldDeviceKey(key);
    return key;
  },
  async mark(userId, deviceKeyB64) {
    await tauriInvoke<void>('cle_au_repos_marquer', { userId, deviceKeyB64 });
  },
  async read(userId) {
    const answer = await tauriInvoke<{ status: string; keyB64: string | null }>(
      'cle_au_repos_lire',
      { userId }
    );
    if (answer.status === 'key' && answer.keyB64) {
      noteHardwareHeldDeviceKey(answer.keyB64);
      return { key: answer.keyB64 };
    }
    return { refusal: asRefusal(answer.status) };
  },
  async forget(userId) {
    await tauriInvoke<void>('cle_au_repos_oublier', { userId });
  },
};

function asRefusal(status: string): HardwareKeyRefusal {
  if (status === 'not-hardware' || status === 'absent' || status === 'mismatch') return status;
  // `unreadable`, and anything a later native build adds: not a key, and never guessed into one.
  return 'unreadable';
}

/**
 * Reads the hardware-held key, or throws {@link HardwareKeyUnavailableError}.
 *
 * Called by the PIN unlock only once the scheme says `hardware`; the PIN check decides whether what
 * this returns is installed (`unlockWithPin`).
 */
export async function readHardwareHeldKey(
  port: HardwareKeyPort,
  userId: string,
  log: (msg: string) => void
): Promise<string> {
  const read = await port.read(userId);
  if ('key' in read) {
    log('[AT_REST_KEY] hardware-held key read from the keystore');
    return read.key;
  }
  log(`[AT_REST_KEY] ERROR: the hardware-held key is unavailable (${read.refusal})`);
  throw new HardwareKeyUnavailableError(read.refusal);
}

/**
 * The keys this page knows to be hardware-held. A key read from, or generated for, the keystore is
 * noted here, and the device-key vault refuses to copy a noted key into WebView storage
 * (`saveDeviceKey`): a vault is a file beside its wrap key, and a copy there would undo what holding
 * the key in hardware buys against a copy of the app's files.
 */
const hardwareHeldKeys = new Set<string>();

/** Notes `deviceKeyB64` as hardware-held for this page's life. */
export function noteHardwareHeldDeviceKey(deviceKeyB64: string): void {
  hardwareHeldKeys.add(deviceKeyB64);
}

/** Whether `deviceKeyB64` was noted as hardware-held - see {@link noteHardwareHeldDeviceKey}. */
export function isHardwareHeldDeviceKey(deviceKeyB64: string): boolean {
  return hardwareHeldKeys.has(deviceKeyB64);
}

/** Test seam: forgets every noted key. */
export function forgetHardwareHeldKeysForTest(): void {
  hardwareHeldKeys.clear();
}
