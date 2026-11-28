package fr.emse.canari

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import fr.emse.canari.call.StartRefusal
import fr.emse.canari.mail.MAIL_GROUP_SUMMARY_TAG
import fr.emse.canari.mail.MAIL_NOTIFICATION_TAG
import fr.emse.canari.mail.MAIL_SUMMARY_TAG
import fr.emse.canari.mail.MailBridgeOp
import fr.emse.canari.mail.MailNotice
import fr.emse.canari.mail.MailNoticeError
import fr.emse.canari.mail.MailSummary
import fr.emse.canari.mail.MailWatchCommand
import fr.emse.canari.mail.MailWatchSpec
import fr.emse.canari.mail.NativeVaultRecord
import fr.emse.canari.mail.nativeAddress
import fr.emse.canari.mail.mailBridgeMessageAccepted
import fr.emse.canari.mail.mailNoticeOf
import fr.emse.canari.mail.mailSummaryOf
import org.json.JSONException
import org.json.JSONObject

/**
 * THE PAGE'S HANDLE ON [MailWatchService] AND ON THE NEW-MAIL NOTIFICATIONS (lot 4,
 * docs/wiki/mail-client-transport.md#as-built---lot-4). Its twin is `mobile/androidMailWatch.ts`.
 *
 * Down: `MainActivity` registers `window.canariMail` through [register] - a WEB MESSAGE LISTENER,
 * one JSON op per message (`start`, `stop`, `notify`, `summary`, and for lot 4b's native watcher
 * `page`, `claim`, `arm`, `forget`, `release`), delivered only from the app's origins
 * (`mailBridgeOrigins`) and acted on only from the top frame.
 * Up: ONE DOM event, `canari:mail-native`, `kind` `started` (`code` the mode: `page` or `native`),
 * `failed` (with the [StartRefusal] `code`: `off-screen` is answered by the page at its next return
 * on screen), `stopped` (the service went away on its own), `handed` (the native run is joined: the
 * page's own run may start) or `armed` (`code` `ok` / `failed`).
 *
 * A new-mail notification is posted HERE, natively, because its tap must open the message: the
 * notification plugin's tap opens the app onto nothing (`useNotifications.svelte.ts`). It carries no
 * mail body - the sender and the subject only - and a PUBLIC version for a lock screen that hides
 * sensitive content: what the lock screen shows is the reader's own system setting, as for a chat
 * message.
 */
object MailWatchBridge {
    private const val TAG = "MailWatchBridge"

    /** The DOM event the page listens to. Its twin is `NATIVE_MAIL_EVENT` in `androidMailWatch.ts`. */
    const val EVENT = "canari:mail-native"

    /** The new-mail channel: an ordinary sound and a shade entry, the reader's own switch. */
    const val CHANNEL_ID = "canari_mail"

    /** The group the new-mail notifications are bundled under in the shade. */
    private const val GROUP = "canari_mail"

    @Volatile private var webView: WebView? = null

    fun attach(view: WebView) {
        webView = view
    }

    /**
     * Clears [view] only if it is still the attached one: a relaunched activity attaches first.
     * `true` when [view] WAS the page - only then is its going the page's going.
     */
    fun detach(view: WebView): Boolean {
        if (webView !== view) return false
        webView = null
        return true
    }

    /** Sends one event to the page; built with [JSONObject], so nothing is spliced in as code. */
    fun emit(kind: String, code: String?) {
        val view = webView
        if (view == null) {
            Log.i(TAG, "event $kind not delivered: no page is attached")
            return
        }
        val detail = JSONObject().put("kind", kind)
        if (code != null) detail.put("code", code)
        val script = "window.dispatchEvent(new CustomEvent('$EVENT',{detail:$detail}))"
        view.post { view.evaluateJavascript(script, null) }
    }

    /** The inbox's own link: what the group summary opens. */
    private const val MAIL_INBOX_LINK = "fr.emse.canari://mail"

