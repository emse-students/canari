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
     * Charge push_context.json depuis le répertoire parent de filesDir.
     * Retourne null si le fichier est absent ou si un champ obligatoire est vide/manquant.
     */
    fun loadPushContext(context: Context): PushContext? {
        val file = File(context.filesDir, "push_context.json")
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
     * Charge l'état MLS binaire depuis mls.bin dans le répertoire parent de filesDir.
     * Retourne null si le fichier est absent ou illisible.
     */
    fun loadMlsState(context: Context): ByteArray? {
        val file = File(context.filesDir, "mls.bin")
        return if (file.exists()) try { file.readBytes() } catch (_: Exception) { null } else null
    }
}
