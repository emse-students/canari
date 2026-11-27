package fr.emse.canari

import android.app.ForegroundServiceStartNotAllowedException
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import fr.emse.canari.call.classifyStartRefusal
import fr.emse.canari.mail.MailWatchCommand
import fr.emse.canari.mail.MailWatchEffect
import fr.emse.canari.mail.MailWatchSpec
import fr.emse.canari.mail.decideMailWatch

/**
 * THE NEW-MAIL WATCH KEEPS ITS CONNECTION WHEN THE APP LEAVES THE SCREEN (lot 4, D11; the
 * Thunderbird / K-9 model, owner 2026-11-27).
 *
 * The watcher is in the page (`mailWatcher.ts`): it blocks on the school mailbox's wait set over the
 * app's own socket and posts a notification per new mail. A process with nothing in the foreground
 * loses its network (measured for calls on the Mi 9T, 2026-10-20 - see [CallForegroundService]); a
 * process holding a FOREGROUND SERVICE keeps it. This service is only that hold: it does no mail work
 * itself, it holds the persistent notification Android requires (LOW importance, silent, Paraglide text
 * from the page) and it LEAVES THE MOMENT THE PAGE IS GONE ([decideMailWatch]) - a held foreground with
 * no page would promise a watch nobody runs.
 *
 * TYPE `specialUse`. `dataSync` is capped at six hours a day from Android 15 and cannot start from
 * boot; `remoteMessaging` is for handing messages between a user's devices. A connection held open to
 * wait for mail is what `specialUse` with a declared subtype is for (the manifest's
 * `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`), and Play reviews the declaration - an owner action.
 *
 * NOT RESTARTED AT BOOT, DELIBERATELY: with no page there is no watcher to keep alive (the TLS, the
 * session and the cursor are the page's), and the password never leaves the page's sealed store
 * (D6). The watch resumes the next time Canari is opened.
 */
