import {
  store as keystoreStore,
  retrieve as keystoreRetrieve,
  remove as keystoreRemove,
} from '@impierce/tauri-plugin-keystore';

// Service/user are parsed but ignored by the plugin internally (uses a hardcoded
// Android Keystore alias); values are kept here for forward compatibility.
const KEYSTORE_SERVICE = 'fr.emse.canari';
const KEYSTORE_USER = 'canari_biometric_user';
const CONFIG_FLAG_KEY = 'canari_biometric_configured';

export class BiometricService {
  /**
   * Enrolls biometric protection for the given secret.
   * keystoreStore() generates a hardware-backed AES-GCM key in the Android
   * Keystore (userAuthenticationRequired = true, CryptoObject every-use) and
   * shows the OS BiometricPrompt to encrypt the secret — nothing is stored in
   * plain text on disk.
   *
   * Note: tauri-plugin-keystore is alpha; its store() JS promise resolves
   * immediately while biometric auth completes asynchronously on-device.
   */
  static async enableBiometric(secret: string): Promise<void> {
    try {
      await keystoreStore(secret);
      localStorage.setItem(CONFIG_FLAG_KEY, 'true');
    } catch (e) {
      console.error('Failed to enable biometrics:', e);
      throw e;
    }
  }

  /**
   * Shows the OS BiometricPrompt backed by a CryptoObject — the Android Keystore
   * AES key is only usable after hardware-verified biometric auth — then decrypts
   * and returns the protected secret.
   */
  static async authenticateAndGetSecret(): Promise<string | null> {
    try {
      return await keystoreRetrieve(KEYSTORE_SERVICE, KEYSTORE_USER);
    } catch (e) {
      console.error('Biometric authentication failed:', e);
      return null;
    }
  }

  static async isConfigured(): Promise<boolean> {
    return localStorage.getItem(CONFIG_FLAG_KEY) === 'true';
  }

  static async disable(): Promise<void> {
    try {
      await keystoreRemove(KEYSTORE_SERVICE, KEYSTORE_USER);
    } catch {
      // Key may already be absent; proceed with cleanup.
    }
    localStorage.removeItem(CONFIG_FLAG_KEY);
  }
}
