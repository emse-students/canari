package fr.emse.canari

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.util.Log
import java.io.File

/**
 * Application custom chargée AVANT tout composant Android (y compris les services FCM).
 * Rôles :
 *  1. Charger la bibliothèque native Rust mines_app_lib.
 *  2. Créer les canaux de notification Android (requis depuis API 26).
 *  3. Transférer le pushSecret depuis pending_push_secret.txt vers le Keystore Android
 *     (écrit par Tauri après enregistrement FCM, lu une seule fois puis supprimé).
 *
 * Enregistrée dans AndroidManifest.xml via android:name=".CanariApplication".
 */
class CanariApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            System.loadLibrary("mines_app_lib")
        } catch (_: UnsatisfiedLinkError) {
            // La lib n'est pas disponible sur cette architecture – les appels
            // natifs échoueront gracieusement (notification générique affichée).
        }
        createNotificationChannels()
        processPendingPushSecret()
        checkKeystoreHealth()
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        ensureChannels(manager)
    }

    /**
     * Vérifie que le Keystore Android peut lire le push secret (clé non perdue).
     * Écrit `keystore_ok.flag` si OK, le supprime sinon.
     * La commande Tauri `check_push_secret_health` lit ce flag pour signaler l'UI.
     * Appel silencieux : une erreur ici ne doit pas bloquer le démarrage.
     */
    private fun checkKeystoreHealth() {
        try {
            val contextFile = File(filesDir.parentFile, "push_context.json")
            if (!contextFile.exists()) return // pas encore authentifié, aucun secret attendu
            val markerFile = File(filesDir.parentFile, "keystore_ok.flag")
            val secret = PushSecretKeystore.retrieve(this)
            if (secret != null) {
                markerFile.writeText("ok")
                Log.d(TAG, "checkKeystoreHealth: Keystore opérationnel")
            } else {
                markerFile.delete()
                Log.e(TAG, "checkKeystoreHealth: Keystore perdu — push background désactivé")
            }
        } catch (e: Exception) {
            Log.e(TAG, "checkKeystoreHealth: exception: ${e.message}", e)
        }
    }

    private fun processPendingPushSecret() {
        try {
            val file = File(filesDir.parentFile, "pending_push_secret.txt")
            if (!file.exists()) return
            // Read raw bytes first so the overwrite covers the exact file size, including
            // any trailing newline. secret.length is a char count and diverges from byte
            // count for multi-byte UTF-8 sequences, leaving secret bytes unzeroed.
            val rawBytes = file.readBytes()
            val secret = rawBytes.toString(Charsets.UTF_8).trim()
            if (secret.isNotEmpty()) {
                PushSecretKeystore.store(this, secret)
                Log.i(TAG, "processPendingPushSecret: secret stocké dans le Keystore")
            }
            file.writeBytes(ByteArray(rawBytes.size) { 0 })
            file.delete()
        } catch (e: Exception) {
            Log.e(TAG, "processPendingPushSecret: échec du transfert push secret: ${e.message}", e)
        }
    }

    companion object {
        private const val TAG = "CanariApp"

        /**
         * Crée les trois canaux de notification s'ils n'existent pas encore.
         * Appelé depuis [CanariApplication.onCreate] et en fallback depuis
         * [CanariFirebaseMessagingService.ensureNotificationChannels].
         *  - canari_messages : DMs et messages de groupe (IMPORTANCE_HIGH, vibration, son)
         *  - canari_social   : réactions/commentaires sur les posts (IMPORTANCE_DEFAULT, silencieux)
         *  - canari_forms    : rappels de formulaires (IMPORTANCE_DEFAULT, silencieux)
         */
        internal fun ensureChannels(manager: NotificationManager) {
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_MESSAGES) == null) {
                val audioAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_MESSAGES,
                        "Messages Canari",
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = "Notifications de messages reçus via Canari"
                        enableVibration(true)
                        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audioAttrs)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_SOCIAL) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_SOCIAL,
                        "Activité sociale Canari",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = "Réactions et commentaires sur vos publications"
                        enableVibration(false)
                        setSound(null, null)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_FORMS) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_FORMS,
                        "Rappels de formulaires",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = "Rappels avant l'ouverture des formulaires"
                        enableVibration(false)
                        setSound(null, null)
                    }
                )
            }
        }
    }
}
