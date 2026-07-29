package app.tauri.keystore

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import androidx.biometric.BiometricPrompt
import java.security.KeyStore
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import android.util.Base64
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import javax.crypto.KeyGenerator
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.content.ContextCompat
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/// Fallback wording for the unlock prompt, used only when the caller supplies none.
/// French because that is what shipped; the localized values arrive in GetKeyBytesRequest.
private const val DEFAULT_UNLOCK_TITLE = "Déverrouiller Canari"
private const val DEFAULT_UNLOCK_SUBTITLE = "Confirmez votre identité avec votre empreinte"
private const val DEFAULT_CANCEL = "Annuler"

@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {
    /// Request/response classes for the key-bytes API.
    @InvokeArg
    class StoreKeyBytesRequest {
        lateinit var alias: String
        lateinit var keyBytes: String  // base64-encoded 32-byte key
    }

    /// Reading the key raises a BiometricPrompt, so the request also carries its text.
    ///
    /// The plugin runs in a native process with no access to the app's message catalogue, so every
    /// string comes from the caller (JS -> `initialiser_mls` -> `GetKeyBytesRequest`). Each is
    /// optional and falls back to the French literal that shipped before: a missing translation
    /// must degrade to the previous wording, never to an unlock that cannot happen.
    @InvokeArg
    class GetKeyBytesRequest {
        lateinit var alias: String
        var title: String? = null
        var subtitle: String? = null
        var cancelTitle: String? = null
        // `reason` is iOS-only (LAContext.localizedReason); Android has no field for it.
    }

    @InvokeArg
    class DeleteKeyBytesRequest {
        lateinit var alias: String
    }

    /// Stores a raw 32-byte AES key (base64-encoded) in the Android Keystore.
    ///
    /// Encryption is performed directly (no biometric prompt) — the keystore key
    /// does not require user authentication.  This command is called during the
    /// normal PIN login flow, where the user has already authenticated via their
    /// PIN; a second biometric prompt would be disruptive.
    ///
    /// Hardware backing (key material never leaves the TEE) still protects the
    /// data at rest.
    @Command
    fun storeKeyBytes(invoke: Invoke) {
        val args = invoke.parseArgs(StoreKeyBytesRequest::class.java)
        val keyBytes = Base64.decode(args.keyBytes, Base64.DEFAULT)

        try {
            generateBiometricProtectedKeyForAlias(args.alias)
            val cipher = getEncryptionCipherForAlias(args.alias)
            val ciphertext = cipher.doFinal(keyBytes)
            val iv = cipher.iv
            storeCipherDataForAlias(args.alias, iv, ciphertext)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("storeKeyBytes failed: ${e.message}")
        }
    }

    /// Retrieves a raw 32-byte key by alias.  Triggers a biometric prompt as a
    /// UX gate — the user must prove their presence — but the underlying
    /// keystore key does NOT require user authentication cryptographically
    /// (see `generateBiometricProtectedKeyForAlias`).  Returns a JSObject
    /// with `keyBytes` (base64) or `null` if not found.
    @Command
    fun getKeyBytes(invoke: Invoke) {
        val args = invoke.parseArgs(GetKeyBytesRequest::class.java)

        val cipherData = readCipherDataForAlias(args.alias)
        if (cipherData == null) {
            val ret = JSObject()
            ret.put("keyBytes", null)
            invoke.resolve(ret)
            return
        }

        val (iv, ciphertext) = cipherData

        val executor = ContextCompat.getMainExecutor(activity)
        val biometricPrompt = BiometricPrompt(
            activity as androidx.fragment.app.FragmentActivity, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(
                    result: BiometricPrompt.AuthenticationResult
                ) {
                    super.onAuthenticationSucceeded(result)
                    try {
                        // Cipher init + decrypt after successful biometric UX gate.
                        val cipher = getDecryptionCipherForAlias(args.alias, iv)
                        val decryptedBytes = cipher.doFinal(ciphertext)
                        val keyB64 = Base64.encodeToString(
                            decryptedBytes, Base64.DEFAULT
                        )

                        val ret = JSObject()
                        ret.put("keyBytes", keyB64)
                        invoke.resolve(ret)
                    } catch (e: Exception) {
                        invoke.reject("Decryption failed: ${e.message}")
                    }
                }

                override fun onAuthenticationError(
                    errorCode: Int, errString: CharSequence
                ) {
                    super.onAuthenticationError(errorCode, errString)
                    invoke.reject("Authentication error: $errorCode")
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    invoke.reject("Authentication failed")
                }
            })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(args.title ?: DEFAULT_UNLOCK_TITLE)
            .setSubtitle(args.subtitle ?: DEFAULT_UNLOCK_SUBTITLE)
            .setNegativeButtonText(args.cancelTitle ?: DEFAULT_CANCEL)
            .build()

        // No CryptoObject — biometric is a pure UX gate, not a crypto requirement.
        biometricPrompt.authenticate(promptInfo)
    }

    /// Deletes a raw key by alias from both the Android Keystore and
    /// SharedPreferences. Does not error if the entry doesn't exist.
    @Command
    fun deleteKeyBytes(invoke: Invoke) {
        val args = invoke.parseArgs(DeleteKeyBytesRequest::class.java)

        try {
            // Delete the keystore entry.
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
                load(null)
            }
            keyStore.deleteEntry(args.alias)

            // Delete the SharedPreferences data.
            val prefs: SharedPreferences = activity.getSharedPreferences(
                "keystore_aliases", Context.MODE_PRIVATE
            )
            prefs.edit()
                .remove("${args.alias}_iv")
                .remove("${args.alias}_ct")
                .apply()

            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(
                "Could not delete key entry: ${e.localizedMessage}"
            )
        }
    }

    /// Lightweight existence check — reads SharedPreferences only, does NOT
    /// access the Android Keystore and does NOT trigger a BiometricPrompt.
    /// Returns `{ present: true }` when cipher data exists for the alias.
    @Command
    fun hasKeyBytes(invoke: Invoke) {
        val args = invoke.parseArgs(GetKeyBytesRequest::class.java)
        val cipherData = readCipherDataForAlias(args.alias)
        val ret = JSObject()
        ret.put("present", cipherData != null)
        invoke.resolve(ret)
    }

    // --- Alias-aware keystore utilities ---

    /// Generates an AES-256 key for the given alias in AndroidKeyStore.
    /// No-op if the alias already exists.
    ///
    /// The key does NOT require user authentication — encryption (storeKeyBytes)
    /// must work silently during PIN login without a biometric prompt.  Hardware
    /// backing (key material never leaves the TEE) still protects the key at rest.
    /// Biometric authentication is handled at the UX level by getKeyBytes.
    private fun generateBiometricProtectedKeyForAlias(alias: String) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
            load(null)
        }
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

    /// Returns an encryption cipher initialised with the keystore key for
    /// the given alias.
    private fun getEncryptionCipherForAlias(alias: String): Cipher {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
            load(null)
        }
        val secretKey = keyStore.getKey(alias, null) as SecretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        return cipher
    }

    /// Returns a decryption cipher initialised with IV and the keystore key
    /// for the given alias.
    private fun getDecryptionCipherForAlias(alias: String, iv: ByteArray): Cipher {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
            load(null)
        }
        val secretKey = keyStore.getKey(alias, null) as SecretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(128, iv)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)
        return cipher
    }

    /// Stores IV + ciphertext in SharedPreferences namespaced by alias.
    private fun storeCipherDataForAlias(
        alias: String, iv: ByteArray, ct: ByteArray
    ) {
        val prefs: SharedPreferences = activity.getSharedPreferences(
            "keystore_aliases", Context.MODE_PRIVATE
        )
        val editor = prefs.edit()
        editor.putString(
            "${alias}_iv", Base64.encodeToString(iv, Base64.DEFAULT)
        )
        editor.putString(
            "${alias}_ct", Base64.encodeToString(ct, Base64.DEFAULT)
        )
        editor.apply()
    }

    /// Reads IV + ciphertext from SharedPreferences for the given alias.
    /// Returns null if neither IV nor ciphertext is found.
    private fun readCipherDataForAlias(
        alias: String
    ): Pair<ByteArray, ByteArray>? {
        val prefs: SharedPreferences = activity.getSharedPreferences(
            "keystore_aliases", Context.MODE_PRIVATE
        )
        val ivEncoded: String? = prefs.getString("${alias}_iv", null)
        val ctEncoded: String? = prefs.getString("${alias}_ct", null)
        if (ivEncoded == null || ctEncoded == null) {
            return null
        }
        val iv = Base64.decode(ivEncoded, Base64.DEFAULT)
        val ciphertext = Base64.decode(ctEncoded, Base64.DEFAULT)
        return Pair(iv, ciphertext)
    }
}
