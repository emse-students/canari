package fr.emse.canari

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Context-only (no Activity) READER of the MLS device key stored in the Android Keystore.
 *
 * Mirrors the exact encryption scheme used by [KeystorePlugin] (Tauri keystore plugin):
 * - Keystore key alias: `mls_device_key_{userId}_{deviceId}`
 * - Prefs name: `"keystore_aliases"` (MUST match KeystorePlugin.kt)
 * - Prefs keys: `"${alias}_iv"` / `"${alias}_ct"`
 * - Cipher: `AES/GCM/NoPadding`, `GCMParameterSpec(128, iv)`
 * - Encoding: `Base64.DEFAULT` (NOT `NO_WRAP` - KeystorePlugin encodes with DEFAULT)
 *
 * The keystore key, created by the plugin's `generateBiometricProtectedKeyForAlias`, does NOT
 * require user authentication (`setUserAuthenticationRequired(false)`). This makes the key readable in the
 * background (app killed, screen locked) which is exactly when a push arrives.
 *
 * Does NOT use `createDeviceProtectedStorageContext()` - credential-protected storage is correct
 * (readable after first unlock) and the prefs do not exist in direct-boot storage.
 */
object MlsDeviceKeyStore {
    private const val TAG = "MlsDeviceKeyStore"
    private const val PREFS_NAME = "keystore_aliases"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val GCM_TAG_LENGTH = 128

    fun alias(userId: String, deviceId: String): String =
        "mls_device_key_${userId}_${deviceId}"

    /**
     * Retrieves the base64-encoded 32-byte MLS device key from the Android Keystore.
     * Returns null if the key was never stored, the keystore entry is missing, or decryption fails.
     */
    fun retrieve(context: Context, userId: String, deviceId: String): String? {
        return try {
            val alias = alias(userId, deviceId)
            val prefs: SharedPreferences = context.getSharedPreferences(
                PREFS_NAME, Context.MODE_PRIVATE
            )
            val ivB64 = prefs.getString("${alias}_iv", null) ?: return null
            val ctB64 = prefs.getString("${alias}_ct", null) ?: return null

            val iv = Base64.decode(ivB64, Base64.DEFAULT)
            val ciphertext = Base64.decode(ctB64, Base64.DEFAULT)

            val secretKey = getKeystoreKey(alias) ?: return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH, iv))
            val decrypted = cipher.doFinal(ciphertext)

            // NO_WRAP, not DEFAULT: this value is handed to the Rust FFI, whose
            // decode_base64_to_32_bytes does NOT trim. Base64.DEFAULT terminates its output
            // with a newline, which makes the STANDARD engine reject the whole string and
            // kills background decrypt. DEFAULT above is correct for the IV/CT because that
            // is KeystorePlugin's own at-rest format; this one is our wire value.
            val result = Base64.encodeToString(decrypted, Base64.NO_WRAP)
            Log.d(TAG, "retrieve: success alias=$alias")
            result
        } catch (e: Exception) {
            Log.e(TAG, "retrieve: failed: ${e.message}", e)
            null
        }
    }

    // WRITES AND DELETES ARE NOT HERE, ON PURPOSE (2026-10-22). Both belong to KeystorePlugin (same
    // alias, same prefs), reached only through the app's Rust bridge, which asks the at-rest guard
    // first (`keystore_bridge.rs`): on a migrated phone this entry is the only copy of the key.

    // -- private helpers ----------------------------------------------------

    private fun getKeystoreKey(alias: String): SecretKey? {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            keyStore.getKey(alias, null) as? SecretKey
        } catch (e: Exception) {
            Log.e(TAG, "getKeystoreKey: failed for alias=$alias: ${e.message}", e)
            null
        }
    }
}
