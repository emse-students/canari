package fr.emse.canari

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Shared helpers to load the MLS context and binary state from disk.
 * Centralized here to avoid duplication between [CanariFirebaseMessagingService]
 * and [MlsBackgroundWorker], which read the same files with the same logic.
 */
object MlsContextLoader {

    /**
     * Identity context required by every background-side MLS HTTP and JNI call.
     * Loaded from push_context.json, written by Tauri after authentication.
     *
     * [deviceKeyB64] carries the base64-encoded 32-byte MLS device key so the
     * FCM service can decrypt push notifications without a PIN. The PIN is never
     * stored in push_context.json; it lives exclusively in the PinVault
     * (AES-GCM encrypted in localStorage/sessionStorage).
     */
    data class PushContext(
        val userId: String,
        val deviceId: String,
        val baseUrl: String,
        val deviceKeyB64: String = "",
        /**
         * The language CHOSEN IN THE APP ("fr" / "en"), mirrored here because the WebView that
         * holds that choice is not running when a push arrives. It is NOT the phone's language:
         * `R.string` would resolve against the OS locale, so an app set to English on a French
         * phone wrote French notifications. Empty on a device that has not written it yet, in
         * which case the caller keeps the OS answer.
         */
        val locale: String = "",
    )

    /**
     * Data directory that Tauri uses as `app_data_dir()` on Android.
     * Tauri 2 resolves `app_data_dir()` to `getDataDir` WITHOUT suffixing the bundle identifier
     * (see tauri path/android.rs: app_data_dir -> getDataDir), i.e. `Context.getDataDir()`
     * = `/data/user/0/<package>`. Every file exchanged between Rust (app_data_dir) and
     * Kotlin (push_context.json, mls.bin, fcm_token.txt, pending_push_secret.txt) must
     * therefore target this directory - not `filesDir` nor `filesDir/<id>`, otherwise Rust and
     * Kotlin read/write in two different places.
     */
    fun tauriDataDir(context: Context): File = context.dataDir

    /**
     * Loads push_context.json from the Tauri directory (app_data_dir).
     * Returns null if the file is absent or if a required field is empty/missing.
     */
    fun loadPushContext(context: Context): PushContext? {
        val file = File(tauriDataDir(context), "push_context.json")
        if (!file.exists()) return null
        return try {
            val j = JSONObject(file.readText())
            val userId   = j.optString("userId").takeIf   { it.isNotEmpty() } ?: return null
            val deviceId = j.optString("deviceId").takeIf { it.isNotEmpty() } ?: return null
            val baseUrl  = j.optString("baseUrl").takeIf  { it.isNotEmpty() } ?: return null
            // WP-SEC-1: the device key is no longer in the JSON; source it from the Keystore.
            // An empty key means the keystore is unavailable — the push falls back to the
            // generic text, but that is the acceptable one-push cost (see B5 migration).
            val deviceKeyB64 = MlsDeviceKeyStore.retrieve(context, userId, deviceId) ?: ""
            PushContext(
                userId = userId,
                deviceId = deviceId,
                baseUrl = baseUrl,
                deviceKeyB64 = deviceKeyB64,
                locale = j.optString("locale"),
            )
        } catch (_: Exception) { null }
    }

    /**
     * Reads just the `userId` field of push_context.json.
     *
     * Deliberately NOT [loadPushContext]: that one also resolves the device key from the Keystore,
     * which is the expensive half and is pointless for a caller that only needs to know who we are
     * (the notification's self avatar). Returns null when the file is absent or the field is empty.
     */
    fun loadUserId(context: Context): String? {
        val file = File(tauriDataDir(context), "push_context.json")
        if (!file.exists()) return null
        return try {
            JSONObject(file.readText()).optString("userId").takeIf { it.isNotEmpty() }
        } catch (_: Exception) { null }
    }

    /**
     * Loads the binary MLS state from mls.bin in the Tauri directory (app_data_dir).
     * Returns null if the file is absent or unreadable.
     */
    fun loadMlsState(context: Context): ByteArray? {
        val file = File(tauriDataDir(context), "mls.bin")
        return if (file.exists()) try { file.readBytes() } catch (_: Exception) { null } else null
    }
}
