package fr.emse.canari

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import androidx.core.app.RemoteInput
import fr.emse.canari.CanariFirebaseMessagingService.Companion.MirrorPresence
import fr.emse.canari.push.ChannelReadMark
import fr.emse.canari.push.ConversationRef
import fr.emse.canari.CanariFirebaseMessagingService.Companion.ReplyLine
import fr.emse.canari.push.HandedQuickReplies
import fr.emse.canari.push.QuickReplyRoute
import fr.emse.canari.push.throwableSite
import org.json.JSONObject
import java.util.UUID

/**
 * Handles the notification quick actions (WP-XP-1): inline "Repondre" (RemoteInput) and
 * "Marquer comme lu", fired from the shade while the app may be fully killed.
 *
 * Both actions reuse [CanariFirebaseMessagingService]'s outbox-drain machinery unchanged (same
 * `outbox_pending.ndjson` mirror, same `drainOutboxBackground`/`nativeSendMessagesBackground` path
 * the background welcome-join/decrypt flows already use) - only the plaintext `AppMessage` proto
 * is built differently, via [CanariFirebaseMessagingService.nativeBuildTextMessageProto] /
 * [CanariFirebaseMessagingService.nativeBuildReadReceiptProto] (no TS runtime involved). REPLY
 * never fires for a `channel_` conversation id: channels are server-authoritative and do not use
 * the MLS outbox (see `outbox.ts` `isChannelConversationId`), and a salon send is sealed under a
 * Graine session this receiver cannot hold. MARK AS READ does fire for one, as a single PushSecret
 * call to the salon's read receipt ([ChannelReadMark], [handleMarkRead]).
 */
class CanariNotificationActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "CanariNotifAction"

        /** The event the page drains handed-over replies on (`NATIVE_QUICK_REPLY_EVENT`, `quickReplyDrain.ts`). */
        private const val QUICK_REPLY_EVENT = "canari:quick-reply"
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
                        handleCallDecline(appContext, intent, groupId)
                    CanariFirebaseMessagingService.ACTION_BANNER_DISMISSED ->
                        CanariFirebaseMessagingService.forgetPostedBanner(
                            groupId,
                            intent.getIntExtra(CanariFirebaseMessagingService.EXTRA_BANNER_NOTIF_ID, -1),
                        )
                    else -> Log.w(TAG, "onReceive: unknown action ${intent.action}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "onReceive: exception: ${throwableSite(e)}")
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
        val notifiedServerAt = intent.getLongExtra(CanariFirebaseMessagingService.EXTRA_SERVER_AT, 0L)
        val text = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(CanariFirebaseMessagingService.KEY_TEXT_REPLY)
            ?.toString()?.trim()
        if (text.isNullOrEmpty()) {
            Log.w(TAG, "handleReply: empty text -> abort")
            return
        }
        val pushCtxRead = MlsContextLoader.readPushContext(context)
        val pushCtx = pushCtxRead.context
        if (pushCtx == null) {
            Log.e(TAG, "handleReply: push_context.json ${pushCtxRead.verdict.describe()} -> abort")
            return
        }
        // THE PAGE SENDS IT WHILE THE FOREGROUND GUARD HOLDS: the native encrypt would be refused on
        // that very fact, and the retry worker stands down for the page ([QuickReplyRoute]).
        val route = QuickReplyRoute.of(CanariFirebaseMessagingService.nativeForegroundGuardHolds())
        if (route == QuickReplyRoute.PAGE) {
            Log.i(TAG, "handleReply: the foreground guard holds - route PAGE group=${ConversationRef.of(groupId)}")
        } else {
            Log.i(TAG, "handleReply: the foreground guard is released - route NATIVE group=${ConversationRef.of(groupId)}")
        }
        if (route == QuickReplyRoute.PAGE) {
            handReplyToPage(context, groupId, pushCtx.userId, text, notifiedAt, notifiedServerAt)
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

        // AWAITED BEFORE IT IS QUEUED: from here on, a drain that delivers it - this one or another
        // running beside it (the retry worker, 5 ms apart on a Mi 9T) - says so, and this handler
        // decides on that, never on a guess.
        CanariFirebaseMessagingService.awaitReplyDelivery(messageId)
        try {
            CanariFirebaseMessagingService.enqueueOutboxMirror(
                context,
                CanariFirebaseMessagingService.OutboxMirrorEntry(
                    messageId, groupId, protoB64, sentAt, silent = false, durable = true
                )
            )
            Log.d(TAG, "handleReply: queued id=${messageId.take(8)} group=${ConversationRef.of(groupId)}")

            // Whether THIS reply went out - by this drain, or by another one meanwhile - not whether
            // the whole outbox drained: a reply delivered beside an older entry still queued is
            // delivered, and must not be re-posted as pending. With the server's receive time its
            // POST answered: the cache row is dated by it (chat.md, server order).
            //
            // A DRAIN THAT THROWS (the mirror's file I/O) still ends in the decision below, with no
            // result: the RemoteInput spinner must end in a re-post or a cancel whatever happened.
            var ownReceivedAt: Long? = null
            val remaining: Int? = try {
                CanariFirebaseMessagingService.drainOutboxBackground(context, service, pushCtx) { sent ->
                    if (sent.id == messageId) ownReceivedAt = sent.receivedAt
                }
            } catch (e: Exception) {
                Log.e(TAG, "handleReply: drain failed id=${messageId.take(8)} - deciding without it: ${throwableSite(e)}")
                null
            }
            if (remaining == null || remaining > 0) OutboxRetryWorker.enqueueIfHealthy(context)
            val receivedAt = ownReceivedAt ?: CanariFirebaseMessagingService.replyDeliveredAt(messageId)
            if (receivedAt != null) {
                replyAnswered(context, groupId, pushCtx, messageId, text, sentAt, receivedAt, notifiedAt, notifiedServerAt)
                return
            }
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
            //  - a deferred retry must be ENQUEUED (above). Nothing scheduled one here, so a reply
            //    that failed waited for the next LOGIN.
            // A drain may still deliver it before the re-post: the re-post asks under the record's
            // lock and hands back the receive time - the first-try success then runs here.
            // WORDED ON WHAT IS KNOWN, and at WARN in every case - each is a reply not seen
            // delivered. Still in the mirror: its send failed. Absent: adopted by the app's outbox
            // or erased by its whole rewrite (`store_outbox_mirror`, outside the outbox lock) - not
            // distinguishable here, and nothing native will clear that pending line
            // ([backlog](docs/wiki/backlog.d/p3-a-quick-reply-whose-process-died-leaves-its-banner-spinning.md)).
            // Unreadable: unknown.
            when (CanariFirebaseMessagingService.mirrorPresence(context, messageId)) {
                MirrorPresence.QUEUED ->
                    Log.w(TAG, "handleReply: reply id=${messageId.take(8)} not seen delivered by this drain, still queued (remaining=$remaining) - re-posted as pending, retry scheduled")
                MirrorPresence.ABSENT ->
                    Log.w(TAG, "handleReply: reply id=${messageId.take(8)} not seen delivered and absent from the mirror - adopted or rewritten by the app, not distinguishable here - re-posted as pending")
                MirrorPresence.UNREADABLE ->
                    Log.w(TAG, "handleReply: reply id=${messageId.take(8)} not seen delivered and the outbox mirror could not be read - whether it is queued is unknown - re-posted as pending")
            }
            CanariFirebaseMessagingService.repostReplyPending(context, groupId, messageId, text, notifiedAt, notifiedServerAt)
                ?.let { late -> replyAnswered(context, groupId, pushCtx, messageId, text, sentAt, late, notifiedAt, notifiedServerAt) }
        } finally {
            CanariFirebaseMessagingService.settleReplyDelivery(messageId)
        }
    }

    /**
     * HANDS A REPLY TO THE PAGE IN FRONT, which holds the MLS state ([QuickReplyRoute.PAGE]) - the
     * Android half of "a quick reply over a page that holds the MLS state goes to the page"
     * (mobile.md). Nothing enters the outbox mirror here: the native encrypt would be refused, and
     * the page never heard of a mirror entry it did not write, so the reply sat queued until the app
     * went to the background (#3912 reading, 2026-11-20).
     *
     * The line - `{"replyId","accountId","groupId","text","notifiedAt","repliedAt"}`, the iOS line -
     * is sealed and appended by Rust under the lock its take holds; the page is told only once it is
     * on disk (`canari:quick-reply`), and a page not reachable takes it when its session registers or
     * the app comes back to the front (`quickReplyDrain.ts`). It sends it through the composer's
     * path, so the delivery is the page's: its row, its outbox, its mirror.
     *
     * THE BANNER FOLLOWS THE PAGE, NEVER AHEAD OF IT: the reply is RECORDED
     * ([HandedQuickReplyStore]) and drawn "sending" (the inline-reply spinner ends), and only the
     * page's settlement draws it answered - sent, or queued in its outbox
     * ([CanariFirebaseMessagingService.quickReplySettledByPage]). A reply the page drops (another
     * account's), or that a dying page took ([CanariFirebaseMessagingService.sweepHandedQuickReplies]),
     * is drawn "not sent". All under [HandedQuickReplyStore.LOCK], so a settlement can never land
     * between the hand-over and its record.
     *
     * A reply that could not be handed over (no cache key, a write that failed) is LOST, and said:
     * a final "not sent, type it again" line, never the "retrying" one - nothing retries a reply that
     * was never queued.
     */
    private fun handReplyToPage(
        context: Context,
        groupId: String,
        accountId: String,
        text: String,
        notifiedAt: Long,
        notifiedServerAt: Long,
    ) {
        val replyId = UUID.randomUUID().toString()
        val repliedAt = System.currentTimeMillis()
        val line = JSONObject()
            .put("replyId", replyId)
            .put("accountId", accountId)
            .put("groupId", groupId)
            .put("text", text)
            .put("notifiedAt", notifiedAt)
            .put("repliedAt", repliedAt)
            .toString()
        synchronized(HandedQuickReplyStore.LOCK) {
            val handed = CanariFirebaseMessagingService.nativeHandQuickReplyToPage(
                MlsContextLoader.tauriDataDir(context).absolutePath,
                NativeCacheKey.retrieve(context),
                line,
            )
            if (handed != CanariFirebaseMessagingService.QUICK_REPLY_HANDED) {
                if (handed == CanariFirebaseMessagingService.QUICK_REPLY_NO_KEY) {
                    Log.e(TAG, "handReplyToPage: reply id=${replyId.take(8)} NOT handed to the page (no cache key) - LOST, the banner says not sent group=${ConversationRef.of(groupId)}")
                } else {
                    Log.e(TAG, "handReplyToPage: reply id=${replyId.take(8)} NOT handed to the page (the write failed) - LOST, the banner says not sent group=${ConversationRef.of(groupId)}")
                }
                CanariFirebaseMessagingService.repostReplyPending(
                    context, groupId, replyId, text, notifiedAt, notifiedServerAt,
                    ReplyLine.NOT_SENT_RETYPE,
                )
                return
            }
            val recorded = HandedQuickReplyStore.record(
                context,
                HandedQuickReplies.Handed(replyId, accountId, groupId, text, repliedAt, notifiedAt, notifiedServerAt),
            )
            if (!recorded) {
                // No record, no settlement can find this banner: "sending" would stay for good. The
                // page tells what becomes of the reply itself (its settlement is answered "not told").
                Log.e(TAG, "handReplyToPage: reply id=${replyId.take(8)} handed over but not recorded - the banner is answered now, the page shows its fate group=${ConversationRef.of(groupId)}")
                CanariFirebaseMessagingService.answerReplyNotification(context, groupId, replyId, text, repliedAt, 0L, notifiedAt, notifiedServerAt)
                return@synchronized
            }
            CanariFirebaseMessagingService.repostReplyPending(
                context, groupId, replyId, text, notifiedAt, notifiedServerAt,
                ReplyLine.SENDING,
            )
        }
        if (MainActivity.tellPage(QUICK_REPLY_EVENT)) {
            Log.i(TAG, "handReplyToPage: reply id=${replyId.take(8)} handed to the page in front, told group=${ConversationRef.of(groupId)}")
        } else {
            Log.w(TAG, "handReplyToPage: reply id=${replyId.take(8)} handed over with no live page to tell - taken at its next registration or front edge group=${ConversationRef.of(groupId)}")
        }
    }

    /**
     * THE QUICK REPLY'S SUCCESS - the user answered from the banner and the reply went out, by its
     * own drain or by another one while the user was replying. ONE function, so the two branches of
     * [handleReply] cannot drift: the reply is recorded locally BEFORE the notification goes (the
     * one visible trace is never dropped before the durable one exists), the banner is removed -
     * its reaction with it, but never ANOTHER reply's line still queued
     * ([CanariFirebaseMessagingService.answerReplyNotification]) - and, ANSWERING BEING READING (product decision, 2026-08-31), the read
     * watermark is sent. Only a delivered reply announces a read: one still in the outbox has been
     * seen by no one.
     */
    private fun replyAnswered(
        context: Context,
        groupId: String,
        pushCtx: MlsContextLoader.PushContext,
        messageId: String,
        text: String,
        sentAt: Long,
        receivedAt: Long,
        notifiedAt: Long,
        notifiedServerAt: Long,
    ) {
        CanariFirebaseMessagingService.writeSentMessageToCache(
            context, groupId, pushCtx.userId, messageId, text, sentAt, receivedAt
        )
        CanariFirebaseMessagingService.answerReplyNotification(context, groupId, messageId, text, sentAt, receivedAt, notifiedAt, notifiedServerAt)
        sendReadWatermark(context, groupId, notifiedAt, notifiedServerAt)
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
     * TWO CLOCKS. `serverAt` is the server's `createdAt` of the same message
     * ([CanariFirebaseMessagingService.EXTRA_SERVER_AT]), the clock the conversation is ordered and
     * read on since 2026-10-31. Known, it is what the frame states (`serverAt`, and `at` the same
     * value, as the app sends it); unknown (0), the frame states `at` alone on the sender's clock.
     *
     * TWO DESTINATIONS, because the frame only reaches the OTHER side. The outbox entry carries it
     * to peers and to our own other devices; `appendReadWatermark` leaves it where THIS device's
     * app will merge it at the next boot, which is what actually clears the badge on the phone the
     * user is holding.
     */
    private fun sendReadWatermark(context: Context, groupId: String, at: Long, serverAt: Long) {
        if (at <= 0L) {
            Log.w(TAG, "sendReadWatermark: no sentAt on the intent for group=${ConversationRef.of(groupId)} - nothing announced")
            return
        }
        CanariFirebaseMessagingService.appendReadWatermark(context, groupId, at, serverAt)

        val pushCtxRead = MlsContextLoader.readPushContext(context)
        val pushCtx = pushCtxRead.context
        if (pushCtx == null) {
            Log.e(TAG, "sendReadWatermark: push_context.json ${pushCtxRead.verdict.describe()} -> frame not queued")
            return
        }
        val service = CanariFirebaseMessagingService()
        if (serverAt <= 0L) {
            Log.w(TAG, "sendReadWatermark: no server time on the intent for group=${ConversationRef.of(groupId)} - the mark is stated on the sender's clock alone")
        }
        val protoB64 = service.nativeBuildReadWatermarkProto(at, serverAt)
        if (protoB64.isEmpty()) {
            Log.e(TAG, "sendReadWatermark: nativeBuildReadWatermarkProto failed")
            return
        }
        CanariFirebaseMessagingService.enqueueOutboxMirror(
            context,
            CanariFirebaseMessagingService.OutboxMirrorEntry(
                // Silent, but durable: a read watermark sent from the notification shade is the
                // same mutation as one sent from the app, and must reach a device that was offline.
                UUID.randomUUID().toString(), groupId, protoB64, System.currentTimeMillis(),
                silent = true, durable = true
            )
        )
        CanariFirebaseMessagingService.drainOutboxBackground(context, service, pushCtx)
        Log.d(TAG, "sendReadWatermark: queued+drained at=$at serverAt=$serverAt group=${ConversationRef.of(groupId)}")
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
        val at = intent.getLongExtra(CanariFirebaseMessagingService.EXTRA_SENT_AT, 0L)
        val channelId = ChannelReadMark.channelIdOf(groupId)
        if (channelId == null) {
            val serverAt = intent.getLongExtra(CanariFirebaseMessagingService.EXTRA_SERVER_AT, 0L)
            sendReadWatermark(context, groupId, at, serverAt)
        } else if (at > 0L) {
            // A SALON: its read state is a server row, not an MLS frame, so it is one PushSecret
            // call. `at` is the server's `createdAt` of the newest message the banner shows.
            CanariFirebaseMessagingService.postChannelRead(context, channelId, at)
        } else {
            Log.w(TAG, "handleMarkRead: no instant on the intent for channel=${ConversationRef.of(groupId)} - nothing sent")
        }
    }

    /**
     * Declines an incoming-call ring (WP-XP-5) from the native ring - the notification's Decline and
     * [IncomingCallActivity]'s, which fires this same intent.
     *
     * THE DECLINE REACHES THE CALLER. The ring stops here first (the half the user sees), then the
     * hangup the in-app Decline sends - `CallMsg { hangup, end_reason = DECLINED }` - goes to the
     * conversation, so the caller's ring ends at once and its record reads "declined". Before, this
     * sent nothing and the caller rang out its whole minute (1.5.2-alpha.1). Calls are 1:1 (calls.md,
     * lot 1), so "decline" and "end the ring for the caller" are the same act.
     *
     * Sent ONCE and not queued ([CanariFirebaseMessagingService.sendTransportFrameNow]): a hangup
     * replayed after the call ended means nothing. A failure is logged; the caller rings out.
     */
    private fun handleCallDecline(context: Context, intent: Intent, groupId: String) {
        val callId = intent.getStringExtra(CanariFirebaseMessagingService.EXTRA_CALL_ID) ?: ""
        Log.d(TAG, "handleCallDecline: call=$callId group=${ConversationRef.of(groupId)}")
        CanariFirebaseMessagingService.cancelIncomingCallNotification(context, callId)
        if (callId.isEmpty()) {
            Log.e(TAG, "handleCallDecline: no callId on the intent -> the caller is not told")
            return
        }
        val pushCtxRead = MlsContextLoader.readPushContext(context)
        val pushCtx = pushCtxRead.context
        if (pushCtx == null) {
            Log.e(TAG, "handleCallDecline: push_context.json ${pushCtxRead.verdict.describe()} -> the caller is not told")
            return
        }
        val service = CanariFirebaseMessagingService()
        val messageId = UUID.randomUUID().toString()
        val protoB64 = service.nativeBuildCallHangupProto(
            messageId, System.currentTimeMillis(), callId, pushCtx.deviceId,
            CanariFirebaseMessagingService.CALL_END_REASON_DECLINED,
        )
        if (protoB64.isEmpty()) {
            Log.e(TAG, "handleCallDecline: nativeBuildCallHangupProto failed -> the caller is not told")
            return
        }
        val sent = CanariFirebaseMessagingService.sendTransportFrameNow(
            context, service, pushCtx, groupId, messageId, protoB64
        )
        if (sent) {
            Log.d(TAG, "handleCallDecline: the decline reached the server call=$callId")
        } else {
            Log.w(TAG, "handleCallDecline: the decline was not sent call=$callId - the caller rings out its window")
        }
    }
}
