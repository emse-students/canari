package fr.emse.canari

import android.content.Context
import android.util.Log
import java.security.SecureRandom

/**
 * The install's native cache key: what seals the Graine seed mirror and the push message cache at
 * rest (Rust `native_cache`, the only copy of the design).
 *
 * A random 32-byte key, wrapped by a non-exportable Android Keystore key exactly like the device
 * key's background copy ([MlsDeviceKeyStore]), so the push service reads it with the app killed
 * and the app process reads it through the keystore plugin (`getKeyBytesUnattended`). It is NOT the
 * device key: that one changes with the PIN, and a key that changes would leave the push service
 * and the app sealing one file under two keys. This one never changes for the life of the install.
 *
 * CREATED HERE AND NOWHERE ELSE, by [ensure] at process start (`CanariApplication`): one creator,
 * so two halves of one file can never be sealed under two keys.
 */
object NativeCacheKey {
    private const val TAG = "NativeCacheKey"

    /** Spelled in `native_cache.rs`, `canari_ios.mm` and `NotificationService.swift` too. */
    const val ALIAS = "canari_native_cache_key"

    private val LOCK = Any()

    /**
     * Makes sure the key exists, creating it once. Idempotent: the persisted IV and ciphertext are
     * the durable record that it exists.
     *
     * The one destructive branch - replacing a key that exists - is taken only when the Keystore
     * entry wrapping it is GONE (a fact: nothing wrapped under it will ever unwrap), never because a
     * read failed: a failed read leaves everything as it is and says so.
     */
    fun ensure(context: Context) {
        synchronized(LOCK) {
            if (MlsDeviceKeyStore.hasAlias(context, ALIAS)) {
                if (MlsDeviceKeyStore.retrieveForAlias(context, ALIAS) != null) {
                    Log.d(TAG, "ensure: present")
                    return
                }
                val wrapperGone = try {
                    !MlsDeviceKeyStore.keystoreHoldsAlias(ALIAS)
                } catch (e: Exception) {
                    Log.e(TAG, "ensure: Keystore unreadable, key left as it is: ${e.message}")
                    return
                }
                if (!wrapperGone) {
                    Log.e(TAG, "ensure: key present but unreadable, left as it is")
                    return
                }
                Log.e(TAG, "ensure: the Keystore entry wrapping the key is gone - a new key is made; what the old one sealed is lost")
            }
            val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val stored = MlsDeviceKeyStore.storeForAlias(context, ALIAS, raw, durable = true)
            raw.fill(0)
            if (stored) {
                Log.i(TAG, "ensure: created")
            } else {
                Log.e(TAG, "ensure: creation failed - the native caches stay unwritten until it succeeds")
            }
        }
    }

    /**
     * The key as NO_WRAP base64, for the Rust FFI, or `""` when it cannot be read - which every
     * Rust entry point treats as "write nothing, read nothing sealed", never as a reason to write in
     * the clear.
     */
    fun retrieve(context: Context): String =
        MlsDeviceKeyStore.retrieveForAlias(context, ALIAS) ?: run {
            Log.w(TAG, "retrieve: no key - the native caches are neither written nor read")
            ""
        }
}
