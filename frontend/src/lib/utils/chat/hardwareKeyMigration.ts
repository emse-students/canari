/**
 * Moving a phone from the PIN-derived at-rest key to a hardware-held random key (2026-10-22).
 *
 * WHY A RE-KEY AND NOT A RE-WRAP. Wrapping the existing key in the keystore would leave every store
 * sealed under a key that is still a function of the PIN and the server's salt: whoever holds the
 * server's data could still grind the PIN and open a copy of the phone's files. Only a key that was
 * never derived from anything closes that, so the existing stores are RE-SEALED under a new random
 * key - by the same resumable machinery a PIN change uses ({@link performPinChange}), whose order
 * already guarantees that a kill anywhere leaves a state the next unlock can finish.
 *
 * THE STEPS, each durable before the next:
 *  1. `prepare` generates the random key, writes the marker `migrating` (with the key's check value),
 *     and returns the key - or returns the SAME key when a migration was interrupted after the key
 *     reached the keystore (rows may already sit under it).
 *  2. `performPinChange(old, new)`: vault cleared, keystore pointed at the new key, every sealed
 *     store moved (rows already under the new key count as done), the session adopts it, the MLS
 *     state is re-sealed LAST.
 *  3. `mark`: marker `hardware`. From then on the PIN unlock reads the key from the keystore.
 *
 * A kill between 2 and 3 leaves the marker `migrating` with the MLS state under the new key; a kill
 * inside 2 leaves it under the old one. The next PIN unlock settles which BEFORE it opens anything
 * ({@link settleMigratingStateAtUnlock}): the marker says the state is under one of two known keys,
 * and the new key is tried first because the MLS state moves last.
 */
import { endIntoKeyRecovery } from '$lib/db/deviceKeyGate';
import type { LocalStateOpenResult } from '$lib/mls-client';
import type { HardwareKeyPort } from '$lib/crypto/hardwareHeldKey';
import { KeyChangeInterruptedError } from './pinChange';

/** What {@link migrateToHardwareHeldKey} did. */
export type HardwareKeyMigrationOutcome =
  /** The marker already said `hardware`: nothing to do. */
  | 'already-hardware'
  /** Every store moved and the marker says `hardware`. */
  | 'migrated'
  /** The session already ran on the hardware-held key; only the marker was missing. */
  | 'marked'
  /** The marker cannot be read: nothing was started, and the error log says so. */
  | 'refused';

