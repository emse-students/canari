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
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Service FCM Canari – affiche le contenu réel du message chiffré dans la notification.
 *
 * Stratégie de déchiffrement (du plus rapide au plus lent) :
 *  1. Le proto MLS est inclus inline dans le payload FCM → déchiffrement direct via JNI.
 *  2. Si le proto est absent (message trop grand), fetch HTTP avec le token stocké.
 *  3. Si JNI échoue (app "froide", lib non chargée) → fallback esthétique avec groupName.
 */
class CanariFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        const val CHANNEL_ID   = "canari_messages"
        const val CHANNEL_NAME = "Messages Canari"
        const val PREFS_NAME   = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"
    }

    // Pont JNI vers la bibliothèque Rust (chargée par CanariApplication.onCreate()).
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
        try { File(filesDir, "fcm_token.txt").writeText(token) } catch (_: Exception) { }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data

        val thread = Thread {
            val groupId         = data["groupId"] ?: ""
            val groupName       = data["groupName"]?.takeIf { it.isNotEmpty() } ?: groupId
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto     = data["proto"]?.takeIf { it.isNotEmpty() }

            val body = tryDecrypt(queuedMessageId, groupId, inlineProto)
                ?: buildFallbackText(groupName)

            showNotification("Canari", body, data)
        }
        thread.start()
        thread.join(8_000) // Firebase exige un retour sous ~10 s
    }

    // ── Déchiffrement ─────────────────────────────────────────────────────────

    private fun tryDecrypt(
        queuedMessageId: String?,
        groupId: String,
        inlineProto: String?,
    ): String? {
        if (queuedMessageId == null) return null

        val ctx = loadPushContext() ?: return null
        val stateBytes = loadMlsState() ?: return null

        // Stratégie 1 : proto inclus dans le payload FCM (cas nominal)
        val protoB64 = inlineProto
            ?: fetchProtoFromBackend(queuedMessageId, ctx) // Stratégie 2 : fetch HTTP
            ?: return null

        return decryptProto(stateBytes, ctx.pin, groupId, protoB64)
    }

    private data class PushContext(
        val pin: String,
        val userId: String,
        val deviceId: String,
        val baseUrl: String,
        val pushToken: String, // token long-lived pour l'endpoint de fetch
    )

    private fun loadPushContext(): PushContext? {
        val file = File(filesDir, "push_context.json")
        if (!file.exists()) return null
        return try {
            val j = JSONObject(file.readText())
            PushContext(
                pin       = j.optString("pin").takeIf      { it.isNotEmpty() } ?: return null,
                userId    = j.optString("userId").takeIf   { it.isNotEmpty() } ?: return null,
                deviceId  = j.optString("deviceId").takeIf { it.isNotEmpty() } ?: return null,
                baseUrl   = j.optString("baseUrl").takeIf  { it.isNotEmpty() } ?: return null,
                pushToken = j.optString("pushToken"), // vide si non renseigné (Stratégie 2 ignorée)
            )
        } catch (_: Exception) { null }
    }

    private fun loadMlsState(): ByteArray? {
        val file = File(filesDir, "mls_push.bin")
        return if (file.exists()) try { file.readBytes() } catch (_: Exception) { null } else null
    }

    /**
     * Fetch HTTP de secours quand le proto n'est pas inline (message volumineux).
     * Utilise le pushToken stocké dans push_context.json comme Bearer token.
     */
    private fun fetchProtoFromBackend(queuedMessageId: String, ctx: PushContext): String? {
        if (ctx.pushToken.isEmpty()) return null
        return try {
            val url  = URL("${ctx.baseUrl}/api/mls-api/messages/${ctx.userId}/${ctx.deviceId}")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "Bearer ${ctx.pushToken}")
            }
            if (conn.responseCode != 200) { conn.disconnect(); return null }
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()

            val messages = JSONArray(text)
            for (i in 0 until messages.length()) {
                val msg = messages.getJSONObject(i)
                if (msg.optString("id") == queuedMessageId) {
                    if (msg.optBoolean("isWelcome") || msg.optBoolean("isCommit")) return null
                    return msg.optString("proto").takeIf { it.isNotEmpty() }
                }
            }
            null
        } catch (_: Exception) { null }
    }

    /**
     * Appel JNI vers Rust. Enveloppé dans un try/catch large pour gérer :
     *  - UnsatisfiedLinkError si la lib n'est pas encore chargée (app froide)
     *  - toute exception JNI (état MLS corrompu, epoch mismatch…)
     */
    private fun decryptProto(
        stateBytes: ByteArray,
        pin: String,
        groupId: String,
        protoB64: String,
    ): String? = try {
        val cipherBytes = Base64.decode(protoB64, Base64.DEFAULT)
        val text = nativeDecryptMessage(stateBytes, pin, groupId, cipherBytes)
        text.takeIf { it.isNotEmpty() }?.take(200)
    } catch (_: UnsatisfiedLinkError) {
        // Lib Rust non chargée (service démarré à froid sans Activity) → fallback
        null
    } catch (_: Exception) {
        null
    }

    // ── Fallback ──────────────────────────────────────────────────────────────

    private fun buildFallbackText(groupName: String): String =
        if (groupName.isNotEmpty()) "Nouveau message dans « $groupName »"
        else "Vous avez reçu un message chiffré"

    // ── Notification locale ───────────────────────────────────────────────────

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            manager.getNotificationChannel(CHANNEL_ID) == null
        ) {
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
