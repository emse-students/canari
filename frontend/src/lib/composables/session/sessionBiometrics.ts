/**
 * Fonctions biométriques extraites de useChatSession :
 * isBiometricPromptDismissed, dismissBiometricPromptImpl, enrollBiometricImpl.
 */
import { BiometricService } from '$lib/services/biometric';
import { clearPinAndKey } from '$lib/utils/pinVault';
import { appendLog } from '$lib/stores/globalChatSingleton.svelte';
import { isTauriRuntime } from '$lib/utils/openExternal';
import type { SessionContext } from './sessionTypes';

const BIOMETRIC_DISMISSED_KEY = 'canari_biometric_prompt_dismissed';

/**
 * Returns true if the user has permanently dismissed the biometric enrolment prompt.
 * Reads a localStorage flag set by dismissBiometricPromptImpl.
 */
export function isBiometricPromptDismissed(): boolean {
  return localStorage.getItem(BIOMETRIC_DISMISSED_KEY) === 'true';
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
 * Stores the current PIN in the hardware biometric keystore, then clears the in-memory PIN
 * so future logins require biometric authentication.
 */
export async function enrollBiometricImpl(ctx: SessionContext): Promise<void> {
  appendLog('[BIOMETRIE] Inscription biométrique en cours...');
  try {
    await BiometricService.enableBiometric(ctx.getPin());
    // PIN is now protected by the hardware keystore - wipe the session cache
    clearPinAndKey();
    ctx.setShowBiometricEnrollPrompt(false);
    localStorage.removeItem(BIOMETRIC_DISMISSED_KEY);
    appendLog('[BIOMETRIE] Inscription OK - PIN effacé de la session (keystore matériel)');
  } catch (e) {
    appendLog(`[BIOMETRIE] Echec inscription: ${e instanceof Error ? e.message : String(e)}`);
    console.error('Biometric enrollment failed:', e);
  }
}
