package fr.emse.canari

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Service FCM Canari – affiche le contenu réel du message chiffré dans la notification.
 *
 * Flux pour une notification push (destinataire hors-ligne) :
 *  1. onMessageReceived() reçoit un payload data-only (pas de clé "notification").
 *  2. Un thread de fond lit le PIN + contexte depuis SharedPreferences (canari_prefs).
 *  3. Il charge l'état MLS chiffré depuis {filesDir}/mls_push.bin.
 *  4. Il récupère le message chiffré depuis le backend (GET /api/mls-api/messages/…).
 *  5. Il appelle nativeDecryptMessage() (JNI Rust) pour déchiffrer et extraire le texte.
 *  6. Il affiche la notification avec le texte, ou un fallback si le déchiffrement échoue.
 */
class CanariFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        const val CHANNEL_ID    = "canari_messages"
        const val CHANNEL_NAME  = "Messages Canari"
        const val PREFS_NAME    = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"
    }

    // ── Pont JNI vers la bibliothèque Rust mines_app_lib ──────────────────────
    // La bibliothèque est chargée par CanariApplication.onCreate().
    external fun nativeDecryptMessage(
        stateBytes: ByteArray,
        pin: String,
        groupId: String,
        ciphertext: ByteArray
    ): String

    // ── Cycle de vie FCM ──────────────────────────────────────────────────────

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_FCM_TOKEN, token).apply()
        // Également accessible par le backend Rust via get_fcm_token (lecture fichier).
        try { File(filesDir, "fcm_token.txt").writeText(token) } catch (_: Exception) { }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data

        // Résoudre le contenu dans un thread de fond (appel réseau interdit sur le
        // thread principal) puis afficher la notification depuis ce même thread.
        val thread = Thread {
            val groupId         = data["groupId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val body = tryDecryptContent(queuedMessageId, groupId)
                ?: "Ouvrir l'application pour voir le contenu du message"
            showNotification("Canari", body, data)
        }
        thread.start()
        thread.join(8_000) // Attendre 8 s max pour ne pas bloquer le processus Firebase
    }

    // ── Déchiffrement ─────────────────────────────────────────────────────────

    private fun tryDecryptContent(queuedMessageId: String?, groupId: String): String? {
        if (queuedMessageId == null) return null

        // Lecture du contexte de session depuis le fichier JSON écrit par store_push_context.
        val contextFile = File(filesDir, "push_context.json")
        if (!contextFile.exists()) return null
        val ctxJson = try {
            org.json.JSONObject(contextFile.readText())
        } catch (_: Exception) { return null }
        val pin     = ctxJson.optString("pin").takeIf     { it.isNotEmpty() } ?: return null
        val userId  = ctxJson.optString("userId").takeIf  { it.isNotEmpty() } ?: return null
        val devId   = ctxJson.optString("deviceId").takeIf{ it.isNotEmpty() } ?: return null
        val baseUrl = ctxJson.optString("baseUrl").takeIf { it.isNotEmpty() } ?: return null

        val stateFile = File(filesDir, "mls_push.bin")
        if (!stateFile.exists()) return null
        val stateBytes = stateFile.readBytes()

        return try {
            // Récupère la liste des messages en attente depuis le backend
            val url  = URL("$baseUrl/api/mls-api/messages/$userId/$devId")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "GET"
            }
            val responseText = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()

            // Trouve le message correspondant
            val messages = JSONArray(responseText)
            var protoB64: String? = null
            for (i in 0 until messages.length()) {
                val msg = messages.getJSONObject(i)
                if (msg.optString("id") == queuedMessageId) {
                    // Ne pas déchiffrer les messages de structure MLS (welcome / commit)
                    if (msg.optBoolean("isWelcome", false) ||
                        msg.optBoolean("isCommit",  false)) return null
                    protoB64 = msg.optString("proto").takeIf { it.isNotEmpty() }
                    break
                }
            }
            if (protoB64 == null) return null

            // Déchiffrement MLS via la bibliothèque Rust
            val cipherBytes = Base64.decode(protoB64, Base64.DEFAULT)
            val text = nativeDecryptMessage(stateBytes, pin, groupId, cipherBytes)
            text.takeIf { it.isNotEmpty() }?.take(200) // Limite la longueur de la notif
        } catch (_: Exception) {
            null // Toute erreur réseau / JNI → fallback générique
        }
    }

    // ── Affichage de la notification locale ───────────────────────────────────

    private fun showNotification(title: String, body: String, data: Map<String, String>) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannel(manager)

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
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
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
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
