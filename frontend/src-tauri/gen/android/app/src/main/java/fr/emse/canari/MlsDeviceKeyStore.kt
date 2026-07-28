package fr.emse.canari

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * Context-only (no Activity) reader/writer for the MLS device key stored in the Android Keystore.
 *
 * Mirrors the exact encryption scheme used by [KeystorePlugin] (Tauri keystore plugin):
 * - Keystore key alias: `mls_device_key_{userId}_{deviceId}`
 * - Prefs name: `"keystore_aliases"` (MUST match KeystorePlugin.kt)
 * - Prefs keys: `"${alias}_iv"` / `"${alias}_ct"`
 * - Cipher: `AES/GCM/NoPadding`, `GCMParameterSpec(128, iv)`
 * - Encoding: `Base64.DEFAULT` (NOT `NO_WRAP` - KeystorePlugin encodes with DEFAULT)
 *
 * The keystore key does NOT require user authentication (`setUserAuthenticationRequired(false)`),
 * matching the plugin's `generateBiometricProtectedKeyForAlias`. This makes the key readable in the
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
     * Stores [keyB64] (base64-encoded 32-byte MLS device key) in the Android Keystore under
     * the per-user+device alias returned by [alias]. The key is AES-256-GCM-encrypted with a
     * keystore-backed key; the IV and ciphertext are persisted in SharedPreferences.
     *
     * Returns true on success, false on any failure (logged to logcat).
     */
    fun store(context: Context, userId: String, deviceId: String, keyB64: String): Boolean {
        return try {
            val alias = alias(userId, deviceId)
            val keyBytes = Base64.decode(keyB64, Base64.DEFAULT)

            // Generate the keystore key if it doesn't exist yet (no-op if already present).
            generateKeystoreKeyIfNeeded(alias)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val secretKey = getKeystoreKey(alias) ?: return false
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(keyBytes)

            val prefs: SharedPreferences = context.getSharedPreferences(
                PREFS_NAME, Context.MODE_PRIVATE
            )
            prefs.edit()
                .putString("${alias}_iv", Base64.encodeToString(iv, Base64.DEFAULT))
                .putString("${alias}_ct", Base64.encodeToString(ciphertext, Base64.DEFAULT))
                .apply()

            Log.d(TAG, "store: success alias=$alias")
            true
        } catch (e: Exception) {
            Log.e(TAG, "store: failed: ${e.message}", e)
            false
        }
    }

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

    // Deletion is owned by KeystorePlugin.deleteKeyBytes (same alias, same prefs) and is
    // reached from the app process, so there is no Context-only twin here.

    // -- private helpers ----------------------------------------------------

    private fun generateKeystoreKeyIfNeeded(alias: String) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(alias)) return

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE
        )
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(false)

        keyGenerator.init(builder.build())
        keyGenerator.generateKey()
    }

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
