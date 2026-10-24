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
 * inside 2 leaves rows under both keys. The next PIN unlock FINISHES the re-key before any session
 * opens a store ({@link finishMigrationAtUnlock}), so no session runs over a two-key store. A marker
 * `migrating` whose key never reached the keystore is reverted natively (`settle_scheme`): nothing
 * moved, because rows move only after the key was written and read back.
 */
import { endIntoKeyRecovery } from '$lib/db/deviceKeyGate';
import type { LocalStateOpenResult } from '$lib/mls-client';
import {
  HardwareKeyUnavailableError,
  type AtRestKeyScheme,
  type HardwareKeyPort,
} from '$lib/crypto/hardwareHeldKey';
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
  /** Whether this install held conversations BEFORE the re-key - asked before anything moves. */
  hadLocalData: () => Promise<boolean>;
  /**
   * Told once a re-key of an install that held data completed: the backups it made under the
   * PIN-derived key no longer open here (decision 4 of 2026-10-22), so a new one is asked for.
   */
  onBackupsSuperseded: () => void;
  log: (msg: string) => void;
}

/**
 * Re-keys this phone's at-rest data under a hardware-held random key. Idempotent: a second call
 * after success answers `already-hardware`; a call after an interruption resumes with the same key.
 *
 * An interruption that moved data (stage `stores` or `mls`) ends the session into a reload, exactly
 * like an interrupted PIN change: the session must not run on with rows under two keys. The reload's
 * PIN unlock finds the marker `migrating` and finishes it ({@link finishMigrationAtUnlock}).
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
  const hadData = await deps.hadLocalData();
  if (newKeyB64 === currentKeyB64) {
    // An earlier run moved everything (the MLS state last) and was killed before the marker.
    await port.mark(userId, newKeyB64);
    log('[AT_REST_KEY] the session already runs on the hardware-held key - marker completed');
    supersedeBackupsIf(hadData, deps);
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
  supersedeBackupsIf(hadData, deps);
  return 'migrated';
}

/**
 * Tells the surface that earlier backups no longer open here - only for an install that HELD data:
 * a fresh install takes the same re-key path and has no earlier backup to supersede.
 */
function supersedeBackupsIf(
  hadData: boolean,
  deps: Pick<HardwareKeyMigrationDeps, 'onBackupsSuperseded' | 'log'>
): void {
  if (!hadData) return;
  deps.log('[AT_REST_KEY] the install held data - a new backup is asked for');
  deps.onBackupsSuperseded();
}

/** What {@link finishMigrationAtUnlock} needs - the stores and the MLS state, passed in. */
export interface FinishMigrationDeps {
  userId: string;
  /** The key the PIN derives - what every store was under before the re-key started. */
  pinDerivedKeyB64: string;
  port: HardwareKeyPort;
  /** The stored MLS state, or `null` when nothing is stored. */
  loadStoredState: () => Promise<Uint8Array | null>;
  /** Opens the stored state with a candidate key, destroying nothing on a refusal. */
  openStoredStateWith: (keyB64: string, state: Uint8Array) => Promise<LocalStateOpenResult>;
  /**
   * `performPinChange(old, new)` from the STORED state (the recovery's path): proves `old` opens it,
   * moves every store (rows already under `new` count as done), then re-seals the state.
   */
  completeReKey: (oldKeyB64: string, newKeyB64: string, state: Uint8Array) => Promise<void>;
  /** Moves the sealed stores alone, for an install with no MLS state to carry. */
  resealStoresOnly: (oldKeyB64: string, newKeyB64: string) => Promise<void>;
  /** As {@link HardwareKeyMigrationDeps.hadLocalData}. */
  hadLocalData: () => Promise<boolean>;
  /** As {@link HardwareKeyMigrationDeps.onBackupsSuperseded}. */
  onBackupsSuperseded: () => void;
  log: (msg: string) => void;
}

/**
 * Finishes an interrupted re-key at the PIN unlock, BEFORE any session opens a store, and returns
 * the hardware-held key the session runs on. Called only after the server accepted the PIN, and only
 * when the marker still says `migrating` once `cle_au_repos_schema` settled it - which proves the
 * keystore holds the key the marker names (a migrating marker without it is reverted natively).
 *
 * WHY HERE AND NOT AFTER THE LOGIN: a kill in the store pass leaves rows under two keys, and a
 * session started on either one reads half of them as damaged. Finishing first means no session
 * ever runs over a two-key store - the rule an interrupted PIN change already follows.
 *
 * - The new key opens the stored state: it moved last, so every store did too - marker completed.
 * - No stored state: the stores alone move.
 * - Otherwise the state is still under the PIN-derived key: the re-key runs to the end now, from
 *   the stored state, exactly as the PIN recovery does.
 *
 * @throws {HardwareKeyUnavailableError} when the keystore will not hand the key back now.
 * @throws whatever the re-key threw; an interruption that moved data first asks for the reload, so
 *         nothing keeps running on a client opened under the old key.
 */
export async function finishMigrationAtUnlock(deps: FinishMigrationDeps): Promise<string> {
  const { userId, pinDerivedKeyB64, port, log } = deps;
  const read = await port.read(userId);
  if (!('key' in read)) {
    log(`[AT_REST_KEY] ERROR: migrating, and the keystore refused the new key (${read.refusal})`);
    throw new HardwareKeyUnavailableError(read.refusal);
  }
  const newKeyB64 = read.key;
  const hadData = await deps.hadLocalData();
  const state = await deps.loadStoredState();
  if (!state) {
    log('[AT_REST_KEY] migrating, no stored state - moving the stores alone before the session');
    await deps.resealStoresOnly(pinDerivedKeyB64, newKeyB64);
  } else if ((await deps.openStoredStateWith(newKeyB64, state)).opened) {
    log('[AT_REST_KEY] migrating, and the state is already under the new key - marker completed');
  } else {
    log(
      '[AT_REST_KEY] migrating, the state is under the PIN-derived key - finishing the re-key now'
    );
    try {
      await deps.completeReKey(pinDerivedKeyB64, newKeyB64, state);
    } catch (e) {
      if (e instanceof KeyChangeInterruptedError && e.dataMoved) {
        log(`[AT_REST_KEY] ERROR: the re-key stopped at the ${e.stage} step - the page restarts`);
        endIntoKeyRecovery('finishing the move to a hardware-held key was interrupted');
      } else {
        log(`[AT_REST_KEY] ERROR: finishing the re-key failed: ${String(e)}`);
      }
      throw e;
    }
  }
  await port.mark(userId, newKeyB64);
  supersedeBackupsIf(hadData, deps);
  return newKeyB64;
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

/**
 * The at-rest scheme of `userId`, read only once no re-key is running in this page - THE ONE WAY a
 * login, a PIN change or a recovery reads it. The native side settles the marker under the same lock
 * the re-key's own writes take (`at_rest_key.rs`); this half keeps a page from acting on a scheme
 * its own migration is about to change. The migration itself reads `port.scheme` directly: waiting
 * here would wait on itself.
 */
export async function settledAtRestScheme(
  port: Pick<HardwareKeyPort, 'scheme'>,
  userId: string
): Promise<AtRestKeyScheme> {
  await whenHardwareKeyMigrationSettled();
  return port.scheme(userId);
}
