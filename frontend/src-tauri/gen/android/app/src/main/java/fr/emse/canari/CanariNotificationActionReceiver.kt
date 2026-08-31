package fr.emse.canari

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import androidx.core.app.RemoteInput
import java.util.UUID

/**
 * Handles the notification quick actions (WP-XP-1): inline "Repondre" (RemoteInput) and
 * "Marquer comme lu", fired from the shade while the app may be fully killed.
 *
 * Both actions reuse [CanariFirebaseMessagingService]'s outbox-drain machinery unchanged (same
 * `outbox_pending.ndjson` mirror, same `drainOutboxBackground`/`nativeSendMessagesBackground` path
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
                        handleMarkRead(appContext, intent, groupId)
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
     * Clears the local notification only once actually delivered (drain returns 0 remaining);
     * an undelivered reply keeps its notification, but RE-POSTED - see the failure branch, and
     * [CanariFirebaseMessagingService.repostReplyPending] for why leaving it alone showed the user
     * a spinner that never ends.
     *
     * A delivered reply is also written to `fcm_message_cache.ndjson` under OUR user id, because
     * nothing else records it locally: the proto is built natively and never becomes a TypeScript
     * outbox entry, and `reconcileOutboxSent` only deletes entries. Peers received the message,
     * the sender's own conversation showed no trace of it, and the two are indistinguishable from
     * the app - which is exactly the "the reply does not work" report.
     */
    private fun handleReply(context: Context, intent: Intent, groupId: String) {
        val notifiedAt = intent.getLongExtra(CanariFirebaseMessagingService.EXTRA_SENT_AT, 0L)
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
                messageId, groupId, protoB64, sentAt, silent = false, durable = true
            )
        CanariFirebaseMessagingService.rewriteOutboxMirror(context, entries)
        Log.d(TAG, "handleReply: queued id=${messageId.take(8)} group=${groupId.take(8)}")

        val remaining = CanariFirebaseMessagingService.drainOutboxBackground(context, service, pushCtx)
        if (remaining == 0) {
            // Delivered: record it locally BEFORE clearing the notification, so the one visible
            // trace of the reply is never dropped before the durable one exists.
            CanariFirebaseMessagingService.writeSentMessageToCache(
                context, groupId, pushCtx.userId, messageId, text, sentAt
            )
            CanariFirebaseMessagingService.cancelConversationNotification(context, groupId)
            // ANSWERING A CONVERSATION IS READING IT (product decision, 2026-08-31). Only on the
            // delivered branch: a reply still sitting in the outbox has not been seen by anyone,
            // and announcing a read state for it would state something no peer can yet corroborate.
            sendReadWatermark(context, groupId, notifiedAt)
        } else {
            // Not delivered: NO cache entry, or the app would show as sent a message that never
            // left. The entry stays in outbox_pending.ndjson - where `adoptOrphanedMirrorEntries`
            // (outboxMirror.ts) picks it up at the next login and turns it into a real TypeScript
            // outbox entry plus a local message, instead of it being erased by the next
            // `store_outbox_mirror`. Nothing is lost. But leaving it THERE was not enough, and the
            // two things missing here were the whole of what the user saw:
            //  - the notification must be RE-POSTED. Android consumed the RemoteInput the moment
            //    this action fired and draws an indeterminate spinner it never resolves, so
            //    "the notification stays up as the retry affordance" was false - it stayed up with
            //    the actions gone and a spinner running, for good.
            //  - a deferred retry must be ENQUEUED. Nothing scheduled one here, so a reply that
            //    failed waited for the next LOGIN, where the FCM drain's own failure path has had
            //    a 30s/60s/120s backoff all along.
            Log.w(TAG, "handleReply: reply still queued (remaining=$remaining) - re-posting the notification and scheduling a retry")
            CanariFirebaseMessagingService.repostReplyPending(context, groupId, text, notifiedAt)
            OutboxRetryWorker.enqueueIfHealthy(context)
        }
    }

    /**
     * Announces "I have read this conversation up to `at`", from the notification shade.
     *
     * ONE ANSWER FOR BOTH ACTIONS. Marking read and replying are the same acknowledgement - a user
     * who answered a conversation has read it - so they call this rather than each carrying their
     * own idea of what reading means. That equivalence is a product decision (2026-08-31), and it is
     * cheap precisely because the watermark is one instant and not a set of ids.
     *
     * WHY `at` IS PASSED IN AND NOT LOOKED UP. It comes from the notification's own intent
     * ([CanariFirebaseMessagingService.EXTRA_SENT_AT]), stamped when the notification was posted.
     * The id-based `read_receipt` this replaces read `fcm_message_cache.ndjson` instead, which the
     * app CLEARS at every boot (`consumeFcmCache`): once the app had been opened after a
     * notification arrived, "mark as read" found an empty list and sent NOTHING, silently, because
     * an empty list is indistinguishable from a conversation with nothing to acknowledge. A fact
     * the notification already holds must not be re-derived from a cache that outlives nothing.
     *
     * WHY NOT THE CLOCK. Watermarks merge by `max` across devices, so a phone whose clock runs fast
     * would mark future messages read permanently and unfixably - the same rule the foreground path
     * states in `watermarkAfterReading` (readState.ts). `at <= 0` therefore means "this notification
     * predates the extra": nothing is sent, rather than something invented.
     *
     * TWO DESTINATIONS, because the frame only reaches the OTHER side. The outbox entry carries it
     * to peers and to our own other devices; `appendReadWatermark` leaves it where THIS device's
     * app will merge it at the next boot, which is what actually clears the badge on the phone the
     * user is holding.
     */
    private fun sendReadWatermark(context: Context, groupId: String, at: Long) {
        if (at <= 0L) {
            Log.w(TAG, "sendReadWatermark: no sentAt on the intent for group=${groupId.take(8)} - nothing announced")
            return
        }
        CanariFirebaseMessagingService.appendReadWatermark(context, groupId, at)

        val pushCtx = MlsContextLoader.loadPushContext(context)
        if (pushCtx == null) {
            Log.e(TAG, "sendReadWatermark: push_context.json absent -> frame not queued")
            return
        }
        val service = CanariFirebaseMessagingService()
        val protoB64 = service.nativeBuildReadWatermarkProto(at)
        if (protoB64.isEmpty()) {
            Log.e(TAG, "sendReadWatermark: nativeBuildReadWatermarkProto failed")
            return
        }
        val entries = CanariFirebaseMessagingService.readOutboxMirror(context) +
            CanariFirebaseMessagingService.OutboxMirrorEntry(
                // Silent, but durable: a read watermark sent from the notification shade is the
                // same mutation as one sent from the app, and must reach a device that was offline.
                UUID.randomUUID().toString(), groupId, protoB64, System.currentTimeMillis(),
                silent = true, durable = true
            )
        CanariFirebaseMessagingService.rewriteOutboxMirror(context, entries)
        CanariFirebaseMessagingService.drainOutboxBackground(context, service, pushCtx)
        Log.d(TAG, "sendReadWatermark: queued+drained at=$at group=${groupId.take(8)}")
    }

    /**
     * Clears this device's local notification immediately (visible part of "mark as read"), then
     * announces the read watermark carried by the notification's intent.
     *
     * The notification is cleared FIRST and unconditionally: it is the half the user asked for and
     * can see, and it must not depend on MLS state being loadable in a broadcast receiver.
     */
    private fun handleMarkRead(context: Context, intent: Intent, groupId: String) {
        CanariFirebaseMessagingService.cancelConversationNotification(context, groupId)
        sendReadWatermark(context, groupId, intent.getLongExtra(CanariFirebaseMessagingService.EXTRA_SENT_AT, 0L))
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
