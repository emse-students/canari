package fr.emse.canari

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
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import androidx.work.BackoffPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkRequest
import java.util.concurrent.TimeUnit
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

// Alias local : évite de renommer PushContext dans toutes les signatures de méthodes.
private typealias PushContext = MlsContextLoader.PushContext

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

        // Démarre à 10_000 pour ne pas chevaucher les IDs stables (1000–9998) ni le résumé (9999).
        private val notificationIdCounter = java.util.concurrent.atomic.AtomicInteger(10_000)

        /** Durée de validité du cache fichier avatar : 24 heures. */
        private const val AVATAR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000L

        /** Nombre maximum d'entrées conservées dans fcm_message_cache.ndjson. */
        private const val MAX_FCM_CACHE_ENTRIES = 50

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

        /** ID réservé pour la notification "messages en attente de synchro" (canal messages → auto-effacée à l'ouverture). */
        private const val PENDING_SYNC_NOTIF_ID = 9998

        /** Mirror app-privé en clair de l'outbox (écrit par le TS) drainé par l'envoi background. */
        private const val OUTBOX_PENDING_FILE = "outbox_pending.ndjson"

        /** Liste des messageId livrés en background (lue puis effacée par le TS au login). */
        private const val OUTBOX_SENT_FILE = "outbox_sent.ndjson"

        /** Nombre maximum de messages empilés dans une notification MessagingStyle par conversation. */
        private const val MAX_NOTIF_MESSAGES = 6

        /**
         * Nombre de réessais de déchiffrement quand le 1er message d'une nouvelle conversation
         * arrive avant que le push Welcome concurrent ait rejoint le groupe (ou pendant qu'il
         * tient MlsStateLock). Évite d'afficher un fallback "Nouveau message de X" générique.
         */
        private const val WELCOME_RACE_RETRIES = 3

        /** Délai entre deux réessais (le JNI process_welcome prend ~5s ; on lui laisse le temps). */
        private const val WELCOME_RACE_RETRY_DELAY_MS = 1_800L

        /**
         * Annule toutes les notifications de messages affichées (canal [CHANNEL_MESSAGES] + résumé).
         * Appelé quand l'app passe au premier plan (MainActivity.onResume) : ouvrir l'app vide les
         * notifications de messages lus ici ou ailleurs (partie visible de la sync read-state).
         */
        fun cancelAllMessageNotifications(context: Context) {
            if (android.os.Build.VERSION.SDK_INT < 23) return
            try {
                val manager =
                    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                for (sbn in manager.activeNotifications) {
                    val channelId =
                        if (android.os.Build.VERSION.SDK_INT >= 26) sbn.notification.channelId else null
                    // Ne toucher qu'aux notifications de messages (laisser social/formulaires).
                    if (channelId == null || channelId == CHANNEL_MESSAGES) manager.cancel(sbn.id)
                }
            } catch (e: Exception) {
                Log.w(TAG, "cancelAllMessageNotifications: ${e.message}")
            }
        }
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

    /**
     * Applique un Welcome MLS reçu (côté RECEVEUR) : rejoint le groupe et écrit
     * {filesDir}/mls.bin. Permet de rejoindre un nouveau groupe app fermée, pour que le
     * 1er message d'une conversation soit déchiffrable par FCM sans ouvrir l'app.
     * Retourne true en cas de succès.
     */
    external fun nativeProcessWelcomeBackground(
        filesDir: String,
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        welcomeB64: String,
        ratchetTreeB64: String,
    ): Boolean

    /**
     * Chiffre un message sortant en attente (texte/reply) contre l'epoch vivant et persiste
     * {filesDir}/mls.bin. Retourne JSON : {"ok":true,"ciphertext":"<b64>"} ou {"ok":false,...}.
     * `protoB64` est le proto AppMessage en clair (base64), construit cote TS au compose.
     */
    external fun nativeSendMessageBackground(
        filesDir: String,
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        protoB64: String,
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
            val dataDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }
            File(dataDir, "fcm_token.txt").writeText(token)
        } catch (e: Exception) {
            Log.w(TAG, "onNewToken: impossible d'écrire fcm_token.txt: ${e.message}")
        }
        // FCM2 : pousser le nouveau token au backend SANS attendre la prochaine ouverture foreground.
        // Un token rotaté app tuée resterait périmé côté serveur (push vers token mort) jusqu'à
        // réouverture. Best-effort via PushSecret ; si le contexte/secret manque (device pas encore
        // enrôlé), le foreground enregistrera le token au prochain démarrage.
        runWithWakeLock("fcm_token_refresh", 15_000L) {
            val ctx = MlsContextLoader.loadPushContext(this)
            val secret = retrievePushSecret()
            if (ctx == null || secret == null) {
                Log.d(TAG, "onNewToken: contexte/secret absent → refresh backend différé au foreground")
                return@runWithWakeLock
            }
            refreshTokenOnBackend(ctx, secret, token)
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data
        Log.d(TAG, "onMessageReceived: type=${data["type"]} action=${data["action"]} groupId=${data["groupId"]} queuedMessageId=${data["queuedMessageId"]} hasInlineProto=${!data["proto"].isNullOrEmpty()}")

        val msgType = data["type"]

        // ── Garde foreground : un seul moteur MLS écrit mls.bin à la fois ──────────────
        // Quand l'app est au premier plan, le moteur MLS Tauri (WebView/Rust, état en mémoire)
        // traite déjà tout via WebSocket et persiste mls.bin. Laisser le chemin JNI background
        // (FCM/Worker) traiter en parallèle clobbererait mls.bin : ce sont DEUX moteurs distincts
        // partageant le même fichier sans verrou commun (MlsStateLock ne couvre que FCM↔Worker).
        // Résultat observé : KeyPackages perdus (n_secrets retombe à 1), epoch gaps, UseAfterEviction.
        // On laisse donc le foreground gérer ; le background n'agit qu'app fermée/en arrière-plan.
        // Les notifications pures (social/form_reminder) ne touchent pas mls.bin → non concernées.
        if (MainActivity.isInForeground && msgType != "social" && msgType != "form_reminder") {
            Log.d(TAG, "App au premier plan → MLS géré par le foreground (WS), skip traitement background")
            return
        }

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
            runWithWakeLock("welcome_bg", 90_000L) {
                processWelcomeRequestBackground(groupId, requesterUser, requesterDev)
            }
            return
        }

        // Paquet Welcome MLS reçu : on REJOINT le groupe en arrière-plan (JNI) pour que le
        // 1er message d'une conversation initiée app fermée soit déchiffrable par FCM, sans
        // attendre l'ouverture de l'app. Le ratchet tree n'est jamais dans le payload FCM →
        // il est récupéré via fetch-proto.
        if (data["isWelcome"] == "true") {
            val groupId = data["groupId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto = data["proto"]?.takeIf { it.isNotEmpty() }
            Log.d(TAG, "isWelcome=true → groupId=$groupId qId=$queuedMessageId - join background")
            if (groupId.isEmpty()) {
                Log.e(TAG, "isWelcome: groupId manquant → abandon")
                return
            }
            runWithWakeLock("welcome_join", 90_000L) {
                processReceivedWelcomeBackground(groupId, queuedMessageId, inlineProto)
            }
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
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS
                )
                .build()
            enqueueWorkerIfHealthy(workRequest)
            if (!data.containsKey("groupId")) {
                Log.d(TAG, "process_queue sans groupId → sync silencieux, pas de notification")
                return
            }
        }

        // Message MLS chiffré : déchiffrement dans un thread dédié (max 60s).
        // Non-bloquant pour FCM : onMessageReceived retourne immédiatement.
        // MLS_LOCK dans tryDecrypt garantit qu'un seul thread écrit mls.bin à la fois.
        val silent = data["silent"] == "true"
        runWithWakeLock("fcm_decrypt") {
            val groupId         = data["groupId"] ?: ""
            val groupName       = data["groupName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderName      = data["senderName"]?.takeIf { it.isNotEmpty() } ?: ""
            val senderId        = data["senderId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto     = data["proto"]?.takeIf { it.isNotEmpty() }

            Log.d(TAG, "thread: groupId=$groupId senderName=$senderName silent=$silent inlineProto=${inlineProto != null}")

            var decrypted = tryDecrypt(queuedMessageId, groupId, inlineProto)
            // Course Welcome/message : le push Welcome concurrent peut être en train de rejoindre
            // le groupe (ou de tenir MlsStateLock) quand ce message arrive. On réessaie brièvement
            // pour que le 1er message d'une nouvelle conversation produise une vraie notification
            // au lieu d'un fallback générique, plutôt que d'afficher puis corriger la notif.
            var raceAttempt = 0
            while (!silent && decrypted == null && !queuedMessageId.isNullOrEmpty() && raceAttempt < WELCOME_RACE_RETRIES) {
                raceAttempt++
                try {
                    Thread.sleep(WELCOME_RACE_RETRY_DELAY_MS)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
                Log.d(TAG, "tryDecrypt réessai $raceAttempt/$WELCOME_RACE_RETRIES (course join de groupe) group=$groupId")
                decrypted = tryDecrypt(queuedMessageId, groupId, inlineProto)
            }
            val body: String = decrypted?.text
                ?: run {
                    // Déchiffrement échoué après réessais : groupe pas encore dans l'état MLS.
                    // On enqueue le worker pour réessayer au prochain cycle.
                    if (!queuedMessageId.isNullOrEmpty()) {
                        val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                            .build()
                        enqueueWorkerIfHealthy(workRequest)
                        Log.w(TAG, "Déchiffrement échoué → MlsBackgroundWorker enqueued")
                    }
                    buildFallbackText(senderName).also { Log.w(TAG, "Fallback notification: $it") }
                }

            if (silent) {
                // Un push silencieux dont senderId == mon propre userId signifie que JE viens de
                // lire ou d'envoyer dans cette conversation depuis un AUTRE appareil (read receipt
                // ou écho d'envoi). On retire alors la notification de cette conversation sur cet
                // appareil : c'est la partie "app tuée" de la synchro d'état de lecture multi-appareil.
                // senderId d'un pair (≠ mon userId) n'annule rien — sa lecture ne me concerne pas.
                val myUserId = MlsContextLoader.loadPushContext(this)?.userId
                if (groupId.isNotEmpty() && senderId.isNotEmpty() && senderId.equals(myUserId, ignoreCase = true)) {
                    cancelConversationNotification(groupId)
                } else {
                    Log.d(TAG, "FCM silencieux → MLS state mis à jour, pas de notification affichée")
                }
                return@runWithWakeLock
            }

            if (decrypted != null) {
                writeFcmCache(groupId, senderId, senderName, decrypted)
            }

            val avatarBitmap = if (senderId.isNotEmpty()) fetchAvatar(senderId) else null
            val largeIcon    = avatarBitmap ?: generateInitialsBitmap(senderName)
            Log.d(TAG, "showNotification: groupId=$groupId senderName=$senderName body=${body.take(60)} hasAvatar=${avatarBitmap != null}")
            showNotification(senderName, groupName, body, largeIcon, groupId)

            // Reveille par ce message entrant : tenter d'envoyer nos propres messages sortants en
            // attente (texte/reply/control), sans attendre un push Welcome ni la reouverture. La
            // garde foreground (C1) etant inactive en background, l'ecriture mls.bin est autorisee.
            // No-op si l'outbox est vide. Notifier s'il en reste (filet de securite).
            MlsContextLoader.loadPushContext(this)?.let { drainCtx ->
                val remaining = drainOutboxBackground(drainCtx)
                maybeNotifyPendingSync(remaining)
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Enfile un [MlsBackgroundWorker] seulement si le flag d'échec persistant n'est pas levé.
     * Si le flag est levé, le worker ne sera pas enfilé avant que l'utilisateur ouvre l'app
     * (ce qui appelle [MlsBackgroundWorker.resetFailureFlag] depuis [MainActivity.onResume]).
     */
    private fun enqueueWorkerIfHealthy(workRequest: androidx.work.WorkRequest) {
        val failed = getSharedPreferences(MlsBackgroundWorker.PREFS_WORKER, Context.MODE_PRIVATE)
            .getBoolean(MlsBackgroundWorker.KEY_FAILED, false)
        if (failed) {
            Log.w(TAG, "enqueueWorkerIfHealthy: worker en état d'échec persistant → ignoré")
            return
        }
        WorkManager.getInstance(this).enqueue(workRequest)
    }

    /**
     * Retrieves the push secret, falling back to [pending_push_secret.txt] when the Keystore
     * entry is absent. This covers the race where Tauri writes the secret while the app is
     * already running (so [CanariApplication.onCreate] never ran to migrate the file).
     * On a successful fallback read the secret is migrated into the Keystore immediately.
     */
    private fun retrievePushSecret(): String? {
        val stored = PushSecretKeystore.retrieve(this)
        if (stored != null) return stored

        return try {
            val file = File(MlsContextLoader.tauriDataDir(this), "pending_push_secret.txt")
            if (!file.exists()) return null
            val rawBytes = file.readBytes()
            val secret = rawBytes.toString(Charsets.UTF_8).trim()
            if (secret.isEmpty()) return null
            PushSecretKeystore.store(this, secret)
            file.writeBytes(ByteArray(rawBytes.size) { 0 })
            file.delete()
            Log.i(TAG, "retrievePushSecret: secret migré depuis pending_push_secret.txt → Keystore")
            secret
        } catch (e: Exception) {
            Log.e(TAG, "retrievePushSecret: fallback échoué: ${e.message}")
            null
        }
    }

    /**
     * Starts a new named thread holding a partial WakeLock for at most [timeoutMs] ms.
     * WakeLock tag: `"canari:<name>"`. Thread name: `"canari-<name>"` (visible in crash logs).
     */
    private fun runWithWakeLock(name: String, timeoutMs: Long = 60_000L, block: () -> Unit) {
        Thread(null, {
            val wl = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:$name")
            wl.acquire(timeoutMs)
            try {
                block()
            } finally {
                if (wl.isHeld) wl.release()
            }
        }, "canari-$name").start()
    }

    /**
     * Pousse le token FCM courant au backend via PushSecret (FCM2). Best-effort, jamais bloquant.
     * Ne régénère PAS le pushSecret (contrairement à /register foreground) : seul le token change.
     */
    private fun refreshTokenOnBackend(ctx: PushContext, secret: String, token: String) {
        try {
            val url = URL("${ctx.baseUrl}/api/mls/push/refresh-token")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("token", token)
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
                Log.d(TAG, "refreshTokenOnBackend: HTTP ${conn.responseCode}")
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "refreshTokenOnBackend: exception: ${e.message}")
        }
    }

    /**
     * Promeut la membership de ce device en 'active' côté serveur via PushSecret (FCM1).
     * Appelé après un join Welcome réussi en arrière-plan : sans ça, le device reste 'pending'
     * et la résolution des destinataires (status='active') l'exclut du routage des messages.
     * Best-effort, jamais bloquant.
     */
    private fun markMembershipActive(ctx: PushContext, secret: String, groupId: String) {
        try {
            val url = URL("${ctx.baseUrl}/api/mls/push/membership-active")
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
                Log.d(TAG, "markMembershipActive: HTTP ${conn.responseCode} group=$groupId")
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "markMembershipActive: exception: ${e.message}")
        }
    }

    // ── Traitement background Welcome request ────────────────────────────────

    /**
     * Traite une `welcome_request_pending` reçue via FCM quand l'app est tuée.
     * Séquence : acquiert le verrou Redis → fetche le key package → crée le Welcome
     * via JNI → envoie Welcome+commit au backend → libère le verrou.
     *
     * [MlsStateLock] est tenu UNIQUEMENT pendant le JNI (lecture mls.bin + écriture mls.bin)
     * pour ne pas bloquer les threads FCM de déchiffrement pendant les appels HTTP et les
     * retries Redis (qui peuvent dormir 2s × 2 = 4s). Avant ce refactoring, MlsStateLock
     * était tenu pour toute la durée (~30s), rendant tryDecrypt systématiquement timeout.
     */
    private fun processWelcomeRequestBackground(
        groupId: String,
        requesterUserId: String,
        requesterDeviceId: String,
    ) {
        // Chargements fichiers (lecture seule, hors verrou)
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "processWelcomeRequestBackground: push_context.json absent → abandon")
            return
        }
        val secret = retrievePushSecret()
        if (secret == null) {
            Log.e(TAG, "processWelcomeRequestBackground: pushSecret absent → abandon")
            return
        }

        // 1. Acquérir le verrou Redis add-lock (HTTP + retries) - hors MlsStateLock
        var lockAcquired = false
        for (attempt in 0..2) {
            lockAcquired = acquireAddLock(ctx, secret, groupId)
            if (lockAcquired) break
            Log.w(TAG, "processWelcomeRequestBackground: verrou Redis non acquis (tentative ${attempt + 1}/3)")
            if (attempt < 2) Thread.sleep(2_000)
        }
        if (!lockAcquired) {
            Log.w(TAG, "processWelcomeRequestBackground: impossible d'acquérir le verrou pour group=$groupId → abandon")
            return
        }
        Log.d(TAG, "processWelcomeRequestBackground: verrou Redis acquis pour group=$groupId")

        try {
            // 2. Récupérer le key package du requester (HTTP) - hors MlsStateLock
            val keyPackage = fetchKeyPackage(ctx, secret, requesterUserId, requesterDeviceId)
            if (keyPackage == null) {
                Log.e(TAG, "processWelcomeRequestBackground: keyPackage introuvable pour $requesterUserId:$requesterDeviceId → abandon")
                return
            }
            Log.d(TAG, "processWelcomeRequestBackground: keyPackage fetched (${keyPackage.length} chars)")

            // 3. Créer le Welcome via Rust JNI - MlsStateLock uniquement ici
            //    (lecture mls.bin + Argon2 déchiffrement + add_member + écriture mls.bin ~5–8s).
            // tryLock peut lever InterruptedException si le thread FCM est interrompu par Android.
            val jniLockAcquired = try {
                MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.e(TAG, "processWelcomeRequestBackground: thread interrompu pendant tryLock: ${e.message}")
                return
            }
            if (!jniLockAcquired) {
                Log.w(TAG, "processWelcomeRequestBackground: MlsStateLock non acquis → abandon")
                return
            }
            val result: JSONObject
            try {
                val stateBytes = MlsContextLoader.loadMlsState(this)
                if (stateBytes == null) {
                    Log.e(TAG, "processWelcomeRequestBackground: mls.bin absent → abandon")
                    return
                }
                val filesDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }.absolutePath
                val jsonStr = nativeCreateWelcomeBackground(
                    filesDir, stateBytes, ctx.pin, ctx.userId, ctx.deviceId,
                    groupId, keyPackage,
                )
                result = JSONObject(jsonStr)
            } finally {
                MlsStateLock.LOCK.unlock()
            }

            if (!result.optBoolean("ok", false)) {
                Log.e(TAG, "processWelcomeRequestBackground: nativeCreateWelcomeBackground échoué: ${result.optString("error")}")
                return
            }
            val welcomePayload  = result.getString("welcome")
            val ratchetTree     = result.optString("ratchetTree").takeIf { it.isNotEmpty() && it != "null" }
            val commitPayload   = result.getString("commit")
            // Epoch de base avant l'ajout : le backend le valide (validateCommit) pour garder son
            // compteur activeEpoch en phase avec l'epoch reel, sinon les commits foreground sont
            // rejetes a tort (C6). -1 si absent (JNI ancien) -> le backend skippe la validation.
            val baseEpoch       = result.optLong("baseEpoch", -1L)
            Log.d(TAG, "processWelcomeRequestBackground: Welcome créé, commit=${commitPayload.take(16)}… baseEpoch=$baseEpoch")

            // 4. Envoyer Welcome + commit au backend (HTTP) - hors MlsStateLock
            val sent = sendWelcomeAndCommit(
                ctx, secret, groupId,
                requesterUserId, requesterDeviceId,
                welcomePayload, ratchetTree, commitPayload, baseEpoch,
            )
            if (sent) {
                Log.d(TAG, "processWelcomeRequestBackground: ✓ Welcome envoyé pour group=$groupId target=$requesterUserId:$requesterDeviceId")
            } else {
                Log.e(TAG, "processWelcomeRequestBackground: sendWelcomeAndCommit échoué pour group=$groupId")
            }
        } finally {
            // 5. Libérer le verrou Redis dans tous les cas
            releaseAddLock(ctx, secret, groupId)
            Log.d(TAG, "processWelcomeRequestBackground: verrou Redis libéré pour group=$groupId")
            // 6. Opportuniste : ce device a peut-être lui aussi des messages en attente — tenter de
            //    les envoyer maintenant que l'app est réveillée, et notifier s'il en reste.
            val remaining = drainOutboxBackground(ctx)
            maybeNotifyPendingSync(remaining)
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
        baseEpoch: Long,
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
                if (baseEpoch >= 0) put("baseEpoch", baseEpoch)
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
     * Le verrou est acquis UNIQUEMENT pour l'accès à mls.bin et le JNI Argon2 - jamais
     * pendant les appels HTTP (fetchProtoFromBackend), pour ne pas bloquer les autres
     * threads FCM pendant les 5–11s que peut prendre un fetch réseau lent.
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

        // Charger le contexte push (lecture fichier) avant le verrou - lecture seule, thread-safe.
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "tryDecrypt: push_context.json absent ou invalide → abandon")
            return null
        }

        // Récupérer le proto AVANT d'acquérir MlsStateLock : fetchProtoFromBackend peut
        // prendre jusqu'à ~11s (2 tentatives × 5s timeout + 1s sleep). Tenir le verrou
        // pendant ce temps bloquerait tryDecrypt des autres threads pendant toute la durée.
        val protoB64: String = inlineProto
            ?: fetchProtoFromBackend(queuedMessageId, ctx)
                .also { if (it == null) Log.e(TAG, "tryDecrypt: fetchProtoFromBackend a échoué") }
            ?: return null

        // Acquérir le verrou uniquement pour mls.bin + Argon2/JNI (~3–5s max).
        // tryLock peut lever InterruptedException si le thread est interrompu par Android
        // sous pression mémoire. On restaure le flag d'interruption pour ne pas l'avaler.
        val lockAcquired = try {
            MlsStateLock.LOCK.tryLock(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "tryDecrypt: thread interrompu pendant tryLock MlsStateLock: ${e.message}")
            return null
        }
        if (!lockAcquired) {
            Log.w(TAG, "tryDecrypt: MlsStateLock non acquis après 5s → abandon (un autre thread déchiffre)")
            return null
        }
        try {
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.e(TAG, "tryDecrypt: mls.bin absent → abandon")
                return null
            }
            Log.d(TAG, "tryDecrypt: état MLS chargé (${stateBytes.size} octets), userId=${ctx.userId} deviceId=${ctx.deviceId}")
            return decryptProto(stateBytes, ctx.pin, ctx.userId, ctx.deviceId, groupId, protoB64)
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

    private fun fetchProtoFromBackend(queuedMessageId: String, ctx: PushContext): String? {
        val secret = retrievePushSecret()
        if (secret == null) {
            Log.e(TAG, "fetchProtoFromBackend: pushSecret absent")
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

    // ── Traitement background Welcome reçu (côté receveur) ───────────────────

    /**
     * Rejoint un groupe via un Welcome reçu en arrière-plan, puis enfile le worker pour
     * drainer d'éventuels messages déjà en file. MlsStateLock n'est tenu que pendant le JNI
     * (lecture mls.bin + Argon2 + écriture mls.bin), jamais pendant les appels HTTP.
     */
    private fun processReceivedWelcomeBackground(
        groupId: String,
        queuedMessageId: String?,
        inlineProto: String?,
    ) {
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "processReceivedWelcomeBackground: push_context.json absent → abandon")
            return
        }

        // Welcome + ratchet tree : le ratchet tree n'est jamais inclus dans le push FCM,
        // on le récupère donc toujours via fetch-proto (qui renvoie aussi le proto).
        var welcomeB64 = inlineProto
        var ratchetTreeB64 = ""
        if (queuedMessageId != null) {
            val secret = retrievePushSecret()
            if (secret != null) {
                val bundle = fetchWelcomeBundle(queuedMessageId, ctx, secret)
                if (bundle != null) {
                    if (welcomeB64.isNullOrEmpty()) welcomeB64 = bundle.first
                    ratchetTreeB64 = bundle.second
                }
            }
        }
        if (welcomeB64.isNullOrEmpty()) {
            Log.e(TAG, "processReceivedWelcomeBackground: bytes Welcome introuvables → abandon")
            return
        }

        val jniLockAcquired = try {
            MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "processReceivedWelcomeBackground: interrompu pendant tryLock: ${e.message}")
            return
        }
        if (!jniLockAcquired) {
            Log.w(TAG, "processReceivedWelcomeBackground: MlsStateLock non acquis → abandon")
            return
        }
        val joined: Boolean
        try {
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.e(TAG, "processReceivedWelcomeBackground: mls.bin absent → abandon")
                return
            }
            val filesDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }.absolutePath
            joined = nativeProcessWelcomeBackground(
                filesDir, stateBytes, ctx.pin, ctx.userId, ctx.deviceId, welcomeB64!!, ratchetTreeB64,
            )
        } finally {
            MlsStateLock.LOCK.unlock()
        }

        if (joined) {
            Log.d(TAG, "processReceivedWelcomeBackground: ✓ groupe rejoint group=$groupId")
            // FCM1 : promouvoir la membership en 'active' côté serveur. Le join JNI ne passe pas par
            // le chemin foreground (updateInvitationStatus), donc sans cet appel le device reste
            // 'pending' et n'est jamais routé comme destinataire des messages suivants (ni temps
            // réel ni push). PushSecret car l'app peut être tuée (pas de JWT). Best-effort.
            retrievePushSecret()?.let { markMembershipActive(ctx, it, groupId) }
            // Le groupe existe désormais : drainer la file pour traiter les messages en attente.
            val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                .build()
            enqueueWorkerIfHealthy(workRequest)
        } else {
            Log.e(TAG, "processReceivedWelcomeBackground: échec join group=$groupId")
        }

        // Le groupe vient (peut-être) d'être rejoint : tenter d'envoyer les messages sortants en
        // attente, et notifier l'utilisateur s'il en reste (filet de sécurité de l'envoi background).
        val remaining = drainOutboxBackground(ctx)
        maybeNotifyPendingSync(remaining)
    }

    /** Récupère la paire (proto, ratchetTree) d'un Welcome en file via l'endpoint PushSecret. */
    private fun fetchWelcomeBundle(
        queuedMessageId: String,
        ctx: PushContext,
        secret: String,
    ): Pair<String, String>? {
        return try {
            val url = URL(
                "${ctx.baseUrl}/api/mls/push/fetch-proto" +
                    "?messageId=${java.net.URLEncoder.encode(queuedMessageId, "UTF-8")}" +
                    "&userId=${java.net.URLEncoder.encode(ctx.userId, "UTF-8")}" +
                    "&deviceId=${java.net.URLEncoder.encode(ctx.deviceId, "UTF-8")}"
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
                    Log.e(TAG, "fetchWelcomeBundle: HTTP $code")
                    null
                } else {
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(text)
                    Pair(json.optString("proto"), json.optString("ratchetTree"))
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "fetchWelcomeBundle: exception: ${e.message}")
            null
        }
    }

    // ── Envoi background de l'outbox (messages sortants, app tuée) ────────────

    /** Une entrée du mirror outbox (proto AppMessage en clair, base64). */
    private data class OutboxMirrorEntry(
        val id: String,
        val groupId: String,
        val proto: String,
        val sentAt: Long,
        /** Envoi silencieux (pas de notif destinataire) : vrai pour les events de controle. */
        val silent: Boolean,
    )

    /**
     * Draine le mirror outbox : pour chaque message en attente, chiffre le proto contre l'epoch
     * vivant (JNI sous MlsStateLock), POST le ciphertext, et marque l'envoi. Réécrit le mirror avec
     * les entrées restantes et journalise les ids livrés pour réconciliation TS au login.
     * Retourne le nombre d'entrées NON envoyées (groupe pas encore rejoint, réseau, etc.).
     */
    private fun drainOutboxBackground(ctx: PushContext): Int {
        val entries = readOutboxMirror()
        if (entries.isEmpty()) return 0
        val secret = retrievePushSecret()
        if (secret == null) {
            Log.w(TAG, "drainOutboxBackground: pushSecret absent → ${entries.size} message(s) restent en file")
            return entries.size
        }
        Log.d(TAG, "drainOutboxBackground: ${entries.size} message(s) à envoyer")
        val sentIds = mutableListOf<String>()
        val remaining = mutableListOf<OutboxMirrorEntry>()
        for (entry in entries) {
            val ciphertext = encryptQueuedMessage(ctx, entry)
            if (ciphertext == null) {
                remaining.add(entry)
                continue
            }
            if (sendQueuedMessagePush(ctx, secret, entry.groupId, ciphertext, entry.id, entry.silent)) {
                sentIds.add(entry.id)
                Log.d(TAG, "drainOutboxBackground: ✓ envoyé id=${entry.id.take(8)} group=${entry.groupId.take(8)}")
            } else {
                remaining.add(entry)
                Log.w(TAG, "drainOutboxBackground: POST échoué id=${entry.id.take(8)} → reste en file")
            }
        }
        if (sentIds.isNotEmpty()) appendOutboxSent(sentIds)
        rewriteOutboxMirror(remaining)
        Log.d(TAG, "drainOutboxBackground: ${sentIds.size} envoyé(s), ${remaining.size} restant(s)")
        return remaining.size
    }

    /**
     * Chiffre un message en attente via JNI sous MlsStateLock (le JNI réécrit mls.bin après avoir
     * fait avancer le ratchet). Retourne le ciphertext MLS (base64) ou null si l'état est absent,
     * le verrou indisponible, ou le groupe pas encore rejoint (send_message → GroupNotFound).
     */
    private fun encryptQueuedMessage(ctx: PushContext, entry: OutboxMirrorEntry): String? {
        val lockAcquired = try {
            MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "encryptQueuedMessage: interrompu pendant tryLock: ${e.message}")
            return null
        }
        if (!lockAcquired) {
            Log.w(TAG, "encryptQueuedMessage: MlsStateLock non acquis → abandon")
            return null
        }
        try {
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.e(TAG, "encryptQueuedMessage: mls.bin absent → abandon")
                return null
            }
            val filesDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }.absolutePath
            val jsonStr = nativeSendMessageBackground(
                filesDir, stateBytes, ctx.pin, ctx.userId, ctx.deviceId, entry.groupId, entry.proto,
            )
            val json = JSONObject(jsonStr)
            if (!json.optBoolean("ok", false)) {
                Log.d(TAG, "encryptQueuedMessage: ok=false (${json.optString("error").take(60)}) group=${entry.groupId.take(8)} - groupe pas encore rejoint ?")
                return null
            }
            return json.optString("ciphertext").takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            Log.e(TAG, "encryptQueuedMessage: exception: ${e.message}")
            return null
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

    /** POST le ciphertext d'un message en attente à l'endpoint PushSecret. Retourne true si livré. */
    private fun sendQueuedMessagePush(
        ctx: PushContext,
        secret: String,
        groupId: String,
        ciphertextB64: String,
        messageId: String,
        silent: Boolean,
    ): Boolean {
        return try {
            val url = URL("${ctx.baseUrl}/api/mls/push/send")
            val body = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
                put("proto", ciphertextB64)
                put("messageId", messageId)
                put("silent", silent)
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
                Log.d(TAG, "sendQueuedMessagePush: HTTP $code group=${groupId.take(8)} msg=${messageId.take(8)}")
                code == 200 || code == 201
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.e(TAG, "sendQueuedMessagePush: exception: ${e.message}")
            false
        }
    }

    /** Lit le mirror outbox en clair écrit par le TS. Retourne [] si absent/illisible. */
    private fun readOutboxMirror(): List<OutboxMirrorEntry> {
        return try {
            val file = File(MlsContextLoader.tauriDataDir(this), OUTBOX_PENDING_FILE)
            if (!file.exists()) return emptyList()
            file.readLines().filter { it.isNotBlank() }.mapNotNull { line ->
                try {
                    val o = JSONObject(line)
                    val id = o.optString("id")
                    val groupId = o.optString("groupId")
                    val proto = o.optString("proto")
                    if (id.isEmpty() || groupId.isEmpty() || proto.isEmpty()) null
                    else OutboxMirrorEntry(id, groupId, proto, o.optLong("sentAt", 0L), o.optBoolean("silent", false))
                } catch (e: Exception) {
                    null
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "readOutboxMirror: ${e.message}")
            emptyList()
        }
    }

    /** Réécrit le mirror outbox avec les entrées restantes (supprime le fichier si vide). */
    private fun rewriteOutboxMirror(remaining: List<OutboxMirrorEntry>) {
        try {
            val file = File(MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }, OUTBOX_PENDING_FILE)
            if (remaining.isEmpty()) {
                if (file.exists()) file.delete()
                return
            }
            val body = remaining.joinToString("\n") { e ->
                JSONObject().apply {
                    put("id", e.id)
                    put("groupId", e.groupId)
                    put("proto", e.proto)
                    put("sentAt", e.sentAt)
                }.toString()
            }
            file.writeText(body + "\n")
        } catch (e: Exception) {
            Log.w(TAG, "rewriteOutboxMirror: ${e.message}")
        }
    }

    /** Ajoute les messageId livrés au journal de réconciliation lu par le TS au login. */
    private fun appendOutboxSent(ids: List<String>) {
        try {
            val file = File(MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }, OUTBOX_SENT_FILE)
            val existing = if (file.exists()) file.readText() else ""
            file.writeText(existing + ids.joinToString("\n") + "\n")
        } catch (e: Exception) {
            Log.w(TAG, "appendOutboxSent: ${e.message}")
        }
    }

    /** Affiche le nudge "messages en attente" si des envois restent en file et l'app est fermée. */
    private fun maybeNotifyPendingSync(remaining: Int) {
        if (remaining <= 0) return
        if (MainActivity.isInForeground) return
        showPendingSyncNotification()
    }

    /**
     * Notification douce invitant à ouvrir l'app pour vider l'outbox (filet de sécurité de l'envoi
     * background). ID stable + canal messages : elle s'efface d'elle-même à l'ouverture de l'app
     * (cancelAllMessageNotifications dans MainActivity.onResume), pour cette raison ou une autre.
     */
    private fun showPendingSyncNotification() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannels(manager)
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, PENDING_SYNC_NOTIF_ID, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val body = "Vous avez peut-être des messages en attente, ouvrez l'application pour les envoyer."
        val notif = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Canari")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(PENDING_SYNC_NOTIF_ID, notif)
        Log.d(TAG, "showPendingSyncNotification: nudge affiché (id=$PENDING_SYNC_NOTIF_ID)")
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
     * Le fichier est borné à [MAX_FCM_CACHE_ENTRIES] lignes pour éviter la croissance
     * unbounded quand l'app est fermée longtemps et reçoit beaucoup de notifications.
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
            val file = File(MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }, "fcm_message_cache.ndjson")
            CACHE_LOCK.lock()
            try {
                // Conserver au maximum MAX_FCM_CACHE_ENTRIES lignes : lire, tronquer, réécrire.
                val existing = if (file.exists())
                    file.readLines().filter { it.isNotBlank() }
                else emptyList()
                val kept = if (existing.size >= MAX_FCM_CACHE_ENTRIES)
                    existing.drop(existing.size - MAX_FCM_CACHE_ENTRIES + 1)
                else existing
                file.writeText((kept + entry.toString()).joinToString("\n") + "\n")
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
        return File(filesDir, "avatar_$safeId.jpg")
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
        val ctx    = MlsContextLoader.loadPushContext(this) ?: return null
        val secret = retrievePushSecret() ?: return null
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
     * Retire la notification d'une conversation (message lu/envoyé depuis un autre appareil).
     * Ne crée jamais d'ID : si aucune notification n'existe pour ce groupe, ne fait rien.
     * Retire aussi le résumé de groupe s'il ne reste plus aucune notification de messages.
     */
    private fun cancelConversationNotification(groupId: String) {
        val prefs = getSharedPreferences("canari_notif_ids", Context.MODE_PRIVATE)
        val notifId = prefs.getInt(groupId, -1)
        if (notifId == -1) {
            Log.d(TAG, "cancelConversationNotification: aucune notif pour group=${groupId.take(8)}")
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(notifId)
        Log.d(TAG, "cancelConversationNotification: notif retirée group=${groupId.take(8)} id=$notifId")

        // Retirer le résumé s'il ne reste plus aucune notification de messages (hors résumé).
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            try {
                val remaining = manager.activeNotifications.count { sbn ->
                    sbn.id != GROUP_SUMMARY_ID &&
                        (android.os.Build.VERSION.SDK_INT < 26 ||
                            sbn.notification.channelId == CHANNEL_MESSAGES)
                }
                if (remaining == 0) manager.cancel(GROUP_SUMMARY_ID)
            } catch (e: Exception) {
                Log.w(TAG, "cancelConversationNotification: nettoyage résumé échoué: ${e.message}")
            }
        }
    }

    /**
     * Affiche (ou met à jour) une notification pour un message MLS (DM ou groupe).
     * Un seul ID stable par conversation : chaque nouveau message écrase la notification
     * précédente au lieu d'en empiler une nouvelle.
     * Supprimée si l'app est au premier plan : le WebSocket a déjà livré le message à l'UI.
     */
    private fun showNotification(
        senderName: String,
        groupName: String,
        body: String,
        largeIcon: Bitmap,
        groupId: String,
    ) {
        if (MainActivity.isInForeground) {
            Log.d(TAG, "showNotification: app au premier plan → notification supprimée (groupId=${groupId.take(8)})")
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannels(manager)

        val isGroup = groupName.isNotEmpty() && groupName != senderName

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

        // MessagingStyle : les messages successifs d'une même conversation s'EMPILENT au lieu
        // de se remplacer. On reconstruit le style à partir de la notification active (si présente)
        // en bornant l'historique à MAX_NOTIF_MESSAGES pour éviter une croissance illimitée.
        val senderPerson = Person.Builder()
            .setName(senderName.ifEmpty { "Canari" })
            .setIcon(IconCompat.createWithBitmap(largeIcon))
            .build()
        val selfPerson = Person.Builder().setName("Moi").build()

        val existingNotif = try {
            manager.activeNotifications.firstOrNull { it.id == notifId }?.notification
        } catch (e: Exception) {
            Log.w(TAG, "showNotification: activeNotifications indisponible: ${e.message}")
            null
        }

        val style = NotificationCompat.MessagingStyle(selfPerson)
        if (isGroup) {
            style.conversationTitle = groupName
            style.isGroupConversation = true
        }
        // Réinjecter les messages précédents (bornés) puis ajouter le nouveau.
        existingNotif
            ?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?.messages
            ?.takeLast(MAX_NOTIF_MESSAGES - 1)
            ?.forEach { style.addMessage(it) }
        style.addMessage(body, System.currentTimeMillis(), senderPerson)

        val notif = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setStyle(style)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setLargeIcon(largeIcon)
            .setGroup(GROUP_KEY_MESSAGES)
            .build()

        Log.d(TAG, "showNotification: notifId=$notifId messages=${style.messages.size} group=$isGroup")
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

    private fun ensureNotificationChannels(manager: NotificationManager) =
        CanariApplication.ensureChannels(manager)
}