    /** Posts [notice]: its id is the message's under [MAIL_NOTIFICATION_TAG], so a repost replaces. */
    fun post(context: Context, notice: MailNotice) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) {
            Log.i(TAG, "item ${notice.itemId} not notified: notifications are off for the app")
            return
        }
        ensureChannel(context)
        val silent = CanariFirebaseMessagingService.callHoldsSound()
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(context, notice.publicTitle))
            .setGroup(GROUP)
            .setAutoCancel(true)
            .setContentIntent(tapIntent(context, notice.link, notice.itemId))
            // A call holds the sound: shown, without its sound.
            .setSilent(silent)
            .build()
        try {
            manager.notify(MAIL_NOTIFICATION_TAG, notice.itemId, notification)
            postGroupSummary(context, manager, notice.publicTitle)
            Log.i(TAG, "item ${notice.itemId} notified (silent=$silent)")
        } catch (e: SecurityException) {
            Log.e(TAG, "item ${notice.itemId} not notified: ${e.javaClass.simpleName}")
        }
    }

    /** Posts the ONE notice standing for [summary]'s flood: replaced by the next one, never stacked. */
    fun postSummary(context: Context, summary: MailSummary) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) {
            Log.i(TAG, "summary of ${summary.count} not posted: notifications are off for the app")
            return
        }
        ensureChannel(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(summary.title)
            .setContentText(summary.body)
            .setNumber(summary.count)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(context, summary.publicTitle))
            .setAutoCancel(true)
            .setContentIntent(tapIntent(context, summary.link, 0))
            .setSilent(CanariFirebaseMessagingService.callHoldsSound())
            .build()
        try {
            manager.notify(MAIL_SUMMARY_TAG, 0, notification)
            Log.i(TAG, "summary of ${summary.count} new mails posted")
        } catch (e: SecurityException) {
            Log.e(TAG, "summary not posted: ${e.javaClass.simpleName}")
        }
    }

    /**
     * The shade's group summary of the single notices: Android bundles a group only under one, and
     * without it four mail notices are four loose rows. Silent: the notice it bundles already alerted.
     */
    private fun postGroupSummary(context: Context, manager: NotificationManagerCompat, publicTitle: String) {
        val summary = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(publicTitle)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setGroup(GROUP)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setContentIntent(tapIntent(context, MAIL_INBOX_LINK, 0))
            .build()
        try {
            manager.notify(MAIL_GROUP_SUMMARY_TAG, 0, summary)
        } catch (e: SecurityException) {
            Log.e(TAG, "group summary not posted: ${e.javaClass.simpleName}")
        }
    }

    private fun publicVersion(context: Context, publicTitle: String): android.app.Notification =
        NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(publicTitle)
            .build()

    private fun tapIntent(context: Context, link: String, requestCode: Int): PendingIntent {
        val tap = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse(link)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            context, requestCode, tap,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** Created on the first new mail, so a phone that never turns the switch on never shows it. */
    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        // The language chosen in the app, not the phone's - the rule every native string follows.
        val res = appLocaleContext(context)
        val channel = NotificationChannel(
            CHANNEL_ID,
            res.getString(R.string.notif_channel_mail_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = res.getString(R.string.notif_channel_mail_desc) }
        manager.createNotificationChannel(channel)
        Log.d(TAG, "created channel $CHANNEL_ID")
    }

    /**
     * Registers `window.canariMail` on [webView]: a WEB MESSAGE LISTENER, so Android itself delivers
     * only messages from [allowedOrigins], and [onMessage] drops any not from the top frame
     * ([mailBridgeMessageAccepted]). `false` on a WebView without the feature (no bridge: the page
     * reads its absence and says so).
     */
    fun register(webView: WebView, context: Context, allowedOrigins: Set<String>): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.e(TAG, "this WebView has no web message listener - no canariMail bridge")
            return false
        }
        val app = context.applicationContext
        WebViewCompat.addWebMessageListener(webView, "canariMail", allowedOrigins) { _, message, origin, isMainFrame, _ ->
            onMessage(app, message.data, origin.toString(), isMainFrame, allowedOrigins)
        }
        Log.d(TAG, "canariMail bridge registered for ${allowedOrigins.size} origin rule(s)")
        return true
    }

    /** One bridge message (UI thread). Every refusal is logged; nothing is thrown at the page. */
    private fun onMessage(context: Context, data: String?, origin: String, isMainFrame: Boolean, allowedOrigins: Set<String>) {
        if (!mailBridgeMessageAccepted(isMainFrame, origin, allowedOrigins)) {
            Log.e(TAG, "message refused: not from the app's top frame (mainFrame=$isMainFrame)")
            return
        }
        val o = try {
            JSONObject(data ?: "")
        } catch (e: JSONException) {
            Log.e(TAG, "message refused: not a description: ${e.javaClass.simpleName}")
            return
        }
        when (MailBridgeOp.of(o.optString("op", ""))) {
            MailBridgeOp.START -> start(context, MailWatchSpec(o.optString("title", ""), o.optString("text", "")))
            MailBridgeOp.STOP -> stop(context, o.optString("reason", "").ifBlank { "unspecified" })
            MailBridgeOp.NOTIFY -> mailNoticeOf(
                o.optLong("itemId", -1),
                o.optString("title", ""),
                o.optString("body", ""),
                o.optString("publicTitle", ""),
                o.optString("link", ""),
            ).fold(onSuccess = { post(context, it) }, onFailure = ::refused)
            MailBridgeOp.SUMMARY -> mailSummaryOf(
                o.optLong("count", 0),
                o.optString("title", ""),
                o.optString("body", ""),
                o.optString("publicTitle", ""),
                o.optString("link", ""),
            ).fold(onSuccess = { postSummary(context, it) }, onFailure = ::refused)
            MailBridgeOp.PAGE -> MailWatchService.stopForPageGone(context)
            MailBridgeOp.CLAIM -> claim(context, o.optString("id", ""))
            MailBridgeOp.ARM -> arm(
                context,
                o.optString("userId", ""),
                o.optString("account", ""),
                o.optString("password", ""),
                // The persistent-watch choice ("Connexion permanente", mail lot 5). Absent: on, the
                // lot 4b behaviour (the switch alone was the persistent watch).
                o.optBoolean("persistent", true),
            )
            MailBridgeOp.FORGET -> NativeMailWatcher.forget(context, o.optString("userId", "").ifBlank { null })
            MailBridgeOp.RELEASE -> MailWatchVault.ops.execute { NativeMailWatcher.pageReleased() }
            null -> Log.e(TAG, "message refused: an unknown op")
        }
    }

    /**
     * The page's watcher is about to run: every native run stops and is JOINED - it writes no cursor
     * and posts nothing any more - before `handed`, carrying the claim's [id], lets THAT claim's run
     * start. On the ops thread (a join, ordered with the release, arms and forgets).
     */
    private fun claim(context: Context, id: String) {
        MailWatchVault.ops.execute {
            NativeMailWatcher.claimForPage(context)
            Log.i(TAG, "the watch is handed to the page")
            emit("handed", id)
        }
    }

    /**
     * Seals the password for the native watcher. The page sends it ONLY with "remember" ticked AND the
     * switch on (`mailWatch.svelte.ts`); the password is never logged, and leaves this frame sealed.
     */
    private fun arm(context: Context, userId: String, account: String, password: String, persistent: Boolean) {
        if (userId.isBlank() || account.isBlank() || password.isEmpty()) {
            Log.e(TAG, "arm refused: a missing field")
            emit("armed", "failed")
            return
        }
        // The generation is read NOW, on the message's arrival: a forget sent after this arm bumps it,
        // and the arm, run after on the same executor, then seals nothing (review I3).
        val sentAt = MailWatchVault.order.armSent()
        MailWatchVault.ops.execute {
            val ok = MailWatchVault.arm(context, userId, NativeVaultRecord(nativeAddress(account), password), persistent, sentAt)
            if (ok && !persistent && MailWatchService.mode == fr.emse.canari.mail.MailWatchMode.NATIVE) {
                // The persistent watch was turned off while it ran: it ends (the copy stays for the push check).
                stop(context, "the persistent watch is off")
            }
            emit("armed", if (ok) "ok" else "failed")
        }
    }

    private fun refused(error: Throwable) {
        val why = (error as? MailNoticeError)?.refusal?.name ?: error.javaClass.simpleName
        Log.e(TAG, "notice refused: $why") // log-safe: an enum constant or a class name, never the notice's text
    }

    private fun start(context: Context, spec: MailWatchSpec) {
        if (spec.title.isBlank() || spec.text.isBlank()) {
            Log.e(TAG, "start refused: an empty notification text")
            return
        }
        // A foreground service starts only from an app on screen - unless the service already holds
        // the foreground (a NATIVE watch the page takes back): the next return on screen asks again
        // (the page listens for the `off-screen` code).
        if (!MainActivity.isInForeground && !MailWatchService.running) {
            Log.i(TAG, "start deferred: the app is not on screen")
            emit("failed", StartRefusal.OFF_SCREEN.code)
            return
        }
        try {
            context.startService(MailWatchService.intentFor(context, MailWatchCommand.Start(spec)))
            Log.i(TAG, "start sent")
        } catch (e: IllegalStateException) {
            Log.e(TAG, "start refused: ${e.javaClass.simpleName}")
            emit("failed", StartRefusal.REFUSED.code)
        }
    }

    /** ALWAYS sent to the service, which ignores a stop with nothing held: no in-process guess decides. */
    private fun stop(context: Context, reason: String) {
        try {
            context.startService(MailWatchService.intentFor(context, MailWatchCommand.Stop(reason)))
            Log.i(TAG, "stop sent (held=${MailWatchService.running})") // log-safe: a boolean, never content
        } catch (e: IllegalStateException) {
            // A background process may not start even a stopping service; one that holds the
            // foreground is itself in the foreground, so a refusal here means nothing was held.
            Log.i(TAG, "stop not delivered (held=${MailWatchService.running}): ${e.javaClass.simpleName}") // log-safe: a boolean and a class name
        }
    }
}
