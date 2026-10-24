/**
 * Biometric functions extracted from useChatSession:
 * isBiometricPromptDismissed, dismissBiometricPromptImpl, enrollBiometricImpl.
 */
import { BiometricService } from '$lib/services/biometric';
import {
  clearDeviceKeyAndWrapKey,
  saveDeviceKey,
  setDeviceKeyPersistence,
} from '$lib/utils/deviceKeyVault';
import { appendLog } from '$lib/utils/sessionLog';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { showToast } from '$lib/stores/toast.svelte';
import { biometricPrompt } from '$lib/stores/biometricPrompt.svelte';
import { m } from '$lib/paraglide/messages';
import type { SessionContext } from './sessionTypes';

const BIOMETRIC_DISMISSED_KEY = 'canari_biometric_prompt_dismissed';

/**
 * Returns true if the user has permanently dismissed the biometric enrolment prompt.
 *
 * Primary source: `localStorage` (fast, synchronous).
 * Fallback on Tauri: native flag via `invoke('get_native_flag')`, used when
 * `localStorage` was purged after an Android process kill. Writing both stores
 * in `dismissBiometricPromptImpl` ensures the flag survives such resets.
 */
export async function isBiometricPromptDismissed(): Promise<boolean> {
  if (localStorage.getItem(BIOMETRIC_DISMISSED_KEY) === 'true') return true;
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const nativeVal = await invoke<boolean | null>('get_native_flag', {
        key: 'biometricPromptDismissed',
      });
      if (nativeVal === true) {
        // Restore localStorage so subsequent (sync) reads are instant.
        localStorage.setItem(BIOMETRIC_DISMISSED_KEY, 'true');
        return true;
      }
    } catch {
      /* native flag unavailable - treat as not dismissed */
    }
  }
  return false;
}

/**
 * Hides the biometric enrolment banner and persists a "dismissed" flag both in
 * localStorage and in the Tauri native store (if running on Tauri).
 */
export async function dismissBiometricPromptImpl(): Promise<void> {
  localStorage.setItem(BIOMETRIC_DISMISSED_KEY, 'true');
  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_native_flag', { key: 'biometricPromptDismissed', value: true }).catch(
      () => {}
    );
  }
}

/**
 * Enables biometric unlock.  The device key is already in the platform keystore, stored by
 * `store_push_context` during PIN login — no additional keystore write is needed.  We just
 * mark the flag and clear the session device key so future logins go through the biometric
 * path (`retrieve_device_key` behind a single BiometricPrompt).
 */
export async function enrollBiometricImpl(): Promise<void> {
  appendLog('[BIOMETRIC] Biometric enrollment in progress…');
  try {
    // Raise the in-app sheet alongside the OS prompt, from here rather than from each caller,
    // so the post-login offer and the Settings toggle behave identically.
    biometricPrompt.openEnroll();
    let result: Awaited<ReturnType<typeof BiometricService.enableBiometric>>;
    try {
      result = await BiometricService.enableBiometric();
    } finally {
      biometricPrompt.close();
    }
    if (!result.enrolled) {
      appendLog('[BIOMETRIC] No biometric enrolled on device — falling back to PIN.');
      showToast(m.auth_biometric_no_biometric_enrolled(), 'info');
      return;
    }
    // Biometric is now enabled — wipe the session device key so the next launch
    // uses the keystore path (getKeyBytes → BiometricPrompt).
    clearDeviceKeyAndWrapKey();
    // Also clear the "stay signed in" persistence flag so the device key is
    // not re-saved on the next login (the keystore holds the key).
    try {
      await setDeviceKeyPersistence(false, null);
    } catch {}
    // The keystore copy of the device key is deliberately left alone: enrolling changes the
    // unlock method (fingerprint instead of PIN), never where the background copy lives. It
    // must stay readable or background FCM decryption breaks.
    localStorage.removeItem(BIOMETRIC_DISMISSED_KEY);
    appendLog('[BIOMETRIC] Enrollment OK - device key cleared from session (hardware keystore)');
  } catch (e) {
    appendLog(`[BIOMETRIC] Enrollment failed: ${String(e)}`);
    console.error('Biometric enrollment failed:', e);
  }
}

/**
 * Turns biometric unlock off (Settings toggle): confirms the owner, clears the configured flags,
 * re-seeds the session device key vault, and re-arms the enrolment banner.
 *
 * THE KEYSTORE ENTRY IS LEFT AS IT IS (2026-10-22). It used to be deleted, then re-stored from the
 * session key with every failure swallowed - and on a phone whose at-rest key is hardware-held that
 * entry is the only copy of the key, so a kill between the two lost every local message. The entry
 * is what the background push reads with or without biometrics, so nothing needs re-seeding: with
 * the flags cleared the next launch asks for the PIN, and the entry keeps serving the push.
 */
export async function disableBiometricImpl(ctx: SessionContext): Promise<void> {
  appendLog('[BIOMETRIC] Disabling biometric unlock…');
  await BiometricService.disable();

  const userId = ctx.getUserId();
  const deviceKeyB64 = ctx.getDeviceKey();
  if (deviceKeyB64 && userId) {
    // A hardware-held key is never vaulted (`saveDeviceKey` refuses it): that phone asks for the
    // PIN, or reads the keystore when "stay signed in" is on.
    await saveDeviceKey(userId, deviceKeyB64).catch((e: unknown) =>
      appendLog(`[BIOMETRIC] Re-seeding the device key vault failed: ${String(e)}`)
    );
  }
  localStorage.removeItem(BIOMETRIC_DISMISSED_KEY);
  appendLog('[BIOMETRIC] Biometric unlock disabled - PIN restored to session vault.');
}
