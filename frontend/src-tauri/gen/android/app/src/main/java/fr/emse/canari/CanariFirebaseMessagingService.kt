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
import android.media.AudioAttributes
import android.media.RingtoneManager
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
        const val TAG = "CanariFCM"

        /** Canal haute priorité : DMs et messages de groupe (son + vibration). */
        const val CHANNEL_MESSAGES = "canari_messages"

        /** Canal priorité normale : réactions/commentaires sur les posts (silencieux). */
        const val CHANNEL_SOCIAL   = "canari_social"

        /** Canal priorité normale : rappels de formulaires (silencieux). */
        const val CHANNEL_FORMS    = "canari_forms"

        // Nom legacy conservé pour la compatibilité avec les constantes existantes
        const val CHANNEL_ID   = CHANNEL_MESSAGES
        const val CHANNEL_NAME = "Messages Canari"

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
        Log.d(TAG, "onMessageReceived: type=${data["type"]} action=${data["action"]} groupId=${data["groupId"]} queuedMessageId=${data["queuedMessageId"]} hasInlineProto=${!data["proto"].isNullOrEmpty()}")

        val msgType = data["type"]

        // Notifications sociales et rappels de formulaires : pas de déchiffrement MLS
        if (msgType == "social" || msgType == "form_reminder") {
            val title    = data["title"]  ?: "Canari"
            val body     = data["body"]   ?: ""
            val postId   = data["postId"] ?: ""
            val formId   = data["formId"] ?: ""
            val deepLink = when {
                postId.isNotEmpty() -> "fr.emse.canari://post/$postId"
                formId.isNotEmpty() -> "fr.emse.canari://form/$formId"
                else                -> "fr.emse.canari://posts"
            }
            // Choix du canal selon le type : formulaires sur CHANNEL_FORMS, reste sur CHANNEL_SOCIAL
            val channel = if (msgType == "form_reminder") CHANNEL_FORMS else CHANNEL_SOCIAL
            Log.d(TAG, "showSimpleNotification: type=$msgType channel=$channel title=$title deepLink=$deepLink")
            showSimpleNotification(title, body, deepLink, channel)
            return
        }

        // Sync MLS en arrière-plan : déchiffre et met à jour l'état sans notification visible
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
                Log.d(TAG, "process_queue sans groupId → sync silencieux, pas de notification")
                return
            }
        }

        // Message MLS chiffré : déchiffrement dans un thread dédié (max 10s)
        val silent = data["silent"] == "true"
        val thread = Thread {
            val groupId         = data["groupId"] ?: ""
            val groupName       = data["groupName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderName      = data["senderName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderId        = data["senderId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto     = data["proto"]?.takeIf { it.isNotEmpty() }

            Log.d(TAG, "thread: groupId=$groupId senderName=$senderName silent=$silent inlineProto=${inlineProto != null}")

            val body = tryDecrypt(queuedMessageId, groupId, inlineProto)
                ?: run {
                    // Déchiffrement échoué : le groupe n'est probablement pas encore dans l'état MLS
                    // (Welcome non encore traité). On enqueue le worker pour réessayer.
                    if (!queuedMessageId.isNullOrEmpty()) {
                        val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                            .build()
                        WorkManager.getInstance(this@CanariFirebaseMessagingService).enqueue(workRequest)
                        Log.w(TAG, "Déchiffrement échoué → MlsBackgroundWorker enqueued")
                    }
                    buildFallbackText(senderName).also { Log.w(TAG, "Fallback notification: $it") }
                }

            if (silent) {
                // FCM silencieux : accusé de lecture, réaction, édition, suppression, copie propre
                Log.d(TAG, "FCM silencieux → MLS state mis à jour, pas de notification affichée")
                return@Thread
            }

            val avatarBitmap = if (senderId.isNotEmpty()) fetchAvatar(senderId) else null
            val largeIcon    = avatarBitmap ?: generateInitialsBitmap(senderName)
            Log.d(TAG, "showNotification: groupId=$groupId senderName=$senderName body=${body.take(60)} hasAvatar=${avatarBitmap != null}")
            showNotification(senderName, groupName, body, largeIcon, groupId)
        }
        thread.start()
        thread.join(10_000)
    }

    // ── Déchiffrement MLS ─────────────────────────────────────────────────────

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

    // ── Avatar ────────────────────────────────────────────────────────────────

    /** Télécharge l'avatar de l'expéditeur depuis le backend (authentifié par pushSecret). */
    private fun fetchAvatar(userId: String): Bitmap? {
        val ctx    = loadPushContext() ?: return null
        val secret = PushSecretKeystore.retrieve(this) ?: return null
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/avatar/${java.net.URLEncoder.encode(userId, "UTF-8")}" +
                "?requesterId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000   // augmenté de 2s à 5s pour les réseaux lents
                readTimeout    = 5_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
                instanceFollowRedirects = true
            }
            if (conn.responseCode == 200) {
                val bmp = BitmapFactory.decodeStream(conn.inputStream)
                conn.disconnect()
                bmp?.let { circleCrop(it) }
            } else {
                Log.d(TAG, "fetchAvatar: HTTP ${conn.responseCode} pour $userId → fallback initiales")
                conn.disconnect()
                null
            }
        } catch (e: Exception) {
            Log.d(TAG, "fetchAvatar: ${e.message} → fallback initiales")
            null
        }
    }

    /** Recadre un bitmap en cercle (pour l'icône de notification). */
    private fun circleCrop(src: Bitmap): Bitmap {
        val size   = minOf(src.width, src.height)
        val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        val paint  = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        canvas.drawBitmap(src, (size - src.width) / 2f, (size - src.height) / 2f, paint)
        src.recycle()
        return output
    }

    /** Génère un bitmap circulaire avec la première lettre du nom (fallback quand pas d'avatar). */
    private fun generateInitialsBitmap(name: String): Bitmap {
        val size   = 96
        val bmp    = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paint  = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = android.graphics.Color.parseColor("#6366f1")
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.color     = android.graphics.Color.WHITE
        paint.textSize  = size * 0.4f
        paint.textAlign = Paint.Align.CENTER
        val fm = paint.fontMetrics
        canvas.drawText(
            name.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
            size / 2f, size / 2f - (fm.ascent + fm.descent) / 2f, paint
        )
        return bmp
    }

    // ── Affichage notifications ───────────────────────────────────────────────

    /**
     * Affiche une notification pour un message MLS (DM ou groupe).
     * Utilise un stacking par conversation : chaque message a un ID unique,
     * et une notification de résumé (groupId.hashCode()) regroupe la pile.
     */
    private fun showNotification(
        senderName: String,
        groupName: String,
        body: String,
        largeIcon: Bitmap,
        groupId: String,
    ) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannels(manager)

        val isGroup    = groupName.isNotEmpty() && groupName != senderName
        val notifTitle = if (isGroup) groupName else senderName.ifEmpty { "Canari" }
        val notifBody  = if (isGroup && senderName.isNotEmpty()) "$senderName: $body" else body

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse("fr.emse.canari://chat/$groupId"))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val summaryId    = if (groupId.isNotEmpty()) groupId.hashCode() else 0
        val pendingIntent = PendingIntent.getActivity(
            this, summaryId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Notification individuelle avec ID unique (permet le stacking)
        val msgNotifId = notificationIdCounter.incrementAndGet()
        val msgNotif = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notifTitle)
            .setContentText(notifBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notifBody))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setLargeIcon(largeIcon)
            .setGroup(groupId)   // groupe Android pour le stacking par conversation
            .build()
        manager.notify(msgNotifId, msgNotif)

        // Notification de résumé : une seule par conversation, regroupe les messages individuels
        val summaryNotif = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notifTitle)
            .setContentText(notifBody)
            .setLargeIcon(largeIcon)
            .setGroup(groupId)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(summaryId, summaryNotif)
    }

    /**
     * Affiche une notification simple (social ou formulaire) sans déchiffrement MLS.
     * Le canal est choisi selon le type de notification.
     */
    private fun showSimpleNotification(title: String, body: String, deepLink: String, channel: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannels(manager)
        val notifId     = notificationIdCounter.incrementAndGet()
        val tapIntent   = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse(deepLink))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(notifId, notification)
    }

    /** Texte de repli quand le déchiffrement MLS échoue (groupe non encore initialisé). */
    private fun buildFallbackText(senderName: String): String =
        if (senderName.isNotEmpty()) "Nouveau message de $senderName"
        else "Vous avez reçu un message chiffré"

    /**
     * Crée les canaux de notification s'ils n'existent pas encore.
     * Appelé en fallback si CanariApplication.createNotificationChannels() n'a pas tourné.
     */
    private fun ensureNotificationChannels(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        if (manager.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            val audioAttrs = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build()
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_MESSAGES, "Messages Canari", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Notifications de messages reçus via Canari"
                    enableVibration(true)
                    setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audioAttrs)
                }
            )
        }

        if (manager.getNotificationChannel(CHANNEL_SOCIAL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_SOCIAL, "Activité sociale Canari", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Réactions et commentaires sur vos publications"
                    enableVibration(false)
                    setSound(null, null)
                }
            )
        }

        if (manager.getNotificationChannel(CHANNEL_FORMS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_FORMS, "Rappels de formulaires", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Rappels avant l'ouverture des formulaires"
                    enableVibration(false)
                    setSound(null, null)
                }
            )
        }
    }
}
