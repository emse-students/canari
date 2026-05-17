package fr.emse.canari

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
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
        const val TAG           = "CanariFCM"
        const val CHANNEL_ID    = "canari_messages"
        const val CHANNEL_NAME  = "Messages Canari"
        const val PREFS_NAME    = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"
        private val notificationIdCounter = java.util.concurrent.atomic.AtomicInteger(0)
    }

    external fun nativeDecryptMessage(
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        ciphertext: ByteArray
    ): String

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "onNewToken: nouveau token FCM reçu")
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_FCM_TOKEN, token).apply()
        try {
            File(filesDir.parentFile, "fcm_token.txt").writeText(token)
        } catch (e: Exception) {
            Log.w(TAG, "onNewToken: impossible d'écrire fcm_token.txt: ${e.message}")
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data
        Log.d(TAG, "onMessageReceived: action=${data["action"]} groupId=${data["groupId"]} queuedMessageId=${data["queuedMessageId"]} hasInlineProto=${!data["proto"].isNullOrEmpty()}")

        val msgType = data["type"]
        if (msgType == "social" || msgType == "form_reminder") {
            val title  = data["title"]  ?: "Canari"
            val body   = data["body"]   ?: ""
            val postId = data["postId"] ?: ""
            val formId = data["formId"] ?: ""
            val deepLink = when {
                postId.isNotEmpty() -> "fr.emse.canari://post/$postId"
                formId.isNotEmpty() -> "fr.emse.canari://form/$formId"
                else                -> "fr.emse.canari://posts"
            }
            showSimpleNotification(title, body, deepLink)
            return
        }

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
            if (!data.containsKey("groupId")) {
                Log.d(TAG, "process_queue sans groupId → pas de notification à afficher")
                return
            }
        }

        val thread = Thread {
            val groupId         = data["groupId"] ?: ""
            val groupName       = data["groupName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderName      = data["senderName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderId        = data["senderId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto     = data["proto"]?.takeIf { it.isNotEmpty() }

            Log.d(TAG, "Déchiffrement: groupId=$groupId queuedMessageId=$queuedMessageId inlineProto=${inlineProto != null}")
            val body = tryDecrypt(queuedMessageId, groupId, inlineProto)
                ?: run {
                    // Group not yet in MLS state (Welcome not processed) — enqueue worker
                    // so the message is available without a full app restart.
                    if (!queuedMessageId.isNullOrEmpty()) {
                        val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                            .build()
                        WorkManager.getInstance(this@CanariFirebaseMessagingService).enqueue(workRequest)
                        Log.d(TAG, "Déchiffrement échoué → MlsBackgroundWorker enqueued")
                    }
                    buildFallbackText(senderName).also { Log.w(TAG, "Déchiffrement échoué → fallback: $it") }
                }

            val avatarBitmap = if (senderId.isNotEmpty()) fetchAvatar(senderId) else null

            Log.d(TAG, "showNotification: title=${if (groupName.isNotEmpty() && groupName != senderName) groupName else senderName} body=${body.take(60)}")
            showNotification(senderName, groupName, body, avatarBitmap, data)
        }
        thread.start()
        thread.join(10_000)
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

        return decryptProto(stateBytes, ctx.pin, ctx.userId, ctx.deviceId, groupId, protoB64)
    }

    private data class PushContext(
        val pin: String,
        val userId: String,
        val deviceId: String,
        val baseUrl: String,
    )

    private fun loadPushContext(): PushContext? {
        val file = File(filesDir.parentFile, "push_context.json")
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
        val file = File(filesDir.parentFile, "mls.bin")
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
        userId: String,
        deviceId: String,
        groupId: String,
        protoB64: String,
    ): String? = try {
        val cipherBytes = Base64.decode(protoB64, Base64.DEFAULT)
        val text = nativeDecryptMessage(stateBytes, pin, userId, deviceId, groupId, cipherBytes)
        Log.d(TAG, "decryptProto: succès → \"${text.take(60)}\"")
        text.takeIf { it.isNotEmpty() }?.take(200)
    } catch (e: UnsatisfiedLinkError) {
        Log.e(TAG, "decryptProto: librairie native non chargée: ${e.message}")
        null
    } catch (e: Exception) {
        Log.e(TAG, "decryptProto: exception: ${e.message}")
        null
    }

    private fun fetchAvatar(userId: String): Bitmap? {
        val ctx = loadPushContext() ?: return null
        val secret = PushSecretKeystore.retrieve(this) ?: return null
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/avatar/${java.net.URLEncoder.encode(userId, "UTF-8")}" +
                "?requesterId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 2_000
                readTimeout    = 2_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
                instanceFollowRedirects = true
            }
            if (conn.responseCode == 200) {
                val bmp = BitmapFactory.decodeStream(conn.inputStream)
                conn.disconnect()
                bmp?.let { circleCrop(it) }
            } else {
                Log.d(TAG, "fetchAvatar: HTTP ${conn.responseCode} pour $userId")
                conn.disconnect()
                null
            }
        } catch (e: Exception) {
            Log.d(TAG, "fetchAvatar: ${e.message}")
            null
        }
    }

    private fun circleCrop(src: Bitmap): Bitmap {
        val size = minOf(src.width, src.height)
        val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        val dx = (size - src.width) / 2f
        val dy = (size - src.height) / 2f
        canvas.drawBitmap(src, dx, dy, paint)
        src.recycle()
        return output
    }

    private fun buildFallbackText(senderName: String): String =
        if (senderName.isNotEmpty()) "Nouveau message de $senderName"
        else "Vous avez reçu un message chiffré"

    private fun showNotification(
        senderName: String,
        groupName: String,
        body: String,
        largeIcon: Bitmap?,
        data: Map<String, String>,
    ) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannel(manager)

        val isGroup    = groupName.isNotEmpty() && groupName != senderName
        val notifTitle = if (isGroup) groupName else senderName.ifEmpty { "Canari" }
        val notifBody  = if (isGroup && senderName.isNotEmpty()) "$senderName: $body" else body

        val groupId = data["groupId"] ?: ""
        val notifId = if (groupId.isNotEmpty()) groupId.hashCode() else notificationIdCounter.incrementAndGet()

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse("fr.emse.canari://chat/$groupId"))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            data.forEach { (k, v) -> putExtra(k, v) }
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            notifId,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notifTitle)
            .setContentText(notifBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notifBody))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
        if (largeIcon != null) builder.setLargeIcon(largeIcon)

        manager.notify(notifId, builder.build())
    }

    private fun showSimpleNotification(title: String, body: String, deepLink: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannel(manager)
        val notifId = notificationIdCounter.incrementAndGet()
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse(deepLink))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(notifId, notification)
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
