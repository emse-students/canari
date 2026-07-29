import {
  authenticate,
  type AuthOptions,
  BiometryType,
  checkStatus,
  type Status,
} from '@tauri-apps/plugin-biometric';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/openExternal';
import { m } from '$lib/paraglide/messages';
import { keystoreCommand } from './keystoreCommands';

/**
 * Flag persisted in localStorage (and mirrored to Tauri native store) that
 * indicates the user opted into biometric unlock.  The actual device key is
 * stored in the platform keystore during the normal PIN login flow
 * (`store_push_context` → `storeKeyBytes`) — no separate keystore write is
 * needed at enrollment time.
 */
const CONFIG_FLAG_KEY = 'canari_biometric_configured';
const NATIVE_FLAG_KEY = 'biometricConfigured';

/**
 * Result of a biometric enrollment attempt.
 *
 * - `enrolled: true` means biometric unlock was enabled successfully.
 * - `enrolled: false, noBiometric: true` means the device has biometric
 *   hardware but no fingerprint / Face ID is enrolled in the OS settings.
 */
export type BiometricEnrollResult = { enrolled: true } | { enrolled: false; noBiometric: true };

/**
 * Localized chrome for the system biometric prompt.
 *
 * Neither string has a localized default: `tauri-plugin-biometric` falls back to the English
 * `biometryNameMap` entry ("Fingerprint Authentication") when no `title` is passed, and to a
 * literal "Cancel" for the negative button. Both are OS-level UI, so an untranslated value is
 * visible to the user however well the surrounding sheet is localized.
 *
 * `title` and `subtitle` are Android-only (iOS shows `reason` alone); `cancelTitle` maps to
 * `localizedCancelTitle` there, so passing it is worthwhile on both platforms.
 */
function biometricPromptOptions(): AuthOptions {
  return {
    subtitle: m.auth_biometric_desc(),
    cancelTitle: m.common_cancel_button(),
  };
}

/** Localized text for the biometric sheet the keystore plugin raises when it reads the device key. */
export interface KeystorePromptText {
  title: string;
  subtitle: string;
  cancelTitle: string;
  reason: string;
}

/**
 * Text for the unlock sheet raised by the KEYSTORE plugin, not the biometric one.
 *
 * Two different plugins own two different prompts. This one appears when `initialiser_mls` runs in
 * biometric mode and the native side reads `mls_device_key_{userId}_{deviceId}` back, so its
 * strings have to travel down the IPC chain: the plugin executes in a native process that has no
 * access to this catalogue and no way to know the active locale. Omitting a field is not neutral -
 * the native side then falls back to its own French literal.
 *
 * `title`/`subtitle` are consumed by Android's `BiometricPrompt`, `reason` by iOS `LAContext`;
 * `cancelTitle` is used by both.
 */
export function keystoreUnlockPrompt(): KeystorePromptText {
  return {
    title: m.auth_keystore_prompt_unlock_title(),
    subtitle: m.auth_biometric_desc(),
    cancelTitle: m.common_cancel_button(),
    reason: m.auth_keystore_prompt_unlock_reason(),
  };
}

export class BiometricService {
  /**
   * Marks biometric unlock as configured.  The device key is already stored in
   * the platform keystore by `store_push_context` during the PIN login flow —
   * no additional keystore write is performed here.
   *
   * @returns A {@link BiometricEnrollResult} describing the outcome.
   */
  static async enableBiometric(): Promise<BiometricEnrollResult> {
    try {
      const status: Status = await checkStatus();
      if (!status.isAvailable || status.biometryType === BiometryType.None) {
        return { enrolled: false, noBiometric: true };
      }

      // Verify the fingerprint / face BEFORE writing the flags. On Android this raises a
      // BiometricPrompt; on iOS it raises Face ID / Touch ID via LAContext.evaluatePolicy().
      // If the user cancels or fails, the promise rejects and the catch below handles it.
      await authenticate(m.auth_biometric_prompt_enable(), {
        ...biometricPromptOptions(),
        title: m.auth_biometric_prompt_enable_title(),
      });

      localStorage.setItem(CONFIG_FLAG_KEY, 'true');
      if (isTauri()) {
        await invoke('set_native_flag', { key: NATIVE_FLAG_KEY, value: true }).catch(() => {});
      }
      return { enrolled: true };
    } catch (e) {
      const errorMsg = String(e);
      if (errorMsg.includes('At least one biometric must be enrolled')) {
        console.warn(
          'Hardware biometric present, but no fingerprint or Face ID is enrolled on this device.'
        );
        return { enrolled: false, noBiometric: true };
      }
      console.error('Failed to enable biometrics:', e);
      throw e;
    }
  }

