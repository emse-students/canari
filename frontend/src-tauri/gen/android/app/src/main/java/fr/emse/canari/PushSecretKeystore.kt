package fr.emse.canari

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object PushSecretKeystore {
    private const val TAG = "PushSecretKeystore"
    private const val KEY_ALIAS = "canari_push_secret_key"
    private const val PREFS_NAME = "canari_push_prefs"
    private const val PREFS_KEY_ENC = "push_secret_enc"
    private const val PREFS_KEY_IV = "push_secret_iv"
    private const val GCM_TAG_LENGTH = 128

    /**
     * Encrypts [secret] with AES-256-GCM using an Android Keystore key,
     * then stores the ciphertext and IV in the app's SharedPreferences.
     * Must be called exactly once from [CanariApplication] at startup.
     */
    fun store(context: Context, secret: String) {
        val key = getOrCreateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv
        val encrypted = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(PREFS_KEY_ENC, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(PREFS_KEY_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
            .apply()
    }

    /**
     * Decrypts the secret stored by [store] and returns the cleartext value.
     * Returns null if the secret was never stored or if the Keystore fails
     * (TEE failure, device reset) - the error is logged to logcat.
     */
    fun retrieve(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val encB64 = prefs.getString(PREFS_KEY_ENC, null) ?: return null
        val ivB64  = prefs.getString(PREFS_KEY_IV,  null) ?: return null
        return try {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_LENGTH, iv))
            String(cipher.doFinal(Base64.decode(encB64, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "retrieve: Keystore AES-GCM failure: ${e.message}", e)
            null
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        // Try to use existing key. If it's present but unusable (e.g. TEE corruption after
        // a factory-reset partial wipe), delete it so we can create a fresh one below.
        try {
            ks.getKey(KEY_ALIAS, null)?.let { return it as SecretKey }
        } catch (e: Exception) {
            Log.w(TAG, "getOrCreateKey: existing key unusable, recreating: ${e.message}")
            try { ks.deleteEntry(KEY_ALIAS) } catch (_: Exception) {}
        }
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .also { it.init(spec) }
            .generateKey()
    }
}
