package fr.emse.canari

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Service FCM (Firebase Cloud Messaging) pour Canari.
 *
 * Responsabilités :
 *  - Recevoir les messages push en foreground et background
 *  - Afficher une notification locale Android
 *  - Transmettre le token FCM au backend Canari (via SharedPreferences pour
 *    que la WebView puisse le lire au prochain démarrage)
 *
 * Pour que le push fonctionne :
 *  1. Remplacer google-services.json par votre fichier réel depuis la console Firebase
 *  2. Envoyer le token FCM (récupéré dans onNewToken) à votre backend
 *  3. Depuis votre backend, envoyer un message FCM avec la structure :
 *     {
 *       "to": "<fcm_token>",
 *       "notification": { "title": "...", "body": "..." },
 *       "data": { "channelId": "...", "senderId": "...", "messageId": "..." }
 *     }
 */
class CanariFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        const val CHANNEL_ID = "canari_messages"
        const val CHANNEL_NAME = "Messages Canari"
        const val PREFS_NAME = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"
    }

    /**
     * Appelé quand un nouveau token FCM est généré (premier démarrage ou refresh).
     * Stocke le token localement pour que le frontend puisse l'envoyer au backend.
     */
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // Stocke le token dans SharedPreferences — le frontend JS le lit au démarrage
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_FCM_TOKEN, token).apply()
    }

    /**
     * Appelé quand un message FCM est reçu.
     * Si l'app est en foreground : affiche une notification locale.
     * Si l'app est en background/fermée : Android l'affiche automatiquement
     *   depuis la section "notification" du payload FCM.
     */
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)

        val title = remoteMessage.notification?.title
            ?: remoteMessage.data["title"]
            ?: "Canari"
        val body = remoteMessage.notification?.body
            ?: remoteMessage.data["body"]
            ?: "Nouveau message"

        showLocalNotification(title, body, remoteMessage.data)
    }

    // ──────────────────────────────────────────────────────────────
    // Notification locale
    // ──────────────────────────────────────────────────────────────

    private fun showLocalNotification(
        title: String,
        body: String,
        data: Map<String, String>
    ) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannel(manager)

        // Intention : ouvrir MainActivity au tap
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            // Transmet les données du message à la WebView via Intent extras
            data.forEach { (k, v) -> putExtra(k, v) }
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            System.currentTimeMillis().toInt(),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .build()

        manager.notify(System.currentTimeMillis().toInt(), notification)
    }

    private fun ensureNotificationChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val existing = manager.getNotificationChannel(CHANNEL_ID)
            if (existing == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Notifications de messages reçus via Canari"
                    enableVibration(true)
                }
                manager.createNotificationChannel(channel)
            }
        }
    }
}
