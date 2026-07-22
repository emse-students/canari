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
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat
import androidx.work.BackoffPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkRequest
import java.util.concurrent.TimeUnit
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

// Local alias: avoids renaming PushContext across every method signature.
private typealias PushContext = MlsContextLoader.PushContext

class CanariFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        const val TAG = "CanariFCM"

        /** High-priority channel: DMs and group messages (sound + vibration). */
        const val CHANNEL_MESSAGES = "canari_messages"

        /** Normal-priority channel: reactions/comments on posts (silent). */
        const val CHANNEL_SOCIAL   = "canari_social"

        /** Normal-priority channel: form reminders (silent). */
        const val CHANNEL_FORMS    = "canari_forms"

        const val PREFS_NAME    = "canari_prefs"
        const val KEY_FCM_TOKEN = "fcm_token"

        /** Notification quick actions (WP-XP-1): reply inline / mark as read from the shade. */
        const val ACTION_QUICK_REPLY = "fr.emse.canari.ACTION_QUICK_REPLY"
        const val ACTION_MARK_READ   = "fr.emse.canari.ACTION_MARK_READ"
        const val EXTRA_GROUP_ID     = "groupId"
        const val KEY_TEXT_REPLY     = "canari_quick_reply_text"

        // Starts at 10_000 to avoid overlapping the stable IDs (1000-9998) or the summary (9999).
        private val notificationIdCounter = java.util.concurrent.atomic.AtomicInteger(10_000)

        /** Avatar file cache validity duration: 24 hours. */
        private const val AVATAR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000L

        /** Maximum number of entries kept in fcm_message_cache.ndjson. */
        private const val MAX_FCM_CACHE_ENTRIES = 50

        /** Lock protecting concurrent writes to fcm_message_cache.ndjson. */
        private val CACHE_LOCK = java.util.concurrent.locks.ReentrantLock()

        /**
         * Lock protecting getStableNotifId: the read-increment-write of the SharedPreferences
         * counter is not atomic, hence the race between parallel FCM threads.
         */
        private val NOTIF_ID_LOCK = Any()

        /** Android group key to bundle message notifications under a single line. */
        private const val GROUP_KEY_MESSAGES = "canari_messages_group"

        /** Reserved ID for the group summary notification (must not collide with getStableNotifId). */
        private const val GROUP_SUMMARY_ID   = 9999

        /** Reserved ID for the "messages pending sync" notification (messages channel -> auto-cleared on open). */
        private const val PENDING_SYNC_NOTIF_ID = 9998

        /** App-private cleartext mirror of the outbox (written by the TS) drained by the background send. */
        private const val OUTBOX_PENDING_FILE = "outbox_pending.ndjson"

        /** List of messageIds delivered in the background (read then cleared by the TS at login). */
        private const val OUTBOX_SENT_FILE = "outbox_sent.ndjson"

        /** Maximum number of messages stacked in a per-conversation MessagingStyle notification. */
        private const val MAX_NOTIF_MESSAGES = 6

        /**
         * Number of decrypt retries when the 1st message of a new conversation arrives before
         * the concurrent Welcome push has joined the group (or while it holds MlsStateLock).
         * Avoids showing a generic "Nouveau message de X" fallback.
         */
        private const val WELCOME_RACE_RETRIES = 3

        /** Delay between two retries (the JNI process_welcome takes ~5s; give it time). */
        private const val WELCOME_RACE_RETRY_DELAY_MS = 1_800L

        /**
         * Cancels every displayed message notification (channel [CHANNEL_MESSAGES] + summary).
         * Called when the app comes to the foreground (MainActivity.onResume): opening the app clears
         * notifications for messages read here or elsewhere (visible part of the read-state sync).
         */
        fun cancelAllMessageNotifications(context: Context) {
            if (android.os.Build.VERSION.SDK_INT < 23) return
            try {
                val manager =
                    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                for (sbn in manager.activeNotifications) {
                    val channelId =
                        if (android.os.Build.VERSION.SDK_INT >= 26) sbn.notification.channelId else null
                    // Only touch message notifications (leave social/forms alone).
                    if (channelId == null || channelId == CHANNEL_MESSAGES) manager.cancel(sbn.id)
                }
            } catch (e: Exception) {
                Log.w(TAG, "cancelAllMessageNotifications: ${e.message}")
            }
        }

        // --- Shared with CanariNotificationActionReceiver (quick reply / mark as read) ---------
        //
        // These take an explicit `context`/`service` instead of an implicit Service-as-Context
        // receiver so the notification-action BroadcastReceiver can reuse the exact same
        // outbox-drain and notification-cancel logic as the FCM service, with zero duplication.
        // `service` only backs the JNI-bound `nativeSendMessageBackground` call (native code
        // never touches Context/Service framework state), so a bare `CanariFirebaseMessagingService()`
        // instance - never `attachBaseContext`-ed - is safe to pass there, but NOT as `context`.

        /**
         * Retrieves the push secret, falling back to [pending_push_secret.txt] when the Keystore
         * entry is absent. This covers the race where Tauri writes the secret while the app is
         * already running (so [CanariApplication.onCreate] never ran to migrate the file).
         * On a successful fallback read the secret is migrated into the Keystore immediately.
         */
        internal fun retrievePushSecret(context: Context): String? {
            val stored = PushSecretKeystore.retrieve(context)
            if (stored != null) return stored

            return try {
                val file = File(MlsContextLoader.tauriDataDir(context), "pending_push_secret.txt")
                if (!file.exists()) return null
                val rawBytes = file.readBytes()
                val secret = rawBytes.toString(Charsets.UTF_8).trim()
                if (secret.isEmpty()) return null
                PushSecretKeystore.store(context, secret)
                file.writeBytes(ByteArray(rawBytes.size) { 0 })
                file.delete()
                Log.i(TAG, "retrievePushSecret: secret migrated from pending_push_secret.txt -> Keystore")
                secret
            } catch (e: Exception) {
                Log.e(TAG, "retrievePushSecret: fallback failed: ${e.message}")
                null
            }
        }

        /**
         * Returns a stable, unique notification ID for [groupId], persisted in
         * SharedPreferences. Avoids groupId.hashCode() collisions between conversations.
         */
        internal fun getStableNotifId(context: Context, groupId: String): Int =
            synchronized(NOTIF_ID_LOCK) {
                val prefs = context.getSharedPreferences("canari_notif_ids", Context.MODE_PRIVATE)
                val existing = prefs.getInt(groupId, -1)
                if (existing != -1) return@synchronized existing
                val next = prefs.getInt("__counter__", 1000)
                // commit() guarantees the counter is incremented before exiting the synchronized block.
                prefs.edit().putInt(groupId, next).putInt("__counter__", next + 1).commit()
                next
            }

        /**
         * Removes a conversation's notification (message read/sent from another device, or a
         * "mark as read" notification quick action). Never creates an ID: if no notification
         * exists for this group, does nothing. Also removes the group summary if no message
         * notification remains.
         */
        internal fun cancelConversationNotification(context: Context, groupId: String) {
            val prefs = context.getSharedPreferences("canari_notif_ids", Context.MODE_PRIVATE)
            val notifId = prefs.getInt(groupId, -1)
            if (notifId == -1) {
                Log.d(TAG, "cancelConversationNotification: no notif for group=${groupId.take(8)}")
                return
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(notifId)
            Log.d(TAG, "cancelConversationNotification: notif removed group=${groupId.take(8)} id=$notifId")

            // Refresh the group summary + launcher badge (WP-XP-2): recompute the unread count and
            // drop the summary when no message notification remains.
            refreshBadgeSummary(context)
        }

        /**
         * Counts distinct unread conversations = active message notifications, excluding the group
         * summary and the pending-sync nudge. Backs the launcher app-icon badge (WP-XP-2).
         */
        internal fun countUnreadConversations(manager: NotificationManager): Int {
            if (android.os.Build.VERSION.SDK_INT < 23) return 0
            return try {
                manager.activeNotifications.count { sbn ->
                    sbn.id != GROUP_SUMMARY_ID && sbn.id != PENDING_SYNC_NOTIF_ID &&
                        (android.os.Build.VERSION.SDK_INT < 26 ||
                            sbn.notification.channelId == CHANNEL_MESSAGES)
                }
            } catch (e: Exception) {
                Log.w(TAG, "countUnreadConversations: ${e.message}")
                0
            }
        }

        /**
         * (Re)builds the grouped-messages summary, carrying the unread-conversation count as its
         * badge number so the launcher app-icon badge mirrors the real unread count (WP-XP-2).
         * Cancels the summary entirely when nothing is unread. Called after every message
         * notification post or cancel (push receipt + read-state sync) - the single source of
         * truth for both the group summary and the badge.
         */
        internal fun refreshBadgeSummary(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val count = countUnreadConversations(manager)
            if (count == 0) {
                manager.cancel(GROUP_SUMMARY_ID)
                return
            }
            // The summary is also mandatory on Android 7+ for grouping to work: without it, the
            // per-conversation notifications are not grouped.
            val summary = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setGroup(GROUP_KEY_MESSAGES)
                .setGroupSummary(true)
                .setAutoCancel(true)
                .setNumber(count)
                .build()
            manager.notify(GROUP_SUMMARY_ID, summary)
            Log.d(TAG, "refreshBadgeSummary: badge=$count")
        }

        /** An outbox mirror entry (cleartext AppMessage proto, base64). */
        internal data class OutboxMirrorEntry(
            val id: String,
            val groupId: String,
            val proto: String,
            val sentAt: Long,
            /** Silent send (no recipient notification): true for control events. */
            val silent: Boolean,
        )

        /**
         * Drains the outbox mirror: for each pending message, encrypts the proto against the live
         * epoch (JNI under MlsStateLock), POSTs the ciphertext, and marks the send. Rewrites the
         * mirror with the remaining entries and logs the delivered ids for TS reconciliation at
         * login. Returns the number of NOT-sent entries (group not joined yet, network, etc.).
         */
        internal fun drainOutboxBackground(
            context: Context,
            service: CanariFirebaseMessagingService,
            ctx: PushContext,
        ): Int {
            val entries = readOutboxMirror(context)
            if (entries.isEmpty()) return 0
            val secret = retrievePushSecret(context)
            if (secret == null) {
                Log.w(TAG, "drainOutboxBackground: pushSecret absent -> ${entries.size} message(s) remain queued")
                return entries.size
            }
            Log.d(TAG, "drainOutboxBackground: ${entries.size} message(s) to send")
            val sentIds = mutableListOf<String>()
            val remaining = mutableListOf<OutboxMirrorEntry>()
            for (entry in entries) {
                val ciphertext = encryptQueuedMessage(context, service, ctx, entry)
                if (ciphertext == null) {
                    remaining.add(entry)
                    continue
                }
                if (sendQueuedMessagePush(ctx, secret, entry.groupId, ciphertext, entry.id, entry.silent)) {
                    sentIds.add(entry.id)
                    Log.d(TAG, "drainOutboxBackground: ✓ sent id=${entry.id.take(8)} group=${entry.groupId.take(8)}")
                } else {
                    remaining.add(entry)
                    Log.w(TAG, "drainOutboxBackground: POST failed id=${entry.id.take(8)} -> stays queued")
                }
            }
            if (sentIds.isNotEmpty()) appendOutboxSent(context, sentIds)
            rewriteOutboxMirror(context, remaining)
            Log.d(TAG, "drainOutboxBackground: ${sentIds.size} sent, ${remaining.size} remaining")
            return remaining.size
        }

        /**
         * Encrypts a pending message via JNI under MlsStateLock (the JNI rewrites mls.bin after
         * advancing the ratchet). Returns the MLS ciphertext (base64) or null if the state is
         * absent, the lock is unavailable, or the group is not joined yet (send_message ->
         * GroupNotFound).
         */
        private fun encryptQueuedMessage(
            context: Context,
            service: CanariFirebaseMessagingService,
            ctx: PushContext,
            entry: OutboxMirrorEntry,
        ): String? {
            val lockAcquired = try {
                MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.e(TAG, "encryptQueuedMessage: interrupted during tryLock: ${e.message}")
                return null
            }
            if (!lockAcquired) {
                Log.w(TAG, "encryptQueuedMessage: MlsStateLock not acquired -> abort")
                return null
            }
            try {
                val stateBytes = MlsContextLoader.loadMlsState(context)
                if (stateBytes == null) {
                    Log.e(TAG, "encryptQueuedMessage: mls.bin absent -> abort")
                    return null
                }
                val filesDir = MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }.absolutePath
                val jsonStr = service.nativeSendMessageBackground(
                    filesDir, stateBytes, ctx.pin, ctx.userId, ctx.deviceId, entry.groupId, entry.proto,
                )
                val json = JSONObject(jsonStr)
                if (!json.optBoolean("ok", false)) {
                    Log.d(TAG, "encryptQueuedMessage: ok=false (${json.optString("error").take(60)}) group=${entry.groupId.take(8)} - group not joined yet?")
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

        /** POSTs the ciphertext of a pending message to the PushSecret endpoint. Returns true if delivered. */
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

        /** Reads the cleartext outbox mirror written by the TS. Returns [] if absent/unreadable. */
        internal fun readOutboxMirror(context: Context): List<OutboxMirrorEntry> {
            return try {
                val file = File(MlsContextLoader.tauriDataDir(context), OUTBOX_PENDING_FILE)
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

        /** Rewrites the outbox mirror with the remaining entries (deletes the file if empty). */
        internal fun rewriteOutboxMirror(context: Context, remaining: List<OutboxMirrorEntry>) {
            try {
                val file = File(MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }, OUTBOX_PENDING_FILE)
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
                        put("silent", e.silent)
                    }.toString()
                }
                file.writeText(body + "\n")
            } catch (e: Exception) {
                Log.w(TAG, "rewriteOutboxMirror: ${e.message}")
            }
        }

        /** Appends the delivered messageIds to the reconciliation log read by the TS at login. */
        private fun appendOutboxSent(context: Context, ids: List<String>) {
            try {
                val file = File(MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }, OUTBOX_SENT_FILE)
                val existing = if (file.exists()) file.readText() else ""
                file.writeText(existing + ids.joinToString("\n") + "\n")
            } catch (e: Exception) {
                Log.w(TAG, "appendOutboxSent: ${e.message}")
            }
        }
    }

    // Returns a JSON: {"ok":true,"text":"...","messageId":"...","sentAt":123,"type":"text|reply|media","replyTo":null,"mediaKind":null}
    // or {"ok":false} on failure.
    external fun nativeDecryptMessage(
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        ciphertext: ByteArray
    ): String

    // Returns the current MLS epoch of groupId in the persisted state, or -1 if unknown / unreadable.
    // Used to compute the sinceEpoch to fetch for the in-memory commit catch-up. Read-only.
    external fun nativeGroupEpoch(
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String
    ): Long

    // Read-only in-memory commit catch-up decrypt: applies the ordered commitsJson (JSON array of
    // base64 commit bytes) to an ephemeral manager to reach the message epoch, then decrypts
    // ciphertext. Same JSON shape as nativeDecryptMessage, or {"ok":false}. Never writes mls.bin.
    external fun nativeDecryptMessageWithCommits(
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        commitsJson: String,
        ciphertext: ByteArray
    ): String

    // Decrypts a channel-message push (AES-256-GCM). All args base64: raw 32-byte epoch key,
    // 12-byte nonce, ciphertext||tag. Returns the same JSON shape as nativeDecryptMessage,
    // or {"ok":false} on failure. Channel messages are NOT MLS (no state file involved).
    external fun nativeDecryptChannelMessage(
        keyB64: String,
        nonceB64: String,
        ciphertextB64: String
    ): String

    /**
     * Creates an MLS Welcome package for [keyPackageB64] in group [groupId].
     * Saves the updated MLS state to {filesDir}/mls.bin.
     * Returns JSON: {"ok":true,"welcome":"<b64>","ratchetTree":"<b64>|null","commit":"<b64>"}
     * or {"ok":false,"error":"..."}.
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
     * Applies a received MLS Welcome (RECEIVER side): joins the group and writes
     * {filesDir}/mls.bin. Lets a device join a new group while the app is closed, so the
     * 1st message of a conversation is decryptable by FCM without opening the app.
     * Returns true on success.
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
     * Encrypts a pending outgoing message (text/reply) against the live epoch and persists
     * {filesDir}/mls.bin. Returns JSON: {"ok":true,"ciphertext":"<b64>"} or {"ok":false,...}.
     * `protoB64` is the cleartext AppMessage proto (base64), built on the TS side at compose time.
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

    /**
     * Builds a plaintext `AppMessage` text proto (base64) for a notification quick-reply, without
     * touching MLS state - see [CanariNotificationActionReceiver]. Returns "" on failure.
     */
    external fun nativeBuildTextMessageProto(messageId: String, sentAt: Long, content: String): String

    /**
     * Builds a plaintext `AppMessage` read-receipt (system) proto (base64) for the "mark as read"
     * quick action. `messageIdsJson` is a JSON array of message id strings. Returns "" on failure.
     */
    external fun nativeBuildReadReceiptProto(messageIdsJson: String): String

    /** Structured result of the MLS decryption, extracted from the JSON returned by Rust. */
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
        Log.i(TAG, "onNewToken: new FCM token received")
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_FCM_TOKEN, token).apply()
        try {
            val dataDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }
            File(dataDir, "fcm_token.txt").writeText(token)
        } catch (e: Exception) {
            Log.w(TAG, "onNewToken: unable to write fcm_token.txt: ${e.message}")
        }
        // FCM2: push the new token to the backend WITHOUT waiting for the next foreground open.
        // A token rotated while the app is killed would stay stale server-side (push to a dead
        // token) until reopen. Best-effort via PushSecret; if the context/secret is missing (device
        // not enrolled yet), the foreground will register the token at the next startup.
        runWithWakeLock("fcm_token_refresh", 15_000L) {
            val ctx = MlsContextLoader.loadPushContext(this)
            val secret = retrievePushSecret(this)
            if (ctx == null || secret == null) {
                Log.d(TAG, "onNewToken: context/secret absent -> backend refresh deferred to foreground")
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

        // --- Foreground guard: a single MLS engine writes mls.bin at a time --------------
        // When the app is in the foreground, the Tauri MLS engine (WebView/Rust, in-memory state)
        // already handles everything via WebSocket and persists mls.bin. Letting the background JNI
        // path (FCM/Worker) process in parallel would clobber mls.bin: these are TWO distinct engines
        // sharing the same file with no common lock (MlsStateLock only covers FCM<->Worker).
        // Observed result: lost KeyPackages (n_secrets drops back to 1), epoch gaps, UseAfterEviction.
        // So we let the foreground handle it; the background only acts when the app is closed/backgrounded.
        // Pure notifications (social/form_reminder) do not touch mls.bin -> not concerned.
        if (MainActivity.isInForeground && msgType != "social" && msgType != "form_reminder") {
            Log.d(TAG, "App in foreground -> MLS handled by the foreground (WS), skip background processing")
            return
        }

        // Pending welcome request: an offline peer needs to be added to a group.
        // We handle it directly in the background (JNI + HTTP PushSecret) without opening the WebView.
        if (msgType == "welcome_request_pending") {
            val groupId       = data["groupId"] ?: ""
            val requesterUser = data["requesterUserId"] ?: ""
            val requesterDev  = data["requesterDeviceId"] ?: ""
            Log.d(TAG, "welcome_request_pending -> groupId=$groupId requester=$requesterUser:$requesterDev - full background processing")
            if (groupId.isEmpty() || requesterUser.isEmpty() || requesterDev.isEmpty()) {
                Log.e(TAG, "welcome_request_pending: missing fields -> abort")
                return
            }
            runWithWakeLock("welcome_bg", 90_000L) {
                processWelcomeRequestBackground(groupId, requesterUser, requesterDev)
            }
            return
        }

        // MLS Welcome package received: we JOIN the group in the background (JNI) so that the
        // 1st message of a conversation started while the app was closed is decryptable by FCM,
        // without waiting for the app to open. The ratchet tree is never in the FCM payload ->
        // it is fetched via fetch-proto.
        if (data["isWelcome"] == "true") {
            val groupId = data["groupId"] ?: ""
            val queuedMessageId = data["queuedMessageId"]
            val inlineProto = data["proto"]?.takeIf { it.isNotEmpty() }
            Log.d(TAG, "isWelcome=true -> groupId=$groupId qId=$queuedMessageId - background join")
            if (groupId.isEmpty()) {
                Log.e(TAG, "isWelcome: missing groupId -> abort")
                return
            }
            runWithWakeLock("welcome_join", 90_000L) {
                processReceivedWelcomeBackground(groupId, queuedMessageId, inlineProto)
            }
            return
        }

        // Social notifications and form reminders: no MLS decryption
        if (msgType == "social" || msgType == "form_reminder") {
            val title    = data["title"]  ?: "Canari"
            val body     = data["body"]   ?: ""
            // explicit deepLink (message reactions) > deepLink built from postId/formId
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

        // Community (channel) encrypted message: AES-256-GCM, key looked up in channel_keys.json.
        // Not MLS: no mls.bin, no MlsStateLock - decryption is stateless and read-only.
        if (msgType == "channel") {
            Log.d(TAG, "type=channel → groupId=${data["channelId"]} - background channel notification")
            runWithWakeLock("fcm_channel") {
                handleChannelMessage(data)
            }
            return
        }

        // Channel read on another of my devices: clear this device's notification for that channel
        // (cross-device read-state sync, channel counterpart of the MLS silent-receipt path below).
        // The reading device is in the foreground and already returned above; only background
        // sibling devices reach here. No decryption, no state - pure notification cancellation.
        if (msgType == "channel_read") {
            val channelId = data["channelId"] ?: ""
            if (channelId.isNotEmpty()) {
                Log.d(TAG, "type=channel_read → clearing notification for channel=$channelId")
                cancelConversationNotification(this, "channel_$channelId")
            }
            return
        }

        // Background MLS sync: decrypts and updates the state without a visible notification
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
                Log.d(TAG, "process_queue without groupId -> silent sync, no notification")
                return
            }
        }

        // Encrypted MLS message: decryption in a dedicated thread (max 60s).
        // Non-blocking for FCM: onMessageReceived returns immediately.
        // MLS_LOCK in tryDecrypt guarantees a single thread writes mls.bin at a time.
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
            // Welcome/message race: the concurrent Welcome push may be joining the group (or
            // holding MlsStateLock) when this message arrives. We retry briefly so the 1st message
            // of a new conversation produces a real notification instead of a generic fallback,
            // rather than showing then correcting the notification.
            var raceAttempt = 0
            while (!silent && decrypted == null && !queuedMessageId.isNullOrEmpty() && raceAttempt < WELCOME_RACE_RETRIES) {
                raceAttempt++
                try {
                    Thread.sleep(WELCOME_RACE_RETRY_DELAY_MS)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
                Log.d(TAG, "tryDecrypt retry $raceAttempt/$WELCOME_RACE_RETRIES (group-join race) group=$groupId")
                decrypted = tryDecrypt(queuedMessageId, groupId, inlineProto)
            }
            // Epoch gap: direct decryption failed. A common cause on a never-opened mobile is that a
            // device added to the group advanced the epoch (commit) that this device never applied in
            // the background (push decoding is read-only). We attempt an IN-MEMORY commit catch-up
            // (read-only, mls.bin unchanged) to produce a real notification instead of the generic
            // fallback.
            if (!silent && decrypted == null && !queuedMessageId.isNullOrEmpty()) {
                decrypted = tryDecryptWithCommitCatchup(queuedMessageId, groupId, inlineProto)
            }

            val body: String = decrypted?.text
                ?: run {
                    // Insufficient catch-up (no commit, below the floor, or group not joined yet):
                    // enqueue the worker to retry on the next cycle.
                    if (!queuedMessageId.isNullOrEmpty()) {
                        val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                            .build()
                        enqueueWorkerIfHealthy(workRequest)
                        Log.w(TAG, "Decryption failed -> MlsBackgroundWorker enqueued")
                    }
                    buildFallbackText(senderName).also { Log.w(TAG, "Fallback notification: $it") }
                }

            if (silent) {
                // A silent push whose senderId == my own userId means I just read or sent in this
                // conversation from ANOTHER device (read receipt or send echo). We then remove this
                // conversation's notification on this device: this is the "app killed" part of the
                // multi-device read-state sync. A peer's senderId (!= my userId) cancels nothing -
                // their read does not concern me.
                val myUserId = MlsContextLoader.loadPushContext(this)?.userId
                if (groupId.isNotEmpty() && senderId.isNotEmpty() && senderId.equals(myUserId, ignoreCase = true)) {
                    cancelConversationNotification(this, groupId)
                } else {
                    Log.d(TAG, "FCM silent -> MLS state updated, no notification shown")
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

            // Woken by this incoming message: try to send our own pending outgoing messages
            // (text/reply/control), without waiting for a Welcome push or a reopen. Since the
            // foreground guard (C1) is inactive in the background, writing mls.bin is allowed.
            // No-op if the outbox is empty. Notify if any remain (safety net).
            MlsContextLoader.loadPushContext(this)?.let { drainCtx ->
                val remaining = drainOutboxBackground(this, this, drainCtx)
                maybeNotifyPendingSync(remaining)
            }
        }
    }

    // --- Helpers ---------------------------------------------------------------

    /**
     * Enqueues a [MlsBackgroundWorker] only if the persistent failure flag is not set.
     * If the flag is set, the worker will not be enqueued until the user opens the app
     * (which calls [MlsBackgroundWorker.resetFailureFlag] from [MainActivity.onResume]).
     */
    private fun enqueueWorkerIfHealthy(workRequest: androidx.work.WorkRequest) {
        val failed = getSharedPreferences(MlsBackgroundWorker.PREFS_WORKER, Context.MODE_PRIVATE)
            .getBoolean(MlsBackgroundWorker.KEY_FAILED, false)
        if (failed) {
            Log.w(TAG, "enqueueWorkerIfHealthy: worker in persistent failure state -> ignored")
            return
        }
        WorkManager.getInstance(this).enqueue(workRequest)
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
     * Pushes the current FCM token to the backend via PushSecret (FCM2). Best-effort, never blocking.
     * Does NOT regenerate the pushSecret (unlike foreground /register): only the token changes.
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
     * Promotes this device's membership to 'active' server-side via PushSecret (FCM1).
     * Called after a successful background Welcome join: without it, the device stays 'pending'
     * and the recipient resolution (status='active') excludes it from message routing.
     * Best-effort, never blocking.
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

    // --- Background Welcome request processing ---------------------------------

    /**
     * Handles a `welcome_request_pending` received via FCM when the app is killed.
     * Sequence: acquire the Redis lock -> fetch the key package -> create the Welcome
     * via JNI -> send Welcome+commit to the backend -> release the lock.
     *
     * [MlsStateLock] is held ONLY during the JNI (mls.bin read + mls.bin write) so as not to
     * block the FCM decrypt threads during the HTTP calls and the Redis retries (which can sleep
     * 2s x 2 = 4s). Before this refactoring, MlsStateLock was held for the whole duration (~30s),
     * making tryDecrypt time out systematically.
     */
    private fun processWelcomeRequestBackground(
        groupId: String,
        requesterUserId: String,
        requesterDeviceId: String,
    ) {
        // File loads (read-only, outside the lock)
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "processWelcomeRequestBackground: push_context.json absent -> abort")
            return
        }
        val secret = retrievePushSecret(this)
        if (secret == null) {
            Log.e(TAG, "processWelcomeRequestBackground: pushSecret absent -> abort")
            return
        }

        // 1. Acquire the Redis add-lock (HTTP + retries) - outside MlsStateLock
        var lockAcquired = false
        for (attempt in 0..2) {
            lockAcquired = acquireAddLock(ctx, secret, groupId)
            if (lockAcquired) break
            Log.w(TAG, "processWelcomeRequestBackground: Redis lock not acquired (attempt ${attempt + 1}/3)")
            if (attempt < 2) Thread.sleep(2_000)
        }
        if (!lockAcquired) {
            Log.w(TAG, "processWelcomeRequestBackground: unable to acquire the lock for group=$groupId -> abort")
            return
        }
        Log.d(TAG, "processWelcomeRequestBackground: Redis lock acquired for group=$groupId")

        try {
            // 2. Fetch the requester's key package (HTTP) - outside MlsStateLock
            val keyPackage = fetchKeyPackage(ctx, secret, requesterUserId, requesterDeviceId)
            if (keyPackage == null) {
                Log.e(TAG, "processWelcomeRequestBackground: keyPackage not found for $requesterUserId:$requesterDeviceId -> abort")
                return
            }
            Log.d(TAG, "processWelcomeRequestBackground: keyPackage fetched (${keyPackage.length} chars)")

            // 3. Create the Welcome via Rust JNI - MlsStateLock only here
            //    (mls.bin read + Argon2 decryption + add_member + mls.bin write ~5-8s).
            // tryLock may throw InterruptedException if the FCM thread is interrupted by Android.
            val jniLockAcquired = try {
                MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.e(TAG, "processWelcomeRequestBackground: thread interrupted during tryLock: ${e.message}")
                return
            }
            if (!jniLockAcquired) {
                Log.w(TAG, "processWelcomeRequestBackground: MlsStateLock not acquired -> abort")
                return
            }
            val result: JSONObject
            try {
                val stateBytes = MlsContextLoader.loadMlsState(this)
                if (stateBytes == null) {
                    Log.e(TAG, "processWelcomeRequestBackground: mls.bin absent -> abort")
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
                Log.e(TAG, "processWelcomeRequestBackground: nativeCreateWelcomeBackground failed: ${result.optString("error")}")
                return
            }
            val welcomePayload  = result.getString("welcome")
            val ratchetTree     = result.optString("ratchetTree").takeIf { it.isNotEmpty() && it != "null" }
            val commitPayload   = result.getString("commit")
            // Base epoch before the add: the backend validates it (validateCommit) to keep its
            // activeEpoch counter in sync with the real epoch, otherwise foreground commits are
            // wrongly rejected (C6). -1 if absent (old JNI) -> the backend skips validation.
            val baseEpoch       = result.optLong("baseEpoch", -1L)
            Log.d(TAG, "processWelcomeRequestBackground: Welcome created, commit=${commitPayload.take(16)}… baseEpoch=$baseEpoch")

            // 4. Send Welcome + commit to the backend (HTTP) - outside MlsStateLock
            val sent = sendWelcomeAndCommit(
                ctx, secret, groupId,
                requesterUserId, requesterDeviceId,
                welcomePayload, ratchetTree, commitPayload, baseEpoch,
            )
            if (sent) {
                Log.d(TAG, "processWelcomeRequestBackground: ✓ Welcome sent for group=$groupId target=$requesterUserId:$requesterDeviceId")
            } else {
                Log.e(TAG, "processWelcomeRequestBackground: sendWelcomeAndCommit failed for group=$groupId")
            }
        } finally {
            // 5. Release the Redis lock in all cases
            releaseAddLock(ctx, secret, groupId)
            Log.d(TAG, "processWelcomeRequestBackground: Redis lock released for group=$groupId")
            // 6. Opportunistic: this device may also have pending messages - try to send them
            //    now that the app is awake, and notify if any remain.
            val remaining = drainOutboxBackground(this, this, ctx)
            maybeNotifyPendingSync(remaining)
        }
    }

    /** Acquires the Redis add-lock via the PushSecret endpoint. Returns true if acquired. */
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

    /** Releases the Redis add-lock via the PushSecret endpoint. */
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
     * Fetches the MLS KeyPackage (base64) of a target device via the PushSecret endpoint.
     * Returns null on failure.
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
     * Sends the Welcome to the target device and broadcasts the commit to all group members.
     * Returns true if the HTTP call succeeded (HTTP 201).
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

    // --- MLS decryption --------------------------------------------------------

    /**
     * Attempts to decrypt an MLS message in exclusive mode (MLS_LOCK).
     * The lock is acquired ONLY for mls.bin access and the JNI Argon2 - never
     * during the HTTP calls (fetchProtoFromBackend), so as not to block the other
     * FCM threads for the 5-11s a slow network fetch can take.
     */
    private fun tryDecrypt(
        queuedMessageId: String?,
        groupId: String,
        inlineProto: String?,
    ): DecryptedMessage? {
        if (queuedMessageId == null) {
            Log.w(TAG, "tryDecrypt: queuedMessageId absent -> abort")
            return null
        }

        // Load the push context (file read) before the lock - read-only, thread-safe.
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "tryDecrypt: push_context.json absent or invalid -> abort")
            return null
        }

        // Fetch the proto BEFORE acquiring MlsStateLock: fetchProtoFromBackend can take
        // up to ~11s (2 attempts x 5s timeout + 1s sleep). Holding the lock during that
        // time would block tryDecrypt on the other threads for the whole duration.
        val protoB64: String = inlineProto
            ?: fetchProtoFromBackend(queuedMessageId, ctx)
                .also { if (it == null) Log.e(TAG, "tryDecrypt: fetchProtoFromBackend failed") }
            ?: return null

        // Acquire the lock only for mls.bin + Argon2/JNI (~3-5s max).
        // tryLock may throw InterruptedException if the thread is interrupted by Android
        // under memory pressure. We restore the interrupt flag so as not to swallow it.
        val lockAcquired = try {
            MlsStateLock.LOCK.tryLock(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "tryDecrypt: thread interrupted during tryLock MlsStateLock: ${e.message}")
            return null
        }
        if (!lockAcquired) {
            Log.w(TAG, "tryDecrypt: MlsStateLock not acquired after 5s -> abort (another thread is decrypting)")
            return null
        }
        try {
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.e(TAG, "tryDecrypt: mls.bin absent -> abort")
                return null
            }
            Log.d(TAG, "tryDecrypt: MLS state loaded (${stateBytes.size} bytes), userId=${ctx.userId} deviceId=${ctx.deviceId}")
            return decryptProto(stateBytes, ctx.pin, ctx.userId, ctx.deviceId, groupId, protoB64)
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

    private fun fetchProtoFromBackend(queuedMessageId: String, ctx: PushContext): String? {
        val secret = retrievePushSecret(this)
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
        Log.e(TAG, "fetchProtoFromBackend: failed after 2 attempts: ${lastException?.message}")
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
            Log.d(TAG, "doFetchProto: proto received=${proto != null} (${proto?.length ?: 0} chars)")
            return proto
        } finally {
            conn.disconnect()
        }
    }

    // --- Background processing of a received Welcome (receiver side) -----------

    /**
     * Joins a group via a Welcome received in the background, then enqueues the worker to
     * drain any already-queued messages. MlsStateLock is held only during the JNI
     * (mls.bin read + Argon2 + mls.bin write), never during the HTTP calls.
     */
    private fun processReceivedWelcomeBackground(
        groupId: String,
        queuedMessageId: String?,
        inlineProto: String?,
    ) {
        val ctx = MlsContextLoader.loadPushContext(this)
        if (ctx == null) {
            Log.e(TAG, "processReceivedWelcomeBackground: push_context.json absent -> abort")
            return
        }

        // Welcome + ratchet tree: the ratchet tree is never included in the FCM push,
        // so we always fetch it via fetch-proto (which also returns the proto).
        var welcomeB64 = inlineProto
        var ratchetTreeB64 = ""
        if (queuedMessageId != null) {
            val secret = retrievePushSecret(this)
            if (secret != null) {
                val bundle = fetchWelcomeBundle(queuedMessageId, ctx, secret)
                if (bundle != null) {
                    if (welcomeB64.isNullOrEmpty()) welcomeB64 = bundle.first
                    ratchetTreeB64 = bundle.second
                }
            }
        }
        if (welcomeB64.isNullOrEmpty()) {
            Log.e(TAG, "processReceivedWelcomeBackground: Welcome bytes not found -> abort")
            return
        }

        val jniLockAcquired = try {
            MlsStateLock.LOCK.tryLock(10, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "processReceivedWelcomeBackground: interrupted during tryLock: ${e.message}")
            return
        }
        if (!jniLockAcquired) {
            Log.w(TAG, "processReceivedWelcomeBackground: MlsStateLock not acquired -> abort")
            return
        }
        val joined: Boolean
        try {
            val stateBytes = MlsContextLoader.loadMlsState(this)
            if (stateBytes == null) {
                Log.e(TAG, "processReceivedWelcomeBackground: mls.bin absent -> abort")
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
            Log.d(TAG, "processReceivedWelcomeBackground: ✓ group joined group=$groupId")
            // FCM1: promote the membership to 'active' server-side. The JNI join does not go through
            // the foreground path (updateInvitationStatus), so without this call the device stays
            // 'pending' and is never routed as a recipient of subsequent messages (neither real-time
            // nor push). PushSecret because the app may be killed (no JWT). Best-effort.
            retrievePushSecret(this)?.let { markMembershipActive(ctx, it, groupId) }
            // The group now exists: drain the queue to process the pending messages.
            val workRequest = OneTimeWorkRequestBuilder<MlsBackgroundWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                .build()
            enqueueWorkerIfHealthy(workRequest)
        } else {
            Log.e(TAG, "processReceivedWelcomeBackground: join failed group=$groupId")
        }

        // The group may have just been joined: try to send the pending outgoing messages,
        // and notify the user if any remain (safety net of the background send).
        val remaining = drainOutboxBackground(this, this, ctx)
        maybeNotifyPendingSync(remaining)
    }

    /** Fetches the (proto, ratchetTree) pair of a queued Welcome via the PushSecret endpoint. */
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

    // --- Background outbox send (outgoing messages, app killed) ----------------
    //
    // Relocated to top-level `internal` functions below the class (see OutboxMirrorEntry /
    // drainOutboxBackground / readOutboxMirror / etc. near the end of this file): they take an
    // explicit `context: Context` instead of the implicit Service-as-Context, so
    // CanariNotificationActionReceiver (quick reply / mark as read) can reuse them without
    // duplicating the outbox-drain logic.

    /** Shows the "messages pending" nudge if sends remain queued and the app is closed. */
    private fun maybeNotifyPendingSync(remaining: Int) {
        if (remaining <= 0) return
        if (MainActivity.isInForeground) return
        showPendingSyncNotification()
    }

    /**
     * Soft notification inviting the user to open the app to flush the outbox (safety net of the
     * background send). Stable ID + messages channel: it clears itself when the app opens
     * (cancelAllMessageNotifications in MainActivity.onResume), for this reason or another.
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
        Log.d(TAG, "showPendingSyncNotification: nudge shown (id=$PENDING_SYNC_NOTIF_ID)")
    }

    /** Parses the JSON returned by nativeDecryptMessage and returns a structured DecryptedMessage. */
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
                Log.w(TAG, "decryptProto: ok=false -> decryption failed")
                return null
            }
            val text = json.optString("text").takeIf { it.isNotEmpty() } ?: return null
            Log.d(TAG, "decryptProto: success type=${json.optString("type")} -> \"${text.take(60)}\"")
            DecryptedMessage(
                text      = text.take(200),
                messageId = json.optString("messageId"),
                sentAt    = json.optLong("sentAt", System.currentTimeMillis()),
                type      = json.optString("type", "text"),
                replyTo   = json.optJSONObject("replyTo"),
                mediaKind = json.optString("mediaKind").takeIf { it.isNotEmpty() },
            )
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "decryptProto: native library not loaded: ${e.message}")
            null
        } catch (e: Exception) {
            Log.e(TAG, "decryptProto: exception: ${e.message}")
            null
        }
    }

    /**
     * Read-only in-memory commit catch-up for a push whose epoch is AHEAD of the persisted mls.bin.
     *
     * A device added to the group advanced the epoch via a commit; a never-opened mobile only ran the
     * read-only [decryptProto] (which discards commits), so it stays behind and the newcomer's first
     * message fails as an epoch gap. Here we read the current epoch, fetch the missing ordered commits
     * (PushSecret), and apply them in memory to decrypt this message - producing a real notification
     * instead of a generic fallback. NEVER persists mls.bin; the foreground commit-log replay catches
     * the durable state up on next open. Returns null (caller falls back) when no commits are
     * available or the message still cannot be decrypted.
     */
    private fun tryDecryptWithCommitCatchup(
        queuedMessageId: String?,
        groupId: String,
        inlineProto: String?,
    ): DecryptedMessage? {
        if (queuedMessageId.isNullOrEmpty() || groupId.isEmpty()) return null
        val ctx = MlsContextLoader.loadPushContext(this) ?: return null
        val secret = retrievePushSecret(this) ?: return null

        // Fetch the ciphertext (outside the lock, as tryDecrypt does).
        val protoB64: String = inlineProto ?: fetchProtoFromBackend(queuedMessageId, ctx) ?: return null
        val cipherBytes = try {
            Base64.decode(protoB64, Base64.DEFAULT)
        } catch (e: Exception) {
            Log.e(TAG, "catchup: proto base64 invalid: ${e.message}"); return null
        }

        // 1) Read the current epoch (brief lock: mls.bin + Argon2 via JNI).
        val epoch = withMlsStateLock(5) {
            val stateBytes = MlsContextLoader.loadMlsState(this) ?: return@withMlsStateLock -1L
            nativeGroupEpoch(stateBytes, ctx.pin, ctx.userId, ctx.deviceId, groupId)
        } ?: return null
        if (epoch < 0) {
            Log.w(TAG, "catchup: epoch unknown for group=$groupId -> abort")
            return null
        }

        // 2) Fetch the ordered commits since our epoch (outside the lock: HTTP).
        val commitsJson = fetchCommitsFromBackend(groupId, epoch, ctx, secret)
        if (commitsJson == null || commitsJson == "[]") {
            Log.d(TAG, "catchup: no commit to catch up (epoch=$epoch) -> fallback")
            return null
        }

        // 3) Apply the commits in memory and decrypt (brief lock: mls.bin + Argon2 via JNI).
        return withMlsStateLock(5) {
            val stateBytes = MlsContextLoader.loadMlsState(this) ?: return@withMlsStateLock null
            decryptProtoWithCommits(stateBytes, ctx.pin, ctx.userId, ctx.deviceId, groupId, commitsJson, cipherBytes)
        }
    }

    /** Runs [block] holding [MlsStateLock] for up to [timeoutSec]s; returns null if not acquired. */
    private fun <T> withMlsStateLock(timeoutSec: Long, block: () -> T): T? {
        val acquired = try {
            MlsStateLock.LOCK.tryLock(timeoutSec, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "withMlsStateLock: interrupted: ${e.message}")
            return null
        }
        if (!acquired) {
            Log.w(TAG, "withMlsStateLock: lock not acquired after ${timeoutSec}s")
            return null
        }
        return try {
            block()
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

    /** Parses the JSON from nativeDecryptMessageWithCommits into a DecryptedMessage (mirror of decryptProto). */
    private fun decryptProtoWithCommits(
        stateBytes: ByteArray,
        pin: String,
        userId: String,
        deviceId: String,
        groupId: String,
        commitsJson: String,
        cipherBytes: ByteArray,
    ): DecryptedMessage? {
        return try {
            val jsonStr = nativeDecryptMessageWithCommits(stateBytes, pin, userId, deviceId, groupId, commitsJson, cipherBytes)
            val json = JSONObject(jsonStr)
            if (!json.optBoolean("ok", false)) {
                Log.w(TAG, "decryptProtoWithCommits: ok=false -> catch-up insufficient")
                return null
            }
            val text = json.optString("text").takeIf { it.isNotEmpty() } ?: return null
            Log.d(TAG, "decryptProtoWithCommits: success after catch-up -> \"${text.take(60)}\"")
            DecryptedMessage(
                text      = text.take(200),
                messageId = json.optString("messageId"),
                sentAt    = json.optLong("sentAt", System.currentTimeMillis()),
                type      = json.optString("type", "text"),
                replyTo   = json.optJSONObject("replyTo"),
                mediaKind = json.optString("mediaKind").takeIf { it.isNotEmpty() },
            )
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "decryptProtoWithCommits: native library not loaded: ${e.message}"); null
        } catch (e: Exception) {
            Log.e(TAG, "decryptProtoWithCommits: exception: ${e.message}"); null
        }
    }

    /**
     * Fetches the ordered replayable commits for [groupId] with baseEpoch >= [sinceEpoch] via the
     * PushSecret endpoint, and returns them as a JSON array of base64 commit strings
     * (`["b64",...]`, the shape nativeDecryptMessageWithCommits expects), or null on failure.
     */
    private fun fetchCommitsFromBackend(
        groupId: String,
        sinceEpoch: Long,
        ctx: PushContext,
        secret: String,
    ): String? {
        return try {
            val url = URL("${ctx.baseUrl}/api/mls/push/commits")
            val payload = JSONObject().apply {
                put("userId", ctx.userId)
                put("deviceId", ctx.deviceId)
                put("groupId", groupId)
                put("sinceEpoch", sinceEpoch)
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
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code != 200 && code != 201) {
                    Log.e(TAG, "fetchCommitsFromBackend: HTTP $code")
                    return null
                }
                val text = conn.inputStream.bufferedReader().use { it.readText() }
                val commits = JSONObject(text).optJSONArray("commits") ?: return "[]"
                // Keep only the ordered base64 commit protos - the shape the native catch-up expects.
                val protos = JSONArray()
                for (i in 0 until commits.length()) {
                    val proto = commits.optJSONObject(i)?.optString("proto")
                    if (!proto.isNullOrEmpty()) protos.put(proto)
                }
                Log.d(TAG, "fetchCommitsFromBackend: ${protos.length()} commit(s) since epoch=$sinceEpoch")
                protos.toString()
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "fetchCommitsFromBackend: exception: ${e.message}")
            null
        }
    }

    /**
     * Writes an entry to fcm_message_cache.ndjson so the app can
     * pre-inject the message into IndexedDB at boot (before the MLS sync).
     * The file is bounded to [MAX_FCM_CACHE_ENTRIES] lines to avoid unbounded
     * growth when the app stays closed for a long time and receives many notifications.
     */
    private fun writeFcmCache(
        groupId: String,
        senderId: String,
        senderName: String,
        msg: DecryptedMessage,
    ) {
        if (msg.messageId.isEmpty()) {
            Log.w(TAG, "writeFcmCache: messageId empty -> entry ignored")
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
                // Keep at most MAX_FCM_CACHE_ENTRIES lines: read, truncate, rewrite.
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
            Log.w(TAG, "writeFcmCache: failed: ${e.message}")
        }
    }

    // --- Avatar ----------------------------------------------------------------

    /** Cache file for a userId's avatar (filesystem-safe name). */
    private fun avatarCacheFile(userId: String): File {
        val safeId = userId.replace(Regex("[^a-zA-Z0-9_-]"), "_").take(40)
        return File(filesDir, "avatar_$safeId.jpg")
    }

    /**
     * Downloads the sender's avatar, with a 24h file cache.
     * The cache avoids the HTTP request when the app is in the background and
     * the network is slow or PushSecretKeystore.retrieve() is unstable.
     */
    private fun fetchAvatar(userId: String): Bitmap? {
        // 1. Read the file cache if recent (< 24h) - no need for the Keystore or the network
        val cacheFile = avatarCacheFile(userId)
        val now = System.currentTimeMillis()
        if (cacheFile.exists() && (now - cacheFile.lastModified()) < AVATAR_CACHE_MAX_AGE_MS) {
            BitmapFactory.decodeFile(cacheFile.absolutePath)?.let { bmp ->
                Log.d(TAG, "fetchAvatar: from cache for ${userId.take(8)}")
                return circleCrop(bmp)
            }
        }

        // 2. HTTP fetch (app in foreground or cache expired)
        val ctx    = MlsContextLoader.loadPushContext(this) ?: return null
        val secret = retrievePushSecret(this) ?: return null
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
                    // Save to cache for the next notifications
                    try {
                        cacheFile.writeBytes(bytes)
                        Log.d(TAG, "fetchAvatar: avatar cached for ${userId.take(8)}")
                    } catch (e: Exception) {
                        Log.w(TAG, "fetchAvatar: unable to save the cache: ${e.message}")
                    }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { circleCrop(it) }
                } else {
                    Log.d(TAG, "fetchAvatar: HTTP $code for $userId -> initials fallback")
                    null
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.d(TAG, "fetchAvatar: ${e.message} -> initials fallback")
            null
        }
    }

    /** Crops a bitmap into a circle (for the notification icon). */
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

    /** Generates a circular bitmap with the first letter of the name (fallback when no avatar). */
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

    // --- Notification display --------------------------------------------------
    //
    // getStableNotifId / cancelConversationNotification live in the companion object above
    // (shared with CanariNotificationActionReceiver).

    /**
     * Shows (or updates) a notification for an MLS message (DM or group).
     * A single stable ID per conversation: each new message overwrites the previous
     * notification instead of stacking a new one.
     * Suppressed if the app is in the foreground: the WebSocket already delivered the message to the UI.
     */
    private fun showNotification(
        senderName: String,
        groupName: String,
        body: String,
        largeIcon: Bitmap,
        groupId: String,
    ) {
        if (MainActivity.isInForeground) {
            Log.d(TAG, "showNotification: app in foreground -> notification suppressed (groupId=${groupId.take(8)})")
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureNotificationChannels(manager)

        val isGroup = groupName.isNotEmpty() && groupName != senderName

        // Stable ID per conversation: notify() with the same ID updates the existing notification
        val notifId = if (groupId.isNotEmpty()) getStableNotifId(this, groupId) else 0

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            setData(android.net.Uri.parse("fr.emse.canari://chat/$groupId"))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // MessagingStyle: successive messages of the same conversation STACK instead of
        // replacing each other. We rebuild the style from the active notification (if present),
        // bounding the history to MAX_NOTIF_MESSAGES to avoid unbounded growth.
        val senderPerson = Person.Builder()
            .setName(senderName.ifEmpty { "Canari" })
            .setIcon(IconCompat.createWithBitmap(largeIcon))
            .build()
        val selfPerson = Person.Builder().setName("Moi").build()

        val existingNotif = try {
            manager.activeNotifications.firstOrNull { it.id == notifId }?.notification
        } catch (e: Exception) {
            Log.w(TAG, "showNotification: activeNotifications unavailable: ${e.message}")
            null
        }

        val style = NotificationCompat.MessagingStyle(selfPerson)
        if (isGroup) {
            style.conversationTitle = groupName
            style.isGroupConversation = true
        }
        // Re-inject the previous (bounded) messages, then add the new one.
        existingNotif
            ?.let { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?.messages
            ?.takeLast(MAX_NOTIF_MESSAGES - 1)
            ?.forEach { style.addMessage(it) }
        style.addMessage(body, System.currentTimeMillis(), senderPerson)

        val notifBuilder = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setStyle(style)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setLargeIcon(largeIcon)
            .setGroup(GROUP_KEY_MESSAGES)

        // Quick actions (WP-XP-1): MLS-only (DM/group), never on a channel_ conversation - channels
        // are server-authoritative and do not go through the MLS outbox (see outbox.ts isChannelConversationId).
        if (groupId.isNotEmpty() && !groupId.startsWith("channel_")) {
            notifBuilder.addAction(buildReplyAction(groupId, notifId))
            notifBuilder.addAction(buildMarkReadAction(groupId, notifId))
        }

        val notif = notifBuilder.build()

        Log.d(TAG, "showNotification: notifId=$notifId messages=${style.messages.size} group=$isGroup")
        manager.notify(notifId, notif)

        // Rebuild the group summary and refresh the launcher badge count (WP-XP-2) now that this
        // conversation's notification is active.
        refreshBadgeSummary(this)
    }

    /**
     * Builds the inline "Repondre" action (RemoteInput text field), routed to
     * [CanariNotificationActionReceiver]. Its PendingIntent MUST be mutable: RemoteInput writes the
     * typed text into the intent extras when the system delivers the broadcast, which
     * `FLAG_IMMUTABLE` would silently drop.
     */
    private fun buildReplyAction(groupId: String, notifId: Int): NotificationCompat.Action {
        val remoteInput = RemoteInput.Builder(KEY_TEXT_REPLY)
            .setLabel(getString(R.string.notif_action_reply))
            .build()
        val intent = Intent(this, CanariNotificationActionReceiver::class.java).apply {
            action = ACTION_QUICK_REPLY
            putExtra(EXTRA_GROUP_ID, groupId)
        }
        val pendingIntent = PendingIntent.getBroadcast(
            this, notifId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        return NotificationCompat.Action.Builder(
            R.drawable.ic_notification, getString(R.string.notif_action_reply), pendingIntent
        ).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build()
    }

    /** Builds the "Marquer comme lu" action, routed to [CanariNotificationActionReceiver]. */
    private fun buildMarkReadAction(groupId: String, notifId: Int): NotificationCompat.Action {
        val intent = Intent(this, CanariNotificationActionReceiver::class.java).apply {
            action = ACTION_MARK_READ
            putExtra(EXTRA_GROUP_ID, groupId)
        }
        // A distinct requestId (notifId + 1) so this PendingIntent does not collide/merge with the
        // reply action's (same notifId would make FLAG_UPDATE_CURRENT overwrite one with the other).
        val pendingIntent = PendingIntent.getBroadcast(
            this, notifId + 1, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Action.Builder(
            R.drawable.ic_notification, getString(R.string.notif_action_mark_read), pendingIntent
        ).build()
    }

    /**
     * Shows a simple notification (social or form) without MLS decryption.
     * The channel is chosen according to the notification type.
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

    // --- Channel (community) message push --------------------------------------

    /**
     * Decrypts a channel-message push and shows a notification. The epoch key is read from the
     * app-private `channel_keys.json` mirror (written by the foreground); the inline ciphertext is
     * AES-256-GCM-decrypted natively so the plaintext never transits FCM. Falls back to a generic
     * body when the key is missing (channel not yet hydrated) or the ciphertext was too large to
     * inline (omitted server-side).
     */
    private fun handleChannelMessage(data: Map<String, String>) {
        val channelId   = data["channelId"] ?: ""
        val channelName = data["channelName"]?.takeIf { it.isNotEmpty() } ?: "Salon"
        val keyVersion  = data["keyVersion"] ?: ""
        val ciphertext  = data["ciphertext"]?.takeIf { it.isNotEmpty() }
        val nonce       = data["nonce"]?.takeIf { it.isNotEmpty() }
        val senderId    = data["senderId"] ?: ""
        if (channelId.isEmpty()) {
            Log.e(TAG, "handleChannelMessage: channelId missing -> abort")
            return
        }
        // The app addresses channels as `channel_<uuid>`; use it for the deep link + stable notif id.
        val conversationId = "channel_$channelId"

        val keyB64 = if (ciphertext != null && nonce != null) lookupChannelKey(channelId, keyVersion) else null
        val body: String = if (keyB64 != null && ciphertext != null && nonce != null) {
            try {
                val json = JSONObject(nativeDecryptChannelMessage(keyB64, nonce, ciphertext))
                if (json.optBoolean("ok", false)) {
                    json.optString("text").takeIf { it.isNotEmpty() }?.take(200)
                        ?: buildChannelFallbackText(channelName)
                } else {
                    Log.w(TAG, "handleChannelMessage: decrypt ok=false channel=$channelId")
                    buildChannelFallbackText(channelName)
                }
            } catch (e: Exception) {
                Log.e(TAG, "handleChannelMessage: decrypt exception: ${e.message}")
                buildChannelFallbackText(channelName)
            }
        } else {
            Log.d(TAG, "handleChannelMessage: no key/ciphertext → generic notification channel=$channelId")
            buildChannelFallbackText(channelName)
        }

        val avatarBitmap = if (senderId.isNotEmpty()) fetchAvatar(senderId) else null
        val largeIcon    = avatarBitmap ?: generateInitialsBitmap(channelName)
        Log.d(TAG, "handleChannelMessage: showNotification channel=#$channelName body=${body.take(60)}")
        showNotification(
            senderName = "#$channelName",
            groupName  = "",
            body       = body,
            largeIcon  = largeIcon,
            groupId    = conversationId,
        )
    }

    /** Looks up the raw epoch key (base64) for a channel/keyVersion in `channel_keys.json`, or null. */
    private fun lookupChannelKey(channelId: String, keyVersion: String): String? {
        return try {
            val file = File(MlsContextLoader.tauriDataDir(this), "channel_keys.json")
            if (!file.exists()) {
                Log.w(TAG, "lookupChannelKey: channel_keys.json absent")
                return null
            }
            JSONObject(file.readText())
                .optJSONObject(channelId)
                ?.optString(keyVersion)
                ?.takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            Log.e(TAG, "lookupChannelKey: ${e.message}")
            null
        }
    }

    /** Generic channel notification body used when the message cannot be decrypted. */
    private fun buildChannelFallbackText(channelName: String): String =
        "Nouveau message dans #$channelName"

    /** Fallback text used when MLS decryption fails (group not yet initialized). */
    private fun buildFallbackText(senderName: String): String =
        if (senderName.isNotEmpty()) "Nouveau message de $senderName"
        else "Vous avez reçu un message chiffré"

    private fun ensureNotificationChannels(manager: NotificationManager) =
        CanariApplication.ensureChannels(manager)
}
