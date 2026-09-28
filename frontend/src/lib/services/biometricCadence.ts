import { invoke, isTauri } from '@tauri-apps/api/core';
import { appendLog } from '$lib/utils/sessionLog';

/**
 * How often the biometric sheet comes back once biometric unlock is enabled.
 *
 * - `every_launch`: every cold start raises the sheet. On iOS every read goes through the
 *   `.userPresence` Keychain item, so the Secure Enclave itself demands the proof.
 * - `every_12h`: the sheet is skipped while the last PROMPTED unlock is less than 12h old, and the
 *   key is read unattended. On Android this changes nothing that is protected (the key was never
 *   auth-bound, background push needs it). On iOS it reads the background item, which has no access
 *   control: Apple caps reuse of a biometric proof at 5 minutes, so no hardware-enforced 12h exists.
 *   Chosen knowingly by the user as the default - see docs/wiki/frontend/modules/auth.md.
 */
export type BiometricCadence = 'every_launch' | 'every_12h';

/** Window during which a prompted unlock lets the next launches skip the sheet. */
export const BIOMETRIC_REPROMPT_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * `every_launch` is the flag that is STORED; `every_12h` is its absence. That makes the default a
 * fact about an empty store, so every existing install lands on it with no migration step.
 * Mirrored natively because `localStorage` does not survive what some OEMs clear.
 */
const EVERY_LAUNCH_KEY = 'canari_biometric_every_launch';
const EVERY_LAUNCH_NATIVE_FLAG = 'biometricPromptEveryLaunch';

/**
 * Epoch ms of the last unlock that RAISED the sheet and succeeded. `localStorage` only - the native
 * store holds booleans - and losing it costs one extra prompt, never a skipped one.
 */
const LAST_PROMPTED_UNLOCK_KEY = 'canari_biometric_last_prompted_unlock_at';

/**
 * Pure decision: must this launch raise the biometric sheet?
 *
 * A clock that went BACKWARDS (negative elapsed time) counts as due: only a proof in the past may
 * open the window, and setting the device clock back must not stretch it.
 */
export function isPromptDueAt(
  cadence: BiometricCadence,
  lastPromptedUnlockAt: number | null,
  now: number
): boolean {
  if (cadence === 'every_launch' || lastPromptedUnlockAt === null) return true;
  const elapsed = now - lastPromptedUnlockAt;
  return elapsed < 0 || elapsed >= BIOMETRIC_REPROMPT_INTERVAL_MS;
}

/** Reads the cadence this device uses; `every_12h` when the user never changed it. */
export async function getBiometricCadence(): Promise<BiometricCadence> {
  if (localStorage.getItem(EVERY_LAUNCH_KEY) === 'true') return 'every_launch';
  if (isTauri()) {
    try {
      const flags = await invoke<Record<string, boolean>>('get_native_flags');
      if (flags[EVERY_LAUNCH_NATIVE_FLAG]) {
        localStorage.setItem(EVERY_LAUNCH_KEY, 'true');
        return 'every_launch';
      }
    } catch (e) {
      appendLog(`[BIOMETRIC] Cadence: native flags unreadable, using the default - ${String(e)}`);
    }
  }
  return 'every_12h';
}

/** Persists the cadence in both stores. Per device: a phone and a laptop may differ. */
export async function setBiometricCadence(cadence: BiometricCadence): Promise<void> {
  appendLog(`[BIOMETRIC] Cadence set to ${cadence}`);
  if (cadence === 'every_launch') {
    localStorage.setItem(EVERY_LAUNCH_KEY, 'true');
    if (isTauri()) await invoke('set_native_flag', { key: EVERY_LAUNCH_NATIVE_FLAG, value: true });
    return;
  }
  localStorage.removeItem(EVERY_LAUNCH_KEY);
  if (isTauri()) await invoke('remove_native_flag', { key: EVERY_LAUNCH_NATIVE_FLAG });
}

/**
 * Records that the biometric sheet was raised AND passed. The only writer of the window's clock:
 * an unattended unlock must never call this, or the window would renew itself without a proof.
 */
export function recordPromptedBiometricUnlock(now: number = Date.now()): void {
  localStorage.setItem(LAST_PROMPTED_UNLOCK_KEY, String(now));
}

function readLastPromptedUnlock(): number | null {
  const raw = localStorage.getItem(LAST_PROMPTED_UNLOCK_KEY);
  if (raw === null) return null;
  const at = Number(raw);
  return Number.isFinite(at) ? at : null;
}

/** Whether this launch must raise the biometric sheet, from the cadence and the last proof. */
export async function isBiometricPromptDue(now: number = Date.now()): Promise<boolean> {
  const cadence = await getBiometricCadence();
  const last = readLastPromptedUnlock();
  const due = isPromptDueAt(cadence, last, now);
  appendLog(
    `[BIOMETRIC] Prompt ${due ? 'due' : 'skipped'} (cadence=${cadence}, ` +
      `lastPrompted=${last === null ? 'never' : `${Math.round((now - last) / 60000)} min ago`})`
  );
  return due;
}

/**
 * Drops the last proof, so the next biometric unlock prompts whatever the cadence. Called wherever
 * biometric unlock is forgotten: a re-enrolled key must be opened by a fresh proof, never by one
 * given for the key it replaced.
 *
 * The cadence itself is KEPT - it is a preference, and turning biometrics off and on must not reset
 * someone who chose `every_launch` to the default. A device wipe clears it with the rest of the app
 * data.
 */
export function forgetPromptedBiometricUnlock(): void {
  localStorage.removeItem(LAST_PROMPTED_UNLOCK_KEY);
}
