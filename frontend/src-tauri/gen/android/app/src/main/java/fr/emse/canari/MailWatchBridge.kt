package fr.emse.canari

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import fr.emse.canari.call.StartRefusal
import fr.emse.canari.mail.MAIL_NOTIFICATION_TAG
import fr.emse.canari.mail.MailNotice
import fr.emse.canari.mail.MailNoticeError
import fr.emse.canari.mail.MailWatchCommand
import fr.emse.canari.mail.MailWatchSpec
import fr.emse.canari.mail.mailNoticeOf
import org.json.JSONException
import org.json.JSONObject

/**
 * THE PAGE'S HANDLE ON [MailWatchService] AND ON THE NEW-MAIL NOTIFICATIONS (lot 4,
 * docs/wiki/mail-client-transport.md#as-built---lot-4). Its twin is `mobile/androidMailWatch.ts`.
 *
 * Down: `MainActivity` registers [JsInterface] as `window.canariMail` - `start(json)`, `stop(reason)`
 * and `notify(json)`. Up: ONE DOM event, `canari:mail-native`, `kind` `started`, `failed` (with the
 * [StartRefusal] `code`: `off-screen` is answered by the page at its next return on screen) or
 * `stopped` (the service went away on its own).
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

    /** Clears [view] only if it is still the attached one: a relaunched activity attaches first. */
    fun detach(view: WebView) {
        if (webView === view) webView = null
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

    /** Posts [notice]: its id is the message's under [MAIL_NOTIFICATION_TAG], so a repost replaces. */
    fun post(context: Context, notice: MailNotice) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) {
            Log.i(TAG, "item ${notice.itemId} not notified: notifications are off for the app")
            return
        }
        ensureChannel(context)
        val tap = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse(notice.link)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            context, notice.itemId, tap,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val shownLocked = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.publicTitle)
            .build()
        val silent = CanariFirebaseMessagingService.callHoldsSound()
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(shownLocked)
            .setGroup(GROUP)
            .setAutoCancel(true)
            .setContentIntent(pending)
            // A call holds the sound: shown, without its sound.
            .setSilent(silent)
            .build()
        try {
            manager.notify(MAIL_NOTIFICATION_TAG, notice.itemId, notification)
            Log.i(TAG, "item ${notice.itemId} notified (silent=$silent)")
        } catch (e: SecurityException) {
            Log.e(TAG, "item ${notice.itemId} not notified: ${e.javaClass.simpleName}")
        }
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

    /** `window.canariMail`. Called on a JavaScript binder thread; every method returns at once. */
    class JsInterface(private val context: Context) {
        @JavascriptInterface
        fun start(json: String) {
            val spec = try {
                val o = JSONObject(json)
                MailWatchSpec(o.optString("title", ""), o.optString("text", ""))
            } catch (e: JSONException) {
                Log.e(TAG, "start refused: not a description: ${e.javaClass.simpleName}")
                return
            }
            if (spec.title.isBlank() || spec.text.isBlank()) {
                Log.e(TAG, "start refused: an empty notification text")
                return
            }
            // A foreground service starts only from an app on screen: the next return on screen asks
            // again (the page listens for the `off-screen` code).
            if (!MainActivity.isInForeground) {
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

        @JavascriptInterface
        fun stop(reason: String) {
            if (!MailWatchService.running) {
                Log.d(TAG, "stop with no watch held - nothing to do")
                return
            }
            try {
                context.startService(MailWatchService.intentFor(context, MailWatchCommand.Stop(reason.ifBlank { "unspecified" })))
                Log.i(TAG, "stop sent")
            } catch (e: IllegalStateException) {
                Log.e(TAG, "stop not delivered: ${e.javaClass.simpleName}")
            }
        }

        @JavascriptInterface
        fun notify(json: String) {
            val notice = try {
                val o = JSONObject(json)
                mailNoticeOf(
                    o.optLong("itemId", -1),
                    o.optString("title", ""),
                    o.optString("body", ""),
                    o.optString("publicTitle", ""),
                    o.optString("link", ""),
                )
            } catch (e: JSONException) {
                Log.e(TAG, "notice refused: not a description: ${e.javaClass.simpleName}")
                return
            }
            notice.fold(
                onSuccess = { post(context, it) },
                onFailure = {
                    val why = (it as? MailNoticeError)?.refusal?.name ?: it.javaClass.simpleName
                    Log.e(TAG, "notice refused: $why") // log-safe: an enum constant or a class name, never the notice's text
                },
            )
        }
    }
}
