import {
  store as keystoreStore,
  retrieve as keystoreRetrieve,
  remove as keystoreRemove,
} from '@impierce/tauri-plugin-keystore';

import { BiometryType, checkStatus, type Status } from '@tauri-apps/plugin-biometric';
import { invoke, isTauri } from '@tauri-apps/api/core';

// Service/user are parsed but ignored by both native plugins internally (Android
// pins a hardcoded Keystore alias; iOS pins a hardcoded keychain service/account
// mirroring these exact values). They are kept here for forward compatibility.
const KEYSTORE_SERVICE = 'fr.emse.canari';
const KEYSTORE_USER = 'canari_biometric_user';
const CONFIG_FLAG_KEY = 'canari_biometric_configured';
const NATIVE_FLAG_KEY = 'biometricConfigured';

/**
 * Result of a biometric enrollment attempt.
 *
 * - `enrolled: true` means the secret was successfully stored behind
 *   hardware-backed biometric protection.
 * - `enrolled: false, noBiometric: true` means the device has biometric
 *   hardware but no fingerprint/Face ID is enrolled in the OS settings.
 *   The caller should inform the user and let them fall back to the PIN.
 */
export type BiometricEnrollResult = { enrolled: true } | { enrolled: false; noBiometric: true };

export class BiometricService {
  /**
   * Enrolls biometric protection for the given secret.
   * keystoreStore() enrolls the secret behind hardware-backed, user-presence
   * biometric protection: on Android a Keystore AES-GCM key (userAuthentication
   * Required = true, CryptoObject every-use) via the OS BiometricPrompt; on iOS a
   * keychain item with a `.userPresence` access control (Face ID / Touch ID). The
   * secret is never stored in plain text on disk on either platform.
   *
   * Note: tauri-plugin-keystore is alpha; its store() JS promise resolves
   * immediately while biometric auth completes asynchronously on-device.
   *
   * @returns A {@link BiometricEnrollResult} describing the outcome. When
   *          `enrolled` is `false` the caller should notify the user and let them
   *          continue with their PIN — biometric enrollment is a convenience, not
   *          a hard requirement.
   */
  static async enableBiometric(secret: string): Promise<BiometricEnrollResult> {
    try {
      // If no fingerprint / Face ID is enrolled on the device, this will throw.
      await keystoreStore(secret);
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
        // Return a fallback result instead of throwing.
        // The caller should prompt the user to enroll a biometric in the OS
        // settings and allow them to continue with the PIN.
        return { enrolled: false, noBiometric: true };
      } else {
        console.error('Failed to enable biometrics:', e);
      }
      throw e;
    }
  }

  /**
   * Triggers the OS biometric prompt (Android BiometricPrompt / iOS Face ID or
   * Touch ID) - the protected key is only usable after hardware-verified auth -
   * then decrypts and returns the secret.
   */
  static async authenticateAndGetSecret(): Promise<string | null> {
    try {
      return await keystoreRetrieve(KEYSTORE_SERVICE, KEYSTORE_USER);
    } catch (e) {
      console.error('Biometric authentication failed:', e);
      // If the protected key was lost (Android TEE corruption / reinstall, or an
      // iOS keychain item invalidated by a passcode reset) the retrieve fails at
      // cipher init. Clear the "configured" flag so the user gets the re-enrollment
      // prompt after their next PIN login.
      const msg = String(e);
      if (msg.includes('Error initializing cipher') || msg.includes('null cannot be cast')) {
        await BiometricService.disable().catch(() => {});
      }
      return null;
    }
  }

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
        /* Ignore - native storage unavailable */
      }
    }
    return false;
  }

  static async isAvailable(): Promise<boolean> {
    // checkStatus() invokes a Tauri IPC that blocks the WebKitGTK event loop
    // on Linux/macOS/Windows desktop where biometrics don't exist anyway.
    const isMobile =
      typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!isMobile) return false;
    const status: Status = await checkStatus();
    return status.isAvailable && status.biometryType !== BiometryType.None;
  }

  static async disable(): Promise<void> {
    try {
      await keystoreRemove(KEYSTORE_SERVICE, KEYSTORE_USER);
    } catch {
      // Key may already be absent; proceed with cleanup.
    }
    localStorage.removeItem(CONFIG_FLAG_KEY);
    if (isTauri()) {
      await invoke('set_native_flag', { key: NATIVE_FLAG_KEY, value: false }).catch(() => {});
    }
  }
}
