package app.tauri.keystore

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
//import android.hardware.biometrics.BiometricPrompt
import androidx.biometric.BiometricPrompt
import java.security.KeyStore
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.Logger
import android.util.Base64
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import javax.crypto.KeyGenerator
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.content.ContextCompat
import java.nio.charset.Charset
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEY_ALIAS = "unime_dev"
private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val SHARED_PREFERENCES_NAME = "secure_storage"

/// Fallback wording for the unlock prompt, used only when the caller supplies none.
/// French because that is what shipped; the localized values arrive in GetKeyBytesRequest.
private const val DEFAULT_UNLOCK_TITLE = "Déverrouiller Canari"
private const val DEFAULT_UNLOCK_SUBTITLE = "Confirmez votre identité avec votre empreinte"
private const val DEFAULT_CANCEL = "Annuler"

@InvokeArg
class StoreRequest {
    lateinit var value: String
    // TODO: use this instead?
    // var value: String? = null
}

@InvokeArg
class RetrieveRequest {
    lateinit var service: String
    lateinit var user: String
}

@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {
    private val implementation = Example()

    @Command
    fun store(invoke: Invoke) {
        val storeRequest = invoke.parseArgs(StoreRequest::class.java)

        // Generate Key (biometrics-protected)
        generateBiometricProtectedKey()

        // Get cipher for encryption
        val cipher = getEncryptionCipher()

        // Wrap the Cipher in a CryptoObject.
        val cryptoObject = BiometricPrompt.CryptoObject(cipher)

        // Create biometric prompt
        val executor = ContextCompat.getMainExecutor(activity)
        val biometricPrompt =
            BiometricPrompt(activity as androidx.fragment.app.FragmentActivity, executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        super.onAuthenticationSucceeded(result)
                        try {
                            // Get the cipher from the authentication result.
                            val authCipher = result.cryptoObject?.cipher
                                ?: throw IllegalStateException("Cipher not available after auth")

                            // Encrypt the value.
                            val ciphertext =
                                authCipher.doFinal(storeRequest.value.toByteArray(Charset.forName("UTF-8")))
                            val iv = authCipher.iv  // Capture the initialization vector.

                            // Store the ciphertext and IV.
                            storeCiphertext(iv, ciphertext)
                            Logger.info("Secret stored securely")
                        } catch (e: Exception) {
                            e.printStackTrace()
                            Logger.error("Encryption failed: ${e.message}")
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        super.onAuthenticationError(errorCode, errString)
                        invoke.reject("Authentication error: $errorCode")
                    }

                    override fun onAuthenticationFailed() {
                        super.onAuthenticationFailed()
                        invoke.reject("Authentication failed")
                    }
                })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Activer le déverrouillage biométrique")
            .setSubtitle("Confirmez votre identité pour activer la biométrie sur Canari")
            .setNegativeButtonText(DEFAULT_CANCEL)
            .build()

        biometricPrompt.authenticate(promptInfo, cryptoObject)

        // Unlock
//        val spec = javax.crypto.spec.GCMParameterSpec(123, iv)
//        cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)

//        val biometricPrompt = BiometricPrompt(
//            activity as androidx.fragment.app.FragmentActivity,
//            object : BiometricPrompt.AuthenticationCallback() {
//                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
//                    super.onAuthenticationSucceeded(result)
//                    try {
//                        // Use the cipher from the CryptoObject to decrypt the ciphertext.
//                        val decryptedBytes = result.cryptoObject?.cipher?.doFinal(ciphertext)
//                        val password = decryptedBytes?.toString(StandardCharsets.UTF_8)
//                        if (password != null) {
//                            onDecrypted(password)
//                        } else {
//                            onError("Decryption failed")
//                        }
//                    } catch (e: Exception) {
//                        onError("Decryption exception: ${e.message}")
//                    }
//                }
//                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
//                    super.onAuthenticationError(errorCode, errString)
//                    onError("Authentication error: $errString")
//                }
//                override fun onAuthenticationFailed() {
//                    super.onAuthenticationFailed()
//                    onError("Authentication failed")
//                }
//            }
//        )

        invoke.resolve()
    }

    // Generate key, if it doesn't exist.
    private fun generateBiometricProtectedKey() {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            val keyGenerator =
                KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            val builder = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Require authentication on every use:
                .setUserAuthenticationRequired(true)
            // Per-use strong-biometric auth. Only affects NEWLY generated keys (existing
            // aliases keep their spec), so enrolled devices are untouched either way.
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            } else {
                // Pre-API 30 equivalent of the above (-1 = biometric auth on every use).
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(-1)
            }
            val keyGenParameterSpec = builder.build()
            keyGenerator.init(keyGenParameterSpec)
            keyGenerator.generateKey()
        }
    }

    // Prepares and returns a Cipher instance for encryption using the key from the Keystore.
    private fun getEncryptionCipher(): Cipher {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val secretKey = keyStore.getKey(KEY_ALIAS, null) as SecretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        return cipher
    }

    // Stores the IV and ciphertext in SharedPreferences.
    private fun storeCiphertext(iv: ByteArray, ciphertext: ByteArray) {
        val prefs: SharedPreferences =
            activity.getSharedPreferences(SHARED_PREFERENCES_NAME, Context.MODE_PRIVATE)
        val editor = prefs.edit()
        val ivEncoded = Base64.encodeToString(iv, Base64.DEFAULT)
        val ctEncoded = Base64.encodeToString(ciphertext, Base64.DEFAULT)
        editor.putString("iv", ivEncoded)
        editor.putString("ciphertext", ctEncoded)
        editor.apply()
    }

    @Command
    fun retrieve(invoke: Invoke) {
        val args = invoke.parseArgs(RetrieveRequest::class.java)

        val cipherData = readCipherData()
        if (cipherData == null) {
            invoke.reject("No cipher data found in SharedPreferences", "001")
            return
        }

        val (iv, ciphertext) = cipherData

        val cipher = try {
            getDecryptionCipher(iv)
        } catch (e: Exception) {
            invoke.reject("Error initializing cipher: ${e.message}", "001")
            return
        }

        val executor = ContextCompat.getMainExecutor(activity)
        val biometricPrompt = BiometricPrompt(activity as androidx.fragment.app.FragmentActivity, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    try {
                        // Use the cipher from the authentication result (which is now unlocked).
                        val authCipher = result.cryptoObject?.cipher
                            ?: throw IllegalStateException("Cipher not available after authentication")
                        val decryptedBytes = authCipher.doFinal(ciphertext)
                        val cleartext = String(decryptedBytes, Charset.forName("UTF-8"))

                        val ret = JSObject()
                        ret.put("value", cleartext)
                        invoke.resolve(ret)
                    } catch (e: Exception) {
                        invoke.reject("Decryption failed: ${e.message}")
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    invoke.reject("Authentication error: $errorCode")
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    invoke.reject("Authentication failed")
                }
            })

        // Build the prompt info. Unlike getKeyBytes this command carries no text: it is the
        // legacy single-secret API (alias `unime_dev`) that nothing in Canari calls any more.
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(DEFAULT_UNLOCK_TITLE)
            .setSubtitle(DEFAULT_UNLOCK_SUBTITLE)
            .setNegativeButtonText(DEFAULT_CANCEL)
            .build()

        // Launch the biometric prompt.
        biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
    }

    // Reads the IV and ciphertext from SharedPreferences.
    private fun readCipherData(): Pair<ByteArray, ByteArray>? {
        val prefs: SharedPreferences =
            activity.getSharedPreferences(SHARED_PREFERENCES_NAME, Context.MODE_PRIVATE)
        val ivEncoded: String? = prefs.getString("iv", null)
        val ctEncoded: String? = prefs.getString("ciphertext", null)
        if (ivEncoded == null || ctEncoded == null) {
            return null
        }
        val iv = Base64.decode(ivEncoded, Base64.DEFAULT)
        val ciphertext = Base64.decode(ctEncoded, Base64.DEFAULT)
        return Pair(iv, ciphertext)
    }

    private fun getDecryptionCipher(iv: ByteArray): Cipher {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val secretKey = keyStore.getKey(KEY_ALIAS, null) as SecretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(128, iv)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)
        return cipher
    }

    @Command
    fun remove(invoke: Invoke) {
        try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            keyStore.deleteEntry(KEY_ALIAS)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not delete entry from KeyStore: ${e.localizedMessage}")
        }
    }

    // --- Key-bytes commands (MLS device key storage) ---

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
