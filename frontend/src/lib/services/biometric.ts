import { authenticate, BiometryType, checkStatus, type Status } from '@tauri-apps/plugin-biometric';
import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * Flag persisted in localStorage (and mirrored to Tauri native store) that
 * indicates the user opted into biometric unlock.  The actual MLS-derived key
 * is stored in the platform keystore during the normal PIN login flow
 * (`derive_and_store_device_key` → `storeKeyBytes`) — no separate keystore
 * write is needed at enrollment time.
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

export class BiometricService {
  /**
   * Marks biometric unlock as configured.  The derived MLS key is already
   * stored in the platform keystore by `derive_and_store_device_key` during
   * the PIN login flow — no additional keystore write is performed here.
   *
   * @returns A {@link BiometricEnrollResult} describing the outcome.
   */
  static async enableBiometric(): Promise<BiometricEnrollResult> {
    try {
      const status: Status = await checkStatus();
      if (!status.isAvailable || status.biometryType === BiometryType.None) {
        return { enrolled: false, noBiometric: true };
      }

      // Vérifie l'empreinte digitale / reconnaissance faciale AVANT d'enregistrer
      // les flags. Sur Android, cela déclenche un BiometricPrompt ; sur iOS,
      // cela déclenche Face ID / Touch ID via LAContext.evaluatePolicy().
      // Si l'utilisateur annule ou échoue, la promesse est rejetée et le catch
      // ci-dessous traite l'erreur.
      await authenticate('Activez le déverrouillage biométrique pour Canari');

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
    const isMobile =
      typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!isMobile) return false;
    const status: Status = await checkStatus();
    return status.isAvailable && status.biometryType !== BiometryType.None;
  }

  /**
   * Lightweight check: does cipher data exist for the given alias?
   *
   * Reads SharedPreferences only — no Android Keystore access, no
   * BiometricPrompt.  Safe to call before showing the biometric button.
   */
  static async isKeyPresent(alias: string): Promise<boolean> {
    if (!alias || !isTauri()) return false;
    try {
      const result = await invoke<{ present: boolean }>('plugin:app.tauri.keystore|hasKeyBytes', {
        alias,
      });
      return result.present === true;
    } catch {
      return false;
    }
  }

  /**
   * Turns biometric unlock off.  Clears the "configured" flag and deletes
   * the derived MLS key from the platform keystore.  The next PIN login will
   * call `derive_and_store_device_key` and restore the key automatically.
   */
  static async disable(alias?: string): Promise<void> {
    // Exige une authentification biométrique avant de supprimer la clé keystore.
    // Si l'utilisateur annule le prompt biométrique, authenticate() lève une
    // exception et la désactivation n'a pas lieu — la clé et les flags restent
    // intacts.
    await authenticate('Désactiver le déverrouillage biométrique');
    if (alias && isTauri()) {
      await invoke('plugin:app.tauri.keystore|deleteKeyBytes', { alias }).catch(() => {});
    }
    localStorage.removeItem(CONFIG_FLAG_KEY);
    if (isTauri()) {
      await invoke('set_native_flag', { key: NATIVE_FLAG_KEY, value: false }).catch(() => {});
    }
  }
}
