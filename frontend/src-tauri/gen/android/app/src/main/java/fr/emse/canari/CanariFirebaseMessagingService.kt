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
import android.os.PowerManager
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

        const val PREFS_NAME    = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"

        private val notificationIdCounter = java.util.concurrent.atomic.AtomicInteger(0)

        /** Durée de validité du cache fichier avatar : 24 heures. */
        private const val AVATAR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000L

        /** Verrou protégeant les écritures concurrentes dans fcm_message_cache.ndjson. */
        private val CACHE_LOCK = java.util.concurrent.locks.ReentrantLock()

        /**
         * Verrou protégeant getStableNotifId : lecture-incrémentation-écriture du compteur
         * SharedPreferences n'est pas atomique, d'où la course entre threads FCM parallèles.
         */
        private val NOTIF_ID_LOCK = Any()

        /** Clé de groupe Android pour regrouper les notifications de messages sous une seule ligne. */
        private const val GROUP_KEY_MESSAGES = "canari_messages_group"

        /** ID réservé pour la notification de résumé du groupe (ne doit pas collisionner avec getStableNotifId). */
        private const val GROUP_SUMMARY_ID   = 9999
    }

    // Retourne un JSON : {"ok":true,"text":"...","messageId":"...","sentAt":123,"type":"text|reply|media","replyTo":null,"mediaKind":null}
    // ou {"ok":false} en cas d'échec.
    external fun nativeDecryptMessage(
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        ciphertext: ByteArray
    ): String

    /**
     * Crée un paquet Welcome MLS pour [keyPackageB64] dans le groupe [groupId].
     * Sauvegarde l'état MLS mis à jour dans {filesDir}/mls.bin.
     * Retourne JSON : {"ok":true,"welcome":"<b64>","ratchetTree":"<b64>|null","commit":"<b64>"}
     * ou {"ok":false,"error":"..."}.
     */
    external fun nativeCreateWelcomeBackground(
        filesDir: String,
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        keyPackageB64: String,
    ): String

    /** Résultat structuré du déchiffrement MLS, extrait depuis le JSON retourné par Rust. */
    data class DecryptedMessage(
        val text: String,
        val messageId: String,
        val sentAt: Long,
        val type: String,                 // "text" | "reply" | "media"
        val replyTo: JSONObject?,
        val mediaKind: String?,           // "image" | "video" | "audio" | "file" | null
    )

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

        // Demande de bienvenue en attente : un pair hors-ligne a besoin d'être ajouté à un groupe.
        // On traite directement en arrière-plan (JNI + HTTP PushSecret) sans ouvrir la WebView.
        if (msgType == "welcome_request_pending") {
            val groupId       = data["groupId"] ?: ""
            val requesterUser = data["requesterUserId"] ?: ""
            val requesterDev  = data["requesterDeviceId"] ?: ""
            Log.d(TAG, "welcome_request_pending → groupId=$groupId requester=$requesterUser:$requesterDev - traitement background complet")
            if (groupId.isEmpty() || requesterUser.isEmpty() || requesterDev.isEmpty()) {
                Log.e(TAG, "welcome_request_pending: champs manquants → abandon")
                return
            }
            Thread {
                val _wl = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:welcome_bg")
                _wl.acquire(90_000L)
                try {
                    processWelcomeRequestBackground(groupId, requesterUser, requesterDev)
                } finally {
                    if (_wl.isHeld) _wl.release()
                }
            }.start()
            return
        }

        // Paquet Welcome MLS : les bytes sont dans la file backend, pas déchiffrables via
        // nativeDecryptMessage (format différent). On enqueue le worker silencieusement sans
        // tenter un déchiffrement voué à l'échec.
        if (data["isWelcome"] == "true") {
            val groupId = data["groupId"] ?: ""
            Log.d(TAG, "isWelcome=true → groupId=$groupId - enqueue worker, no notification")
            val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                .build()
            WorkManager.getInstance(this).enqueue(workRequest)
            return
        }

        // Notifications sociales et rappels de formulaires : pas de déchiffrement MLS
        if (msgType == "social" || msgType == "form_reminder") {
            val title    = data["title"]  ?: "Canari"
            val body     = data["body"]   ?: ""
            // deepLink explicite (réactions aux messages) > deepLink construit depuis postId/formId
            val postId   = data["postId"] ?: ""
            val formId   = data["formId"] ?: ""
            val deepLink = when {
                data["deepLink"]?.isNotEmpty() == true -> data["deepLink"]!!
                postId.isNotEmpty()                    -> "fr.emse.canari://post/$postId"
                formId.isNotEmpty()                    -> "fr.emse.canari://form/$formId"
                else                                   -> "fr.emse.canari://posts"
            }
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
        // Le thread tourne en parallèle - onMessageReceived retourne immédiatement
        // (non-bloquant pour FCM, qui peut traiter le message suivant sans attendre).
        // MLS_LOCK dans tryDecrypt garantit qu'un seul thread écrit mls.bin à la fois.
        Thread {
            val _wl = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:fcm_decrypt")
            _wl.acquire(30_000L)
            try {
                val groupId         = data["groupId"] ?: ""
                val groupName       = data["groupName"]?.takeIf { it.isNotEmpty() } ?: ""
                val senderName      = data["senderName"]?.takeIf { it.isNotEmpty() } ?: ""
                val senderId        = data["senderId"] ?: ""
                val queuedMessageId = data["queuedMessageId"]
                val inlineProto     = data["proto"]?.takeIf { it.isNotEmpty() }

                Log.d(TAG, "thread: groupId=$groupId senderName=$senderName silent=$silent inlineProto=${inlineProto != null}")

                val decrypted = tryDecrypt(queuedMessageId, groupId, inlineProto)
                val body: String = decrypted?.text
                    ?: run {
                        // Déchiffrement échoué : groupe probablement pas encore dans l'état MLS.
                        // On enqueue le worker pour réessayer au prochain cycle.
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
                    Log.d(TAG, "FCM silencieux → MLS state mis à jour, pas de notification affichée")
                    return@Thread
                }

                if (decrypted != null) {
                    writeFcmCache(groupId, senderId, senderName, decrypted)
                }

                val avatarBitmap = if (senderId.isNotEmpty()) fetchAvatar(senderId) else null
                val largeIcon    = avatarBitmap ?: generateInitialsBitmap(senderName)
                Log.d(TAG, "showNotification: groupId=$groupId senderName=$senderName body=${body.take(60)} hasAvatar=${avatarBitmap != null}")
                showNotification(senderName, groupName, body, largeIcon, groupId)
            } finally {
                if (_wl.isHeld) _wl.release()
            }
        }.start()
    }

    // ── Traitement background Welcome request ────────────────────────────────

    /**
     * Traite une `welcome_request_pending` reçue via FCM quand l'app est tuée.
     * Séquence : acquiert le verrou Redis → fetche le key package → crée le Welcome
     * via JNI → envoie Welcome+commit au backend → libère le verrou.
     * Tout se passe sous [MLS_LOCK] pour éviter les accès concurrents à mls.bin.
     */
    private fun processWelcomeRequestBackground(
        groupId: String,
        requesterUserId: String,
        requesterDeviceId: String,
    ) {
        if (!MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)) {
            Log.w(TAG, "processWelcomeRequestBackground: MlsStateLock non acquis → abandon")
            return
        }
        try {
            val ctx = loadPushContext()
            if (ctx == null) {
                Log.e(TAG, "processWelcomeRequestBackground: push_context.json absent → abandon")
                return
            }
            val stateBytes = loadMlsState()
            if (stateBytes == null) {
                Log.e(TAG, "processWelcomeRequestBackground: mls.bin absent → abandon")
                return
            }
            val secret = PushSecretKeystore.retrieve(this)
            if (secret == null) {
                Log.e(TAG, "processWelcomeRequestBackground: pushSecret absent → abandon")
                return
            }

            // 1. Acquérir le verrou Redis add-lock (max 3 tentatives)
            var lockAcquired = false
            for (attempt in 0..2) {
                lockAcquired = acquireAddLock(ctx, secret, groupId)
                if (lockAcquired) break
                Log.w(TAG, "processWelcomeRequestBackground: verrou non acquis (tentative ${attempt + 1}/3)")
                if (attempt < 2) Thread.sleep(2_000)
            }
            if (!lockAcquired) {
                Log.w(TAG, "processWelcomeRequestBackground: impossible d'acquérir le verrou pour group=$groupId → abandon")
                return
            }
            Log.d(TAG, "processWelcomeRequestBackground: verrou acquis pour group=$groupId")

            try {
                // 2. Récupérer le key package du requester
                val keyPackage = fetchKeyPackage(ctx, secret, requesterUserId, requesterDeviceId)
                if (keyPackage == null) {
                    Log.e(TAG, "processWelcomeRequestBackground: keyPackage introuvable pour $requesterUserId:$requesterDeviceId → abandon")
                    return
                }
                Log.d(TAG, "processWelcomeRequestBackground: keyPackage fetched (${keyPackage.length} chars)")

                // 3. Créer le Welcome via Rust JNI
                val filesDir = this.filesDir.parentFile!!.absolutePath
                val jsonStr = nativeCreateWelcomeBackground(
                    filesDir, stateBytes, ctx.pin, ctx.userId, ctx.deviceId,
                    groupId, keyPackage,
                )
                val result = JSONObject(jsonStr)
                if (!result.optBoolean("ok", false)) {
                    Log.e(TAG, "processWelcomeRequestBackground: nativeCreateWelcomeBackground échoué: ${result.optString("error")}")
                    return
                }
                val welcomePayload  = result.getString("welcome")
                val ratchetTree     = result.optString("ratchetTree").takeIf { it.isNotEmpty() && it != "null" }
                val commitPayload   = result.getString("commit")
                Log.d(TAG, "processWelcomeRequestBackground: Welcome créé, commit=${commitPayload.take(16)}…")

                // 4. Envoyer Welcome + commit au backend
                val sent = sendWelcomeAndCommit(
                    ctx, secret, groupId,
                    requesterUserId, requesterDeviceId,
                    welcomePayload, ratchetTree, commitPayload,
                )
                if (sent) {
                    Log.d(TAG, "processWelcomeRequestBackground: ✓ Welcome envoyé pour group=$groupId target=$requesterUserId:$requesterDeviceId")
                } else {
                    Log.e(TAG, "processWelcomeRequestBackground: sendWelcomeAndCommit échoué pour group=$groupId")
                }
            } finally {
                // 5. Libérer le verrou dans tous les cas
                releaseAddLock(ctx, secret, groupId)
                Log.d(TAG, "processWelcomeRequestBackground: verrou libéré pour group=$groupId")
            }
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

    /** Acquiert le verrou Redis add-lock via l'endpoint PushSecret. Retourne true si acquis. */
    private fun acquireAddLock(ctx: PushContext, secret: String, groupId: String): Boolean {
        return try {
            val url = URL("${ctx.baseUrl}/api/mls/push/acquire-add-lock")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "POST"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                Log.d(TAG, "acquireAddLock: HTTP $code group=$groupId")
                if (code == 201) JSONObject(text).optBoolean("acquired", false) else false
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "acquireAddLock: exception: ${e.message}")
            false
        }
    }

    /** Libère le verrou Redis add-lock via l'endpoint PushSecret. */
    private fun releaseAddLock(ctx: PushContext, secret: String, groupId: String) {
        try {
            val url  = URL("${ctx.baseUrl}/api/mls/push/release-add-lock")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "DELETE"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                Log.d(TAG, "releaseAddLock: HTTP $code group=$groupId")
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "releaseAddLock: exception: ${e.message}")
        }
    }

    /**
     * Récupère le KeyPackage MLS (base64) d'un device cible via l'endpoint PushSecret.
     * Retourne null en cas d'échec.
     */
    private fun fetchKeyPackage(
        ctx: PushContext,
        secret: String,
        targetUserId: String,
        targetDeviceId: String,
    ): String? {
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/key-package" +
                "?requesterId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}" +
                "&targetUserId=${java.net.URLEncoder.encode(targetUserId, "UTF-8")}" +
                "&targetDeviceId=${java.net.URLEncoder.encode(targetDeviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
            }
            try {
                val code = conn.responseCode
                if (code != 200) {
                    Log.e(TAG, "fetchKeyPackage: HTTP $code target=$targetUserId:$targetDeviceId")
                    null
                } else {
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    JSONObject(text).optString("keyPackage").takeIf { it.isNotEmpty() }
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "fetchKeyPackage: exception: ${e.message}")
            null
        }
    }

    /**
     * Envoie le Welcome au device cible et diffuse le commit à tous les membres du groupe.
     * Retourne true si l'appel HTTP a réussi (HTTP 201).
     */
    private fun sendWelcomeAndCommit(
        ctx: PushContext,
        secret: String,
        groupId: String,
        targetUserId: String,
        targetDeviceId: String,
        welcomePayload: String,
        ratchetTree: String?,
        commitPayload: String,
    ): Boolean {
        return try {
            val url = URL("${ctx.baseUrl}/api/mls/push/send-welcome-and-commit")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
                put("targetUserId", targetUserId)
                put("targetDeviceId", targetDeviceId)
                put("welcomePayload", welcomePayload)
                put("ratchetTreePayload", if (ratchetTree != null) ratchetTree else JSONObject.NULL)
                put("commitPayload", commitPayload)
            }.toString()
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout    = 10_000
                requestMethod  = "POST"
                doOutput       = true
                setRequestProperty("Authorization", "PushSecret $secret")
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                Log.d(TAG, "sendWelcomeAndCommit: HTTP $code group=$groupId target=$targetUserId:$targetDeviceId")
                code == 201
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "sendWelcomeAndCommit: exception: ${e.message}")
            false
        }
    }

    // ── Déchiffrement MLS ─────────────────────────────────────────────────────

    /**
     * Tente de déchiffrer un message MLS en mode exclusif (MLS_LOCK).
     * Le verrou garantit qu'un seul thread FCM accède à mls.bin à la fois,
     * même si plusieurs notifications arrivent en rafale.
     */
    private fun tryDecrypt(
        queuedMessageId: String?,
        groupId: String,
        inlineProto: String?,
    ): DecryptedMessage? {
        if (queuedMessageId == null) {
            Log.w(TAG, "tryDecrypt: queuedMessageId absent → abandon")
            return null
        }
        if (!MlsStateLock.LOCK.tryLock(8, java.util.concurrent.TimeUnit.SECONDS)) {
            Log.w(TAG, "tryDecrypt: MlsStateLock non acquis après 8s → abandon (un autre thread déchiffre)")
            return null
        }
        try {
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
        } finally {
            MlsStateLock.LOCK.unlock()
        }
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
        try {
            val code = conn.responseCode
            if (code != 200) {
                Log.e(TAG, "doFetchProto: HTTP $code")
                return null
            }
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            val proto = JSONObject(text).optString("proto").takeIf { it.isNotEmpty() }
            Log.d(TAG, "doFetchProto: proto reçu=${proto != null} (${proto?.length ?: 0} chars)")
            return proto
        } finally {
            conn.disconnect()
        }
    }

    /** Parse le JSON retourné par nativeDecryptMessage et retourne un DecryptedMessage structuré. */
    private fun decryptProto(
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        protoB64: String,
    ): DecryptedMessage? {
        return try {
            val cipherBytes = Base64.decode(protoB64, Base64.DEFAULT)
            val jsonStr = nativeDecryptMessage(stateBytes, pin, userId, deviceId, groupId, cipherBytes)
            val json = JSONObject(jsonStr)
            if (!json.optBoolean("ok", false)) {
                Log.w(TAG, "decryptProto: ok=false → déchiffrement échoué")
                return null
            }
            val text = json.optString("text").takeIf { it.isNotEmpty() } ?: return null
            Log.d(TAG, "decryptProto: succès type=${json.optString("type")} → \"${text.take(60)}\"")
            DecryptedMessage(
                text      = text.take(200),
                messageId = json.optString("messageId"),
                sentAt    = json.optLong("sentAt", System.currentTimeMillis()),
                type      = json.optString("type", "text"),
                replyTo   = json.optJSONObject("replyTo"),
                mediaKind = json.optString("mediaKind").takeIf { it.isNotEmpty() },
            )
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "decryptProto: librairie native non chargée: ${e.message}")
            null
        } catch (e: Exception) {
            Log.e(TAG, "decryptProto: exception: ${e.message}")
            null
        }
    }

    /**
     * Écrit une entrée dans fcm_message_cache.ndjson pour que l'app puisse
     * pré-injecter le message dans IndexedDB au boot (avant la sync MLS).
     * Le fichier est en append : plusieurs messages peuvent s'accumuler entre deux ouvertures.
     */
    private fun writeFcmCache(
        groupId: String,
        senderId: String,
        senderName: String,
        msg: DecryptedMessage,
    ) {
        if (msg.messageId.isEmpty()) {
            Log.w(TAG, "writeFcmCache: messageId vide → entrée ignorée")
            return
        }
        try {
            val entry = JSONObject().apply {
                put("groupId",    groupId)
                put("messageId",  msg.messageId)
                put("senderId",   senderId)
                put("senderName", senderName)
                put("content",    msg.text)
                put("timestamp",  msg.sentAt)
                put("type",       msg.type)
                msg.replyTo?.let { put("replyTo", it) }
                msg.mediaKind?.let { put("mediaKind", it) }
            }
            val file = File(filesDir.parentFile, "fcm_message_cache.ndjson")
            CACHE_LOCK.lock()
            try {
                file.appendText(entry.toString() + "\n")
            } finally {
                CACHE_LOCK.unlock()
            }
            Log.d(TAG, "writeFcmCache: ✓ messageId=${msg.messageId.take(8)} groupId=${groupId.take(8)}")
        } catch (e: Exception) {
            Log.w(TAG, "writeFcmCache: échec: ${e.message}")
        }
    }

    // ── Avatar ────────────────────────────────────────────────────────────────

    /** Fichier de cache pour l'avatar d'un userId (nom sécurisé pour le filesystem). */
    private fun avatarCacheFile(userId: String): File {
        val safeId = userId.replace(Regex("[^a-zA-Z0-9_-]"), "_").take(40)
        return File(filesDir.parentFile, "avatar_$safeId.jpg")
    }

    /**
     * Télécharge l'avatar de l'expéditeur, avec cache fichier 24h.
     * Le cache évite la requête HTTP quand l'app est en arrière-plan et que
     * le réseau est lent ou que PushSecretKeystore.retrieve() est instable.
     */
    private fun fetchAvatar(userId: String): Bitmap? {
        // 1. Lire le cache fichier si récent (< 24h) - pas besoin du Keystore ni du réseau
        val cacheFile = avatarCacheFile(userId)
        val now = System.currentTimeMillis()
        if (cacheFile.exists() && (now - cacheFile.lastModified()) < AVATAR_CACHE_MAX_AGE_MS) {
            BitmapFactory.decodeFile(cacheFile.absolutePath)?.let { bmp ->
                Log.d(TAG, "fetchAvatar: depuis cache pour ${userId.take(8)}")
                return circleCrop(bmp)
            }
        }

        // 2. Fetch HTTP (app au premier plan ou cache expiré)
        val ctx    = loadPushContext() ?: return null
        val secret = PushSecretKeystore.retrieve(this) ?: return null
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/avatar/${java.net.URLEncoder.encode(userId, "UTF-8")}" +
                "?requesterId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
            )
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 5_000
                readTimeout    = 5_000
                requestMethod  = "GET"
                setRequestProperty("Authorization", "PushSecret $secret")
                instanceFollowRedirects = true
            }
            try {
                val code = conn.responseCode
                if (code == 200) {
                    val bytes = conn.inputStream.readBytes()
                    // Sauvegarder en cache pour les prochaines notifications
                    try {
                        cacheFile.writeBytes(bytes)
                        Log.d(TAG, "fetchAvatar: avatar mis en cache pour ${userId.take(8)}")
                    } catch (e: Exception) {
                        Log.w(TAG, "fetchAvatar: impossible de sauvegarder le cache: ${e.message}")
                    }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { circleCrop(it) }
                } else {
                    Log.d(TAG, "fetchAvatar: HTTP $code pour $userId → fallback initiales")
                    null
                }
            } finally {
                conn.disconnect()
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
     * Retourne un ID de notification stable et unique pour [groupId], persisté en
     * SharedPreferences. Évite les collisions de groupId.hashCode() entre conversations.
     */
    private fun getStableNotifId(groupId: String): Int = synchronized(NOTIF_ID_LOCK) {
        val prefs = getSharedPreferences("canari_notif_ids", Context.MODE_PRIVATE)
        val existing = prefs.getInt(groupId, -1)
        if (existing != -1) return@synchronized existing
        val next = prefs.getInt("__counter__", 1000)
        // commit() garantit que le compteur est incrémenté avant la sortie du bloc synchronized.
        prefs.edit().putInt(groupId, next).putInt("__counter__", next + 1).commit()
        next
    }

    /**
     * Affiche (ou met à jour) une notification pour un message MLS (DM ou groupe).
     * Un seul ID stable par conversation : chaque nouveau message écrase la notification
     * précédente au lieu d'en empiler une nouvelle.
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

        // ID stable par conversation : notify() avec le même ID met à jour la notif existante
        val notifId = if (groupId.isNotEmpty()) getStableNotifId(groupId) else 0

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse("fr.emse.canari://chat/$groupId"))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notifTitle)
            .setContentText(notifBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notifBody))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setLargeIcon(largeIcon)
            .setGroup(GROUP_KEY_MESSAGES)
            .build()

        Log.d(TAG, "showNotification: notifId=$notifId title=$notifTitle body=${notifBody.take(40)}")
        manager.notify(notifId, notif)

        // La notification de résumé est obligatoire sur Android 7+ pour que le groupement
        // fonctionne : sans elle, les notifications individuelles ne sont pas regroupées.
        val summary = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setGroup(GROUP_KEY_MESSAGES)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .build()
        manager.notify(GROUP_SUMMARY_ID, summary)
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
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
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
