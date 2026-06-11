package fr.emse.canari

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Utilitaires partagés pour charger le contexte MLS et l'état binaire depuis le disque.
 * Centralisé ici pour éviter la duplication entre [CanariFirebaseMessagingService]
 * et [MlsBackgroundWorker], qui lisent les mêmes fichiers avec la même logique.
 */
object MlsContextLoader {

    /**
     * Contexte d'identité nécessaire à tous les appels HTTP et JNI MLS côté background.
     * Chargé depuis push_context.json, écrit par Tauri après authentification.
     */
    data class PushContext(
        val pin: String,
        val userId: String,
        val deviceId: String,
        val baseUrl: String,
    )

    /**
     * Répertoire de données que Tauri utilise comme `app_data_dir()` sur Android.
     * Tauri 2 résout `app_data_dir()` vers `getDataDir` SANS suffixer le bundle identifier
     * (cf. tauri path/android.rs : app_data_dir → getDataDir), soit `Context.getDataDir()`
     * = `/data/user/0/<package>`. Tous les fichiers échangés entre Rust (app_data_dir) et
     * Kotlin (push_context.json, mls.bin, fcm_token.txt, pending_push_secret.txt) doivent
     * donc viser ce répertoire — et non `filesDir` ni `filesDir/<id>`, sinon Rust et Kotlin
     * lisent/écrivent à deux endroits différents.
     */
    fun tauriDataDir(context: Context): File = context.dataDir

    /**
     * Charge push_context.json depuis le répertoire Tauri (app_data_dir).
     * Retourne null si le fichier est absent ou si un champ obligatoire est vide/manquant.
     */
    fun loadPushContext(context: Context): PushContext? {
        val file = File(tauriDataDir(context), "push_context.json")
        if (!file.exists()) return null
        return try {
            val j = JSONObject(file.readText())
            PushContext(
                pin      = j.optString("pin").takeIf      { it.isNotEmpty() } ?: return null,
                userId   = j.optString("userId").takeIf   { it.isNotEmpty() } ?: return null,
                deviceId = j.optString("deviceId").takeIf { it.isNotEmpty() } ?: return null,
                baseUrl  = j.optString("baseUrl").takeIf  { it.isNotEmpty() } ?: return null,
            )
        } catch (_: Exception) { null }
    }

    /**
     * Charge l'état MLS binaire depuis mls.bin dans le répertoire Tauri (app_data_dir).
     * Retourne null si le fichier est absent ou illisible.
     */
    fun loadMlsState(context: Context): ByteArray? {
        val file = File(tauriDataDir(context), "mls.bin")
        return if (file.exists()) try { file.readBytes() } catch (_: Exception) { null } else null
    }
}