class MailWatchService : Service() {
    companion object {
        private const val TAG = "MailWatchService"

        private const val ACTION_START = "fr.emse.canari.mail.START"
        private const val ACTION_STOP = "fr.emse.canari.mail.STOP"
        private const val ACTION_PAGE_GONE = "fr.emse.canari.mail.PAGE_GONE"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_REASON = "reason"

        /** The persistent notification's channel: LOW importance, silent, created on the first start. */
        const val CHANNEL_ID = "canari_mail_watch"

        private const val NOTIFICATION_ID = fr.emse.canari.push.FixedNotifIds.MAIL_WATCH_FOREGROUND

        /** Whether the service holds the foreground. Written on the main thread. */
        @Volatile var running: Boolean = false
            private set

        /** The intent carrying [command] - the ONE encoding of a command, read back by [commandFrom]. */
        fun intentFor(context: Context, command: MailWatchCommand): Intent {
            val intent = Intent(context, MailWatchService::class.java)
            when (command) {
                is MailWatchCommand.Start -> intent.setAction(ACTION_START)
                    .putExtra(EXTRA_TITLE, command.spec.title)
                    .putExtra(EXTRA_TEXT, command.spec.text)
                is MailWatchCommand.Stop -> intent.setAction(ACTION_STOP).putExtra(EXTRA_REASON, command.reason)
                MailWatchCommand.PageGone -> intent.setAction(ACTION_PAGE_GONE)
                // Never sent as an intent: it arrives as `onTaskRemoved`.
                MailWatchCommand.TaskRemoved -> intent.setAction(ACTION_PAGE_GONE)
            }
            return intent
        }

        private fun commandFrom(intent: Intent?): MailWatchCommand? = when (intent?.action) {
            ACTION_START -> {
                val title = intent.getStringExtra(EXTRA_TITLE)
                val text = intent.getStringExtra(EXTRA_TEXT)
                if (title.isNullOrBlank() || text.isNullOrBlank()) null
                else MailWatchCommand.Start(MailWatchSpec(title, text))
            }
            ACTION_STOP -> MailWatchCommand.Stop(intent.getStringExtra(EXTRA_REASON) ?: "unspecified")
            ACTION_PAGE_GONE -> MailWatchCommand.PageGone
            else -> null
        }

        /** `MainActivity.onDestroy`: the page that ran the watcher is gone, so the hold goes too. */
        fun stopForPageGone(context: Context) {
            if (!running) return
            Log.i(TAG, "the page that ran the mail watch is gone - stopping the service")
            try {
                context.startService(intentFor(context, MailWatchCommand.PageGone))
            } catch (e: IllegalStateException) {
                Log.e(TAG, "stop for a gone page not delivered: ${e.javaClass.simpleName}")
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val command = commandFrom(intent)
        if (command == null) {
            // START_NOT_STICKY: the system never re-delivers a null intent, so this class did not write it.
            Log.e(TAG, "unreadable command (action=${intent?.action}) - ignored")
            if (!running) stopSelf(startId)
            return START_NOT_STICKY
        }
        val effect = decideMailWatch(running, command)
        Log.i(TAG, "${command.javaClass.simpleName} -> ${effect.javaClass.simpleName}")
        when (effect) {
            is MailWatchEffect.EnterForeground -> enterForeground(effect.spec, startId)
            is MailWatchEffect.Refresh -> notificationManager().notify(NOTIFICATION_ID, notification(effect.spec))
            is MailWatchEffect.Leave -> leave(effect.reason, startId)
            is MailWatchEffect.Ignore -> {
                Log.i(TAG, "ignored: ${effect.reason}")
                if (!running) stopSelf(startId)
            }
        }
        // NOT STICKY: a process the system killed has no page, so a restarted service would hold a
        // foreground for nobody (see the class comment).
        return START_NOT_STICKY
    }

    private fun enterForeground(spec: MailWatchSpec, startId: Int) {
        ensureChannel()
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(spec),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
            )
        } catch (e: Exception) {
            val offScreenKind = e is SecurityException ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && e is ForegroundServiceStartNotAllowedException)
            val refusal = classifyStartRefusal(offScreenKind, MainActivity.isInForeground)
            Log.e(TAG, "startForeground refused (${refusal.code}): ${e.javaClass.simpleName}")
            MailWatchBridge.emit("failed", refusal.code)
            stopSelf(startId)
            return
        }
        running = true
        Log.i(TAG, "in the foreground: the mail watch keeps its connection")
        MailWatchBridge.emit("started", null)
    }

    private fun leave(reason: String, startId: Int?) {
        running = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        if (startId != null) stopSelf(startId) else stopSelf()
        Log.i(TAG, "left the foreground: $reason")
    }

    /** The user swiped the app away: the page - and so the watcher - went with the task. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        val effect = decideMailWatch(running, MailWatchCommand.TaskRemoved)
        if (effect is MailWatchEffect.Leave) leave(effect.reason, startId = null)
    }

    override fun onDestroy() {
        if (running) {
            Log.w(TAG, "destroyed while holding the foreground - the page is told")
            running = false
            MailWatchBridge.emit("stopped", null)
        }
        super.onDestroy()
    }

    private fun notificationManager(): NotificationManager =
        getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun notification(spec: MailWatchSpec): android.app.Notification {
        // A tap brings the running task forward with a LAUNCHER intent, which carries no deep link.
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(spec.title)
            .setContentText(spec.text)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (open != null) builder.setContentIntent(open)
        return builder.build()
    }

    /** Created on the first start, so a phone that never turns the switch on never shows the channel. */
    private fun ensureChannel() {
        val manager = notificationManager()
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        // The language chosen in the app, not the phone's - the rule every native string follows.
        val res = appLocaleContext(this)
        val channel = NotificationChannel(
            CHANNEL_ID,
            res.getString(R.string.notif_channel_mail_watch_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = res.getString(R.string.notif_channel_mail_watch_desc)
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
        Log.d(TAG, "created channel $CHANNEL_ID")
    }
}
