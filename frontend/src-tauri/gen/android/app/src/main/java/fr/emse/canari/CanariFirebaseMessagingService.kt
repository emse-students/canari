package fr.emse.canari

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import java.util.concurrent.TimeUnit
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class CanariFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        const val TAG          = "CanariFCM"
        const val CHANNEL_ID   = "canari_messages"
        const val CHANNEL_NAME = "Messages Canari"
        const val PREFS_NAME   = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"
        private val notificationIdCounter = java.util.concurrent.atomic.AtomicInteger(0)
    }

    external fun nativeDecryptMessage(
        stateBytes: ByteArray,
        pin: String,
        groupId: String,
        ciphertext: ByteArray
    ): String

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "onNewToken: nouveau token FCM reçu")
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_FCM_TOKEN, token).apply()
        // Token stored in SharedPreferences only — no plaintext file
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data
        Log.d(TAG, "onMessageReceived: action=${data["action"]} groupId=${data["groupId"]} queuedMessageId=${data["queuedMessageId"]} hasInlineProto=${!data["proto"].isNullOrEmpty()}")

        // 1. Vérifie si on doit déclencher un travail lourd (ex: envoyer un Welcome, traiter la queue)
        if (data["action"] == "process_queue") {
            Log.d(TAG, "action=process_queue → enqueue MlsBackgroundWorker")
            val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS
                )
                .build()
            WorkManager.getInstance(this).enqueue(workRequest)

            // Si c'est juste un ping de synchro (pas de message à afficher), on s'arrête là
            if (!data.containsKey("groupId")) {
                Log.d(TAG, "process_queue sans groupId → pas de notification à afficher")
                return
            }
        }

        // 2. Traitement classique d'affichage de notification
        val thread = Thread {
            val groupId         = data["groupId"] ?: ""
            val groupName       = data["groupName"]?.takeIf { it.isNotEmpty() } ?: groupId
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto     = data["proto"]?.takeIf { it.isNotEmpty() }

            Log.d(TAG, "Déchiffrement: groupId=$groupId queuedMessageId=$queuedMessageId inlineProto=${inlineProto != null}")
            val body = tryDecrypt(queuedMessageId, groupId, inlineProto)
                ?: buildFallbackText(groupName).also { Log.w(TAG, "Déchiffrement échoué → fallback: $it") }

            Log.d(TAG, "showNotification: body=${body.take(60)}")
            showNotification("Canari", body, data)
        }
        thread.start()
        thread.join(8_000)
    }

    private fun tryDecrypt(
        queuedMessageId: String?,
        groupId: String,
        inlineProto: String?,
    ): String? {
        if (queuedMessageId == null) {
            Log.w(TAG, "tryDecrypt: queuedMessageId absent → abandon")
            return null
        }
        val ctx = loadPushContext()
        if (ctx == null) {
            Log.e(TAG, "tryDecrypt: push_context.json absent ou invalide → abandon")
            return null
        }
        val stateBytes = loadMlsState()
        if (stateBytes == null) {
            Log.e(TAG, "tryDecrypt: mls.bin absent → abandon")
            return null
        }
        Log.d(TAG, "tryDecrypt: état MLS chargé (${stateBytes.size} octets), userId=${ctx.userId} deviceId=${ctx.deviceId}")

        val protoB64 = inlineProto
            ?: fetchProtoFromBackend(queuedMessageId, ctx)
                .also { if (it == null) Log.e(TAG, "tryDecrypt: fetchProtoFromBackend a échoué") }
            ?: return null

        return decryptProto(stateBytes, ctx.pin, groupId, protoB64)
    }

    private data class PushContext(
        val pin: String,
        val userId: String,
        val deviceId: String,
        val baseUrl: String,
    )

    private fun loadPushContext(): PushContext? {
        val file = File(filesDir, "push_context.json")
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

    private fun loadMlsState(): ByteArray? {
        val file = File(filesDir, "mls.bin")
        return if (file.exists()) try { file.readBytes() } catch (_: Exception) { null } else null
    }

    private fun fetchProtoFromBackend(queuedMessageId: String, ctx: PushContext): String? {
        val secret = PushSecretKeystore.retrieve(this)
        if (secret == null) {
            Log.e(TAG, "fetchProtoFromBackend: pushSecret absent du Keystore")
            return null
        }
        var lastException: Exception? = null
        repeat(2) { attempt ->
            try {
                val result = doFetchProto(queuedMessageId, ctx, secret)
                if (result != null) return result
            } catch (e: Exception) {
                lastException = e
                if (attempt == 0) Thread.sleep(1_000)
            }
        }
        Log.e(TAG, "fetchProtoFromBackend: échec après 2 tentatives: ${lastException?.message}")
        return null
    }

    private fun doFetchProto(queuedMessageId: String, ctx: PushContext, secret: String): String? {
        val url = URL(
            "${ctx.baseUrl}/api/mls/push/fetch-proto" +
                "?messageId=${java.net.URLEncoder.encode(queuedMessageId, "UTF-8")}" +
                "&userId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
        )
        Log.d(TAG, "doFetchProto: GET $url")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 5_000
            readTimeout    = 5_000
            requestMethod  = "GET"
            setRequestProperty("Authorization", "PushSecret $secret")
        }
        val code = conn.responseCode
        if (code != 200) {
            Log.e(TAG, "doFetchProto: HTTP $code")
            conn.disconnect()
            return null
        }
        val text = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()
        val proto = JSONObject(text).optString("proto").takeIf { it.isNotEmpty() }
        Log.d(TAG, "doFetchProto: proto reçu=${proto != null} (${proto?.length ?: 0} chars)")
        return proto
    }

    private fun decryptProto(
        stateBytes: ByteArray,
        pin: String,
        groupId: String,
        protoB64: String,
    ): String? = try {
        val cipherBytes = Base64.decode(protoB64, Base64.DEFAULT)
        val text = nativeDecryptMessage(stateBytes, pin, groupId, cipherBytes)
        Log.d(TAG, "decryptProto: succès → \"${text.take(60)}\"")
        text.takeIf { it.isNotEmpty() }?.take(200)
    } catch (e: UnsatisfiedLinkError) {
        Log.e(TAG, "decryptProto: librairie native non chargée: ${e.message}")
        null
    } catch (e: Exception) {
        Log.e(TAG, "decryptProto: exception: ${e.message}")
        null
    }

    private fun buildFallbackText(groupName: String): String =
        if (groupName.isNotEmpty()) "Nouveau message dans « $groupName »"
        else "Vous avez reçu un message chiffré"

    private fun showNotification(title: String, body: String, data: Map<String, String>) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannel(manager)

        val groupId = data["groupId"] ?: ""
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse("fr.emse.canari://chat/$groupId"))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            data.forEach { (k, v) -> putExtra(k, v) }
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            notificationIdCounter.incrementAndGet(),
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

        manager.notify(notificationIdCounter.incrementAndGet(), notification)
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