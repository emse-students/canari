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
            // Retrocompatibilite: ignorer l'ancien champ "pin" s'il existe.
            // deviceKeyB64 peut etre vide (keystore indisponible) — le push
            // ne pourra pas dechiffrer, mais c'est mieux que de stocker le PIN.
            PushContext(
                userId   = j.optString("userId").takeIf   { it.isNotEmpty() } ?: return null,
                deviceId = j.optString("deviceId").takeIf { it.isNotEmpty() } ?: return null,
                baseUrl  = j.optString("baseUrl").takeIf  { it.isNotEmpty() } ?: return null,
                deviceKeyB64  = j.optString("deviceKeyB64", ""),
            )
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
