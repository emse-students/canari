package fr.emse.canari

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import androidx.core.app.RemoteInput
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Handles the notification quick actions (WP-XP-1): inline "Repondre" (RemoteInput) and
 * "Marquer comme lu", fired from the shade while the app may be fully killed.
 *
 * Both actions reuse [CanariFirebaseMessagingService]'s outbox-drain machinery unchanged (same
 * `outbox_pending.ndjson` mirror, same `drainOutboxBackground`/`nativeSendMessageBackground` path
 * the background welcome-join/decrypt flows already use) - only the plaintext `AppMessage` proto
 * is built differently, via [CanariFirebaseMessagingService.nativeBuildTextMessageProto] /
 * [CanariFirebaseMessagingService.nativeBuildReadReceiptProto] (no TS runtime involved). Never
 * fires for a `channel_` conversation id: channels are server-authoritative and do not use the
 * MLS outbox (see `outbox.ts` `isChannelConversationId`); [CanariFirebaseMessagingService] never
 * attaches these actions to a channel notification in the first place.
 */
class CanariNotificationActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "CanariNotifAction"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val groupId = intent.getStringExtra(CanariFirebaseMessagingService.EXTRA_GROUP_ID)
        if (groupId.isNullOrEmpty()) {
            Log.w(TAG, "onReceive: groupId missing for action=${intent.action}")
            return
        }
        val appContext = context.applicationContext
        val pendingResult = goAsync()
        val wakeLock = (appContext.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:notif_action")
        wakeLock.acquire(30_000L)
        Thread(null, {
            try {
                when (intent.action) {
                    CanariFirebaseMessagingService.ACTION_QUICK_REPLY ->
                        handleReply(appContext, intent, groupId)
                    CanariFirebaseMessagingService.ACTION_MARK_READ ->
                        handleMarkRead(appContext, groupId)
                    CanariFirebaseMessagingService.ACTION_CALL_DECLINE ->
                        handleCallDecline(appContext, intent)
                    else -> Log.w(TAG, "onReceive: unknown action ${intent.action}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "onReceive: exception: ${e.message}")
            } finally {
                if (wakeLock.isHeld) wakeLock.release()
                pendingResult.finish()
            }
        }, "canari-notif-action").start()
    }

    /**
     * Builds a text `AppMessage` proto for the typed reply, queues it into the same
     * `outbox_pending.ndjson` mirror the TS composer writes to, and drains it immediately.
     * Clears the local notification only once actually delivered (drain returns 0 remaining) -
     * a queued-but-undelivered reply must keep the notification so the user can retry from the app.
     */
    private fun handleReply(context: Context, intent: Intent, groupId: String) {
        val text = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(CanariFirebaseMessagingService.KEY_TEXT_REPLY)
            ?.toString()?.trim()
        if (text.isNullOrEmpty()) {
            Log.w(TAG, "handleReply: empty text -> abort")
            return
        }
        val pushCtx = MlsContextLoader.loadPushContext(context)
        if (pushCtx == null) {
            Log.e(TAG, "handleReply: push_context.json absent -> abort")
            return
        }
        val service = CanariFirebaseMessagingService()
        val messageId = UUID.randomUUID().toString()
        val sentAt = System.currentTimeMillis()
        val protoB64 = service.nativeBuildTextMessageProto(messageId, sentAt, text)
        if (protoB64.isEmpty()) {
            Log.e(TAG, "handleReply: nativeBuildTextMessageProto failed")
            return
        }

        val entries = CanariFirebaseMessagingService.readOutboxMirror(context) +
            CanariFirebaseMessagingService.OutboxMirrorEntry(
                messageId, groupId, protoB64, sentAt, silent = false
            )
        CanariFirebaseMessagingService.rewriteOutboxMirror(context, entries)
        Log.d(TAG, "handleReply: queued id=${messageId.take(8)} group=${groupId.take(8)}")

        val remaining = CanariFirebaseMessagingService.drainOutboxBackground(context, service, pushCtx)
        if (remaining == 0) {
            CanariFirebaseMessagingService.cancelConversationNotification(context, groupId)
        } else {
            Log.w(TAG, "handleReply: reply still queued (remaining=$remaining) - notification left as-is")
        }
    }

    /**
     * Clears this device's local notification immediately (visible part of "mark as read"), then
     * best-effort sends a silent `read_receipt` system event for every cached message of this
     * conversation, reusing the same silent-push cross-device-cancel path already used when a
     * conversation is read in the foreground (see `CanariFirebaseMessagingService.onMessageReceived`
     * silent-push handling). No cached messageId (cache evicted/never decrypted) -> notification is
     * still cleared, just no receipt is sent.
     */
    private fun handleMarkRead(context: Context, groupId: String) {
        CanariFirebaseMessagingService.cancelConversationNotification(context, groupId)

        val messageIds = readCachedMessageIdsForGroup(context, groupId)
        if (messageIds.isEmpty()) {
            Log.d(TAG, "handleMarkRead: no cached messageId for group=${groupId.take(8)} - notif cleared, no receipt sent")
            return
        }
        val pushCtx = MlsContextLoader.loadPushContext(context)
        if (pushCtx == null) {
            Log.e(TAG, "handleMarkRead: push_context.json absent -> abort receipt")
            return
        }
        val service = CanariFirebaseMessagingService()
        val protoB64 = service.nativeBuildReadReceiptProto(JSONArray(messageIds).toString())
        if (protoB64.isEmpty()) {
            Log.e(TAG, "handleMarkRead: nativeBuildReadReceiptProto failed")
            return
        }

        val entries = CanariFirebaseMessagingService.readOutboxMirror(context) +
            CanariFirebaseMessagingService.OutboxMirrorEntry(
                UUID.randomUUID().toString(), groupId, protoB64, System.currentTimeMillis(), silent = true
            )
        CanariFirebaseMessagingService.rewriteOutboxMirror(context, entries)
        CanariFirebaseMessagingService.drainOutboxBackground(context, service, pushCtx)
        Log.d(TAG, "handleMarkRead: read receipt queued+drained for ${messageIds.size} message(s) group=${groupId.take(8)}")
    }

    /**
     * Reads `fcm_message_cache.ndjson` (bounded, written by
     * [CanariFirebaseMessagingService] on every decrypted push - see `writeFcmCache`) and returns
     * the messageIds cached for [groupId].
     */
    private fun readCachedMessageIdsForGroup(context: Context, groupId: String): List<String> {
        return try {
            val file = File(MlsContextLoader.tauriDataDir(context), "fcm_message_cache.ndjson")
            if (!file.exists()) return emptyList()
            file.readLines().filter { it.isNotBlank() }.mapNotNull { line ->
                try {
                    val o = JSONObject(line)
                    if (o.optString("groupId") == groupId) {
                        o.optString("messageId").takeIf { it.isNotEmpty() }
                    } else null
                } catch (e: Exception) {
                    null
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "readCachedMessageIdsForGroup: ${e.message}")
            emptyList()
        }
    }

    /**
     * Declines an incoming-call ring (WP-XP-5): stops the local ring only. No MLS hangup is sent -
     * in a group call "decline" means "stop ringing me", not "end the call for everyone"; the
     * caller side stops on its own timeout, on ring-end, or when someone answers.
     */
    private fun handleCallDecline(context: Context, intent: Intent) {
        val callId = intent.getStringExtra(CanariFirebaseMessagingService.EXTRA_CALL_ID) ?: ""
        Log.d(TAG, "handleCallDecline: call=$callId")
        CanariFirebaseMessagingService.cancelIncomingCallNotification(context, callId)
    }
}
