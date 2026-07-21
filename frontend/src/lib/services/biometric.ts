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
   */
  static async enableBiometric(secret: string): Promise<void> {
    try {
      // Si aucune empreinte n'est configurée sur le téléphone, ceci va throw
      await keystoreStore(secret);
      localStorage.setItem(CONFIG_FLAG_KEY, 'true');
      if (isTauri()) {
        await invoke('set_native_flag', { key: NATIVE_FLAG_KEY, value: true }).catch(() => {});
      }
    } catch (e) {
      const errorMsg = String(e);
      if (errorMsg.includes('At least one biometric must be enrolled')) {
        console.warn(
          "Matériel biométrique présent, mais aucune empreinte configurée par l'utilisateur."
        );
        // TODO: Gérer le fallback ici (ex: forcer l'utilisation du PIN, ou afficher
        // un message demandant à l'utilisateur d'aller enroler une empreinte / Face ID
        // dans les réglages de l'OS - Android comme iOS).
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
