package fr.emse.canari

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import java.io.File

/**
 * Application custom chargée AVANT tout composant Android (y compris les services FCM).
 * Rôles :
 *  1. Charger la bibliothèque native Rust mines_app_lib.
 *  2. Transférer le pushSecret depuis pending_push_secret.txt vers le Keystore Android
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
        createNotificationChannel()
        processPendingPushSecret()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CanariFirebaseMessagingService.CHANNEL_ID,
            CanariFirebaseMessagingService.CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Notifications de messages reçus via Canari"
            enableVibration(true)
        }
        manager.createNotificationChannel(channel)
    }

    private fun processPendingPushSecret() {
        try {
            val file = File(filesDir, "pending_push_secret.txt")
            if (!file.exists()) return
            val secret = file.readText().trim()
            if (secret.isNotEmpty()) {
                PushSecretKeystore.store(this, secret)
            }
            // Overwrite before delete to prevent recovery from filesystem
            file.writeBytes(ByteArray(secret.length) { 0 })
            file.delete()
        } catch (_: Exception) { }
    }
}