/** What the migration needs, passed in so its order can be tested without a phone. */
export interface HardwareKeyMigrationDeps {
  userId: string;
  deviceId: string;
  /** The key this session's stores are sealed under now (the PIN-derived one). */
  currentKeyB64: string;
  port: HardwareKeyPort;
  /** `performPinChange` from `currentKeyB64` to the new key, on the live client. */
  changeKey: (oldKeyB64: string, newKeyB64: string) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Re-keys this phone's at-rest data under a hardware-held random key. Idempotent: a second call
 * after success answers `already-hardware`; a call after an interruption resumes with the same key.
 *
 * An interruption that moved data (stage `stores` or `mls`) ends the session into a reload, exactly
 * like an interrupted PIN change: the session must not run on with rows under two keys. The reload's
 * PIN unlock finds the marker `migrating` and settles it ({@link settleMigratingStateAtUnlock}).
 *
 * @throws whatever `changeKey` threw, after the reload was asked for when data moved.
 */
export async function migrateToHardwareHeldKey(
  deps: HardwareKeyMigrationDeps
): Promise<HardwareKeyMigrationOutcome> {
  const { userId, deviceId, currentKeyB64, port, log } = deps;
  const scheme = await port.scheme(userId);
  log(`[AT_REST_KEY] migration asked (scheme=${scheme})`);
  if (scheme === 'hardware') return 'already-hardware';
  if (scheme === 'unreadable') {
    log('[AT_REST_KEY] ERROR: the at-rest marker is unreadable - no re-key started');
    return 'refused';
  }

  const newKeyB64 = await port.prepare(userId, deviceId);
  if (newKeyB64 === currentKeyB64) {
    // An earlier run moved everything (the MLS state last) and was killed before the marker.
    await port.mark(userId, newKeyB64);
    log('[AT_REST_KEY] the session already runs on the hardware-held key - marker completed');
    return 'marked';
  }

  try {
    await deps.changeKey(currentKeyB64, newKeyB64);
  } catch (e) {
    if (e instanceof KeyChangeInterruptedError && e.dataMoved) {
      log(`[AT_REST_KEY] ERROR: re-key interrupted at the ${e.stage} step - the session restarts`);
      endIntoKeyRecovery('the move to a hardware-held key was interrupted');
    } else {
      log(`[AT_REST_KEY] ERROR: re-key did not start or moved nothing: ${String(e)}`);
    }
    throw e;
  }
  await port.mark(userId, newKeyB64);
  log('[AT_REST_KEY] every store re-sealed under the hardware-held key');
  return 'migrated';
}

/** What {@link settleMigratingStateAtUnlock} needs. */
export interface SettleMigratingDeps {
  userId: string;
  deviceId: string;
  /** The key the PIN derives - what the stores were under before the re-key started. */
  pinDerivedKeyB64: string;
  port: HardwareKeyPort;
  /**
   * Opens the stored MLS state with a candidate key WITHOUT destroying anything on a refusal
   * (`IMlsService.openLocalStateWithKey`), or answers `no-state` when nothing is stored.
   */
  openStoredStateWith: (keyB64: string) => Promise<LocalStateOpenResult | 'no-state'>;
  log: (msg: string) => void;
}

/**
 * The key a PIN unlock must use on a phone whose marker says `migrating`, decided BEFORE anything is
 * opened for the session. Called only after the server accepted the PIN.
 *
 * - The keystore holds the key the marker names, and it OPENS the stored state: the MLS state moved
 *   (it moves last, so every store did too). The marker is completed and that key is the session's.
 * - Otherwise the state is still under the PIN-derived key: the session runs on it, and the
 *   migration started after the login resumes the re-key with the same new key.
 *
 * A refusal of the new key is the expected half of a two-key state, not an error: the marker is the
 * fact that the state is under one of exactly these two keys.
 */
export async function settleMigratingStateAtUnlock(
  deps: SettleMigratingDeps
): Promise<{ keyB64: string; migrationComplete: boolean }> {
  const { userId, deviceId, pinDerivedKeyB64, port, log } = deps;
  const read = await port.read(userId, deviceId);
  if (!('key' in read)) {
    log(
      `[AT_REST_KEY] migrating, the new key never reached the keystore (${read.refusal}) - the PIN-derived key`
    );
    return { keyB64: pinDerivedKeyB64, migrationComplete: false };
  }
  const opened = await deps.openStoredStateWith(read.key);
  if (opened !== 'no-state' && opened.opened) {
    await port.mark(userId, read.key);
    log('[AT_REST_KEY] migrating, and the state is already under the new key - marker completed');
    return { keyB64: read.key, migrationComplete: true };
  }
  log(
    `[AT_REST_KEY] migrating, the state is still under the PIN-derived key (${
      opened === 'no-state' ? 'no state' : opened.cause
    }) - the re-key resumes after the login`
  );
  return { keyB64: pinDerivedKeyB64, migrationComplete: false };
}

/** The one migration in flight in this page, so a PIN change can wait for it. */
let inFlight: Promise<HardwareKeyMigrationOutcome> | null = null;

/**
 * Starts {@link migrateToHardwareHeldKey} unless one is already running here, and returns it. Never
 * rejects: a failure is logged, and the next unlock resumes it.
 */
export function startHardwareKeyMigration(
  deps: HardwareKeyMigrationDeps
): Promise<HardwareKeyMigrationOutcome | 'failed'> {
  if (!inFlight) {
    inFlight = migrateToHardwareHeldKey(deps).finally(() => {
      inFlight = null;
    });
  }
  return inFlight.catch((e: unknown) => {
    deps.log(`[AT_REST_KEY] migration failed - resumed at the next unlock: ${String(e)}`);
    return 'failed' as const;
  });
}

/** Settles once no migration is running in this page. Never rejects. */
export async function whenHardwareKeyMigrationSettled(): Promise<void> {
  if (inFlight) await inFlight.catch(() => {});
}