  /**
   * Returns `true` when the user previously opted into biometric unlock.
   *
   * Does NOT verify that a key actually exists in the keystore — use
   * {@link isKeyPresent} for that check (e.g. to decide whether to show
   * the biometric button on the PIN modal).
   */
  static async isConfigured(): Promise<boolean> {
    if (localStorage.getItem(CONFIG_FLAG_KEY) === 'true') return true;
    if (isTauri()) {
      try {
        const flags = await invoke<Record<string, boolean>>('get_native_flags');
        if (flags[NATIVE_FLAG_KEY]) {
          localStorage.setItem(CONFIG_FLAG_KEY, 'true');
          return true;
        }
      } catch {
        /* native storage unavailable */
      }
    }
    return false;
  }

  /**
   * Returns `true` when the device has biometric hardware AND the user has
   * at least one fingerprint / face enrolled in the OS settings.
   */
  static async isAvailable(): Promise<boolean> {
    const isMobile = isTauriRuntime();
    if (!isMobile) return false;
    const status: Status = await checkStatus();
    return status.isAvailable && status.biometryType !== BiometryType.None;
  }

  /**
   * Lightweight check: does cipher data exist for the given alias?
   *
   * Never triggers a biometric prompt — Android reads SharedPreferences only, iOS matches
   * keychain attributes without decrypting. Safe to call before showing the biometric button,
   * and it gates whether the unlock flow offers biometrics at all: a false answer sends the
   * user to the PIN modal, so a broken call here silently disables the fingerprint.
   */
  static async isKeyPresent(alias: string): Promise<boolean> {
    if (!alias || !isTauri()) return false;
    try {
      const result = await invoke<{ present: boolean }>(keystoreCommand('hasKeyBytes'), {
        payload: { alias },
      });
      return result.present === true;
    } catch (e) {
      // Logged rather than swallowed: this failure used to be indistinguishable from a genuine
      // "no key here", which is how a wrong command name went unnoticed for three releases.
      console.warn('[BIOMETRIC] isKeyPresent failed - treating the key as absent:', e);
      return false;
    }
  }

  /**
   * Turns biometric unlock off.  Clears the "configured" flag and deletes the
   * device key from the platform keystore.  The next PIN login re-derives the
   * key and `store_push_context` puts it back automatically.
   */
  static async disable(alias?: string): Promise<void> {
    // Require a biometric authentication before deleting the keystore key. If the user cancels the
    // prompt, authenticate() throws and the disable does not happen — key and flags stay intact.
    await authenticate(m.auth_biometric_prompt_disable(), {
      ...biometricPromptOptions(),
      title: m.auth_biometric_prompt_disable_title(),
    });
    if (alias && isTauri()) {
      await invoke(keystoreCommand('deleteKeyBytes'), { payload: { alias } }).catch((e) => {
        console.warn('[BIOMETRIC] deleteKeyBytes failed - keystore entry may survive:', e);
      });
    }
    localStorage.removeItem(CONFIG_FLAG_KEY);
    if (isTauri()) {
      await invoke('set_native_flag', { key: NATIVE_FLAG_KEY, value: false }).catch(() => {});
    }
  }
}
