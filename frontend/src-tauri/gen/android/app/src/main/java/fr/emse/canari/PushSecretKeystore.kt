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
     *
     * Refuses while credential-encrypted storage is locked: the SharedPreferences write would
     * target a store this process cannot read back, and opening it here caches an EMPTY instance
     * for the life of the process (see [DirectBoot]).
     */
    fun store(context: Context, secret: String) {
        if (!DirectBoot.storageReadable(context)) {
            Log.w(TAG, "store: refused - storage still locked (pre-unlock process)")
            return
        }
        val key = getOrCreateKey(context)
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
        if (!DirectBoot.storageReadable(context)) {
            // Not "no secret": we cannot look. Reading here would also cache an empty
            // SharedPreferences for the life of the process, which no later unlock repairs.
            Log.w(TAG, "retrieve: storage still locked (pre-unlock process) - not a missing secret")
            return null
        }
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val encB64 = prefs.getString(PREFS_KEY_ENC, null) ?: return null
        val ivB64  = prefs.getString(PREFS_KEY_IV,  null) ?: return null
        return try {
            val key = getOrCreateKey(context)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_LENGTH, iv))
            String(cipher.doFinal(Base64.decode(encB64, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "retrieve: Keystore AES-GCM failure: ${e.message}", e)
            null
        }
    }

    /**
     * Returns the Keystore key, creating it only when it is genuinely ABSENT.
     *
     * The destructive branch below recovers a key that survived as an unusable entry - TEE
     * corruption after a partial wipe - and it must never fire for a key that is merely not
     * readable YET. Those two look identical from `getKey`: it throws, or answers null, for both.
     * The discriminator is not the exception, it is whether credential-encrypted storage is open,
     * so the caller checks that first and this stays the last line of defence. Deleting the alias
     * in a pre-unlock process would orphan the ciphertext in SharedPreferences for good, and the
     * user would find background push dead with `keystore_ok.flag` gone - a permanent loss caused
     * by a temporary condition (WP-DIRECTBOOT-1).
     *
     * `containsAlias` distinguishes the two cases the caller cannot: absent is a fresh install,
     * present-but-unreadable is a diagnosis this function is not entitled to make on its own.
     */
    private fun getOrCreateKey(context: Context): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        try {
            ks.getKey(KEY_ALIAS, null)?.let { return it as SecretKey }
        } catch (e: Exception) {
            val readable = DirectBoot.storageReadable(context)
            val present = try { ks.containsAlias(KEY_ALIAS) } catch (_: Exception) { false }
            if (present && !readable) {
                // The one case that must NOT be repaired by deletion.
                Log.e(TAG, "getOrCreateKey: key present but unreadable while locked - refusing to recreate")
                throw IllegalStateException("push secret key not available before first unlock", e)
            }
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
