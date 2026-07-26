/**
 * Biometric functions extracted from useChatSession:
 * isBiometricPromptDismissed, dismissBiometricPromptImpl, enrollBiometricImpl.
 */
import { BiometricService } from '$lib/services/biometric';
import { clearPinAndKey, savePin, setPinPersistence } from '$lib/utils/pinVault';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { showToast } from '$lib/stores/toast.svelte';
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
export async function dismissBiometricPromptImpl(ctx: SessionContext): Promise<void> {
  ctx.setShowBiometricEnrollPrompt(false);
  localStorage.setItem(BIOMETRIC_DISMISSED_KEY, 'true');
  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_native_flag', { key: 'biometricPromptDismissed', value: true }).catch(
      () => {}
    );
  }
}

/**
 * Enables biometric unlock.  The derived MLS key is already stored in the
 * platform keystore by `derive_and_store_device_key` during PIN login —
 * no additional keystore write is needed.  We just mark the flag and clear
 * the in-memory PIN so future logins go through the biometric path.
 */
export async function enrollBiometricImpl(ctx: SessionContext): Promise<void> {
  appendLog('[BIOMETRIC] Biometric enrollment in progress…');
  try {
    const result = await BiometricService.enableBiometric();
    if (!result.enrolled) {
      appendLog('[BIOMETRIC] No biometric enrolled on device — falling back to PIN.');
      showToast(m.auth_biometric_no_biometric_enrolled(), 'info');
      return;
    }
    // Biometric is now enabled — wipe the session PIN so the next launch
    // uses the keystore path (getKeyBytes → BiometricPrompt).
    clearPinAndKey();
    // Also clear the "stay signed in" persistence flag so the PIN is
    // not re-saved on the next login (the keystore holds the key).
    try {
      await setPinPersistence(false, null);
    } catch {}
    ctx.setShowBiometricEnrollPrompt(false);
    localStorage.removeItem(BIOMETRIC_DISMISSED_KEY);
    appendLog('[BIOMETRIC] Enrollment OK - PIN cleared from session (hardware keystore)');
  } catch (e) {
    appendLog(`[BIOMETRIE] Echec inscription: ${e instanceof Error ? e.message : String(e)}`);
    console.error('Biometric enrollment failed:', e);
  }
}

/**
 * Turns biometric unlock off (Settings toggle).  Deletes the derived MLS key
 * from the platform keystore and clears the configured flag.  Re-saves the
 * in-memory PIN into the session PIN vault so the next launch falls back to
 * the normal PIN path.  Re-arms the enrolment banner.
 */
export async function disableBiometricImpl(ctx: SessionContext): Promise<void> {
  appendLog('[BIOMETRIC] Disabling biometric unlock…');

  // Build the alias so we can delete the exact keystore entry.
  const userId = ctx.getUserId();
  const deviceId = ctx.getMyDeviceId();
  const alias = userId && deviceId ? `mls_device_key_${userId}_${deviceId}` : undefined;
  await BiometricService.disable(alias);

  const pin = ctx.getPin();
  if (pin) await savePin(pin).catch(() => {});
  localStorage.removeItem(BIOMETRIC_DISMISSED_KEY);
  appendLog('[BIOMETRIC] Biometric unlock disabled - PIN restored to session vault.');
}
