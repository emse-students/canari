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
import fr.emse.canari.mail.MailWatchMode
import fr.emse.canari.mail.MailWatchSpec
import fr.emse.canari.mail.decideMailWatch

/**
 * THE NEW-MAIL WATCH KEEPS ITS CONNECTION WHEN THE APP LEAVES THE SCREEN (lot 4, D11; the
 * Thunderbird / K-9 model, owner 2026-11-27).
 *
 * The watcher is in the page (`mailWatcher.ts`): it blocks on the school mailbox's wait set over the
 * app's own socket and posts a notification per new mail. A process with nothing in the foreground
 * loses its network (measured for calls on the Mi 9T, 2026-10-20 - see [CallForegroundService]); a
 * process holding a FOREGROUND SERVICE keeps it. While the page watches, this service is only that
 * hold: it holds the persistent notification Android requires (LOW importance, silent, Paraglide text
 * from the page). When the page goes it LEAVES unless a sealed copy lets the native watcher take over
 * (below) - a held foreground with no watcher would promise a watch nobody runs.
 *
 * TYPE `specialUse`. `dataSync` is capped at six hours a day from Android 15 and cannot start from
 * boot; `remoteMessaging` is for handing messages between a user's devices. A connection held open to
 * wait for mail is what `specialUse` with a declared subtype is for (the manifest's
 * `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`), and Play reviews the declaration - an owner action.
 *
 * WITH NO PAGE, THE NATIVE WATCHER (lot 4b, owner decision 2026-11-28): when the page goes and a
 * sealed copy of the password is there ([MailWatchVault]: "remember" ticked AND the switch on), the
 * service keeps the foreground and runs [NativeMailWatcher] ([MailWatchMode.NATIVE]). It is RESUMED
 * by [CanariBootReceiver] at boot (after the first unlock: `BOOT_COMPLETED` only, never
 * `LOCKED_BOOT_COMPLETED` - the sealed copy is in credential-encrypted storage) and after an update,
 * and the system restarts it after killing the process (`START_STICKY` while native; a restart's null
 * intent is a [MailWatchCommand.Resume]). The page takes the watch back the moment its own watcher
 * runs (the bridge's `claim`, then `start`). [decideMailWatch] is the whole table.
 */
class MailWatchService : Service() {
    companion object {
        private const val TAG = "MailWatchService"

        private const val ACTION_START = "fr.emse.canari.mail.START"
        private const val ACTION_STOP = "fr.emse.canari.mail.STOP"
        private const val ACTION_PAGE_GONE = "fr.emse.canari.mail.PAGE_GONE"
        private const val ACTION_RESUME = "fr.emse.canari.mail.RESUME"
        private const val ACTION_NATIVE_ENDED = "fr.emse.canari.mail.NATIVE_ENDED"
        private const val ACTION_FORGOTTEN = "fr.emse.canari.mail.FORGOTTEN"
        private const val EXTRA_RUN = "run"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_REASON = "reason"

        /** The persistent notification's channel: LOW importance, silent, created on the first start. */
        const val CHANNEL_ID = "canari_mail_watch"

        private const val NOTIFICATION_ID = fr.emse.canari.push.FixedNotifIds.MAIL_WATCH_FOREGROUND

        /** Who watches while the service holds the foreground. Written on the main thread. */
        @Volatile var mode: MailWatchMode = MailWatchMode.OFF
            private set

        /** Whether the service holds the foreground. */
        val running: Boolean get() = mode != MailWatchMode.OFF

        /** The id of the native run this service started last: an earlier run's end ends nothing. */
        @Volatile private var currentRun: Long = 0

        /** The persistent notification's text with no page to give it: the app's resources. */
        fun resumeSpec(context: Context): MailWatchSpec {
            val res = appLocaleContext(context)
            return MailWatchSpec(res.getString(R.string.mail_watch_ongoing_title), res.getString(R.string.mail_watch_ongoing_text))
        }

        /**
         * Boot, an update: resumes the native watch when a sealed copy is there. A foreground start
         * from `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` is one Android allows for `specialUse`.
         */
        fun resumeIfArmed(context: Context, why: String) {
            if (MailWatchVault.armed(context) == null) {
                Log.d(TAG, "resume ($why): nothing sealed - no watch")
                return
            }
            try {
                context.startForegroundService(intentFor(context, MailWatchCommand.Resume(resumeSpec(context))))
                Log.i(TAG, "resume ($why): the native watch is asked for")
            } catch (e: Exception) {
                Log.e(TAG, "resume ($why) refused: ${e.javaClass.simpleName}")
            }
        }

        /** The intent carrying [command] - the ONE encoding of a command, read back by [commandFrom]. */
        fun intentFor(context: Context, command: MailWatchCommand): Intent {
            val intent = Intent(context, MailWatchService::class.java)
            when (command) {
                is MailWatchCommand.Start -> intent.setAction(ACTION_START)
                    .putExtra(EXTRA_TITLE, command.spec.title)
                    .putExtra(EXTRA_TEXT, command.spec.text)
                is MailWatchCommand.Stop -> intent.setAction(ACTION_STOP).putExtra(EXTRA_REASON, command.reason)
                MailWatchCommand.PageGone -> intent.setAction(ACTION_PAGE_GONE)
                is MailWatchCommand.Resume -> intent.setAction(ACTION_RESUME)
                    .putExtra(EXTRA_TITLE, command.spec.title)
                    .putExtra(EXTRA_TEXT, command.spec.text)
                is MailWatchCommand.NativeEnded -> intent.setAction(ACTION_NATIVE_ENDED)
                    .putExtra(EXTRA_REASON, command.reason)
                    .putExtra(EXTRA_RUN, command.run)
                MailWatchCommand.Forgotten -> intent.setAction(ACTION_FORGOTTEN)
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
            ACTION_RESUME -> {
                val title = intent.getStringExtra(EXTRA_TITLE)
                val text = intent.getStringExtra(EXTRA_TEXT)
                if (title.isNullOrBlank() || text.isNullOrBlank()) null
                else MailWatchCommand.Resume(MailWatchSpec(title, text))
            }
            ACTION_NATIVE_ENDED -> MailWatchCommand.NativeEnded(intent.getStringExtra(EXTRA_REASON) ?: "unspecified", intent.getLongExtra(EXTRA_RUN, -1))
            ACTION_FORGOTTEN -> MailWatchCommand.Forgotten
            else -> null
        }

        /**
         * `MainActivity.onDestroy`, or a new document (the bridge's `page`): the page that ran the
         * watcher is gone - the table hands the watch to the native watcher when armed, else leaves.
         */
        fun stopForPageGone(context: Context) {
            NativeMailWatcher.pageReleased()
            if (mode != MailWatchMode.PAGE) return
            Log.i(TAG, "the page that ran the mail watch is gone - telling the service")
            try {
                context.startService(intentFor(context, MailWatchCommand.PageGone))
            } catch (e: IllegalStateException) {
                Log.e(TAG, "stop for a gone page not delivered: ${e.javaClass.simpleName}")
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A NULL intent is the system restarting this service after it killed the process: only a
        // START_STICKY return asks for that, and only a native run returns it.
        val command = if (intent == null) MailWatchCommand.Resume(resumeSpec(this)) else commandFrom(intent)
        if (command == null) {
            Log.e(TAG, "unreadable command (action=${intent?.action}) - ignored")
            if (!running) stopSelf(startId)
            return stickiness()
        }
        val armed = MailWatchVault.armed(this) != null
        val effect = decideMailWatch(mode, command, armed, currentRun)
        Log.i(TAG, "${command.javaClass.simpleName} in $mode (armed=$armed) -> ${effect.javaClass.simpleName}") // log-safe: an enum mode, a boolean and class names
        if (command is MailWatchCommand.Resume && mode == MailWatchMode.OFF && effect !is MailWatchEffect.EnterForeground) {
            // A Resume arrives through startForegroundService (boot, update, a sticky restart): the
            // service MUST enter the foreground before it may leave, or the system kills the app
            // (review minor 4). It enters, then leaves at once.
            if (enterForegroundOnly(resumeSpec(this), startId)) leave("resume with nothing to watch", startId)
            return stickiness()
        }
        when (effect) {
            is MailWatchEffect.EnterForeground -> enterForeground(effect.spec, effect.mode, startId)
            is MailWatchEffect.Refresh -> notificationManager().notify(NOTIFICATION_ID, notification(effect.spec))
            is MailWatchEffect.HandToPage -> {
                // The page claimed the watch before its run (the native run is joined by then); this
                // only makes sure, and redraws the text in the page's words.
                NativeMailWatcher.stopAsync(this, "the page watches")
                mode = MailWatchMode.PAGE
                notificationManager().notify(NOTIFICATION_ID, notification(effect.spec))
            }
            MailWatchEffect.HandToNative -> startNative()
            is MailWatchEffect.Leave -> leave(effect.reason, startId)
            is MailWatchEffect.Ignore -> {
                Log.i(TAG, "ignored: ${effect.reason}")
                if (!running) stopSelf(startId)
            }
        }
        return stickiness()
    }

    /**
     * STICKY only while native: a killed process is then restarted into the watch it was running. A
     * page run is NOT sticky - a restarted process has no page, and its resume decides afresh.
     */
    private fun stickiness(): Int = if (mode == MailWatchMode.NATIVE) START_STICKY else START_NOT_STICKY

    private fun startNative() {
        mode = MailWatchMode.NATIVE
        currentRun = NativeMailWatcher.start(this) { run, reason ->
            try {
                startService(intentFor(this, MailWatchCommand.NativeEnded(reason, run)))
            } catch (e: IllegalStateException) {
                Log.e(TAG, "the native end was not delivered: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun enterForeground(spec: MailWatchSpec, target: MailWatchMode, startId: Int) {
        if (!enterForegroundOnly(spec, startId)) return
        Log.i(TAG, "in the foreground ($target): the mail watch keeps its connection")
        if (target == MailWatchMode.NATIVE) startNative() else mode = target
        MailWatchBridge.emit("started", target.name.lowercase())
    }

    /** Holds the foreground with [spec]; `false` (said to the page, the service stopped) when refused. */
    private fun enterForegroundOnly(spec: MailWatchSpec, startId: Int): Boolean {
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
            return false
        }
        return true
    }

    private fun leave(reason: String, startId: Int?) {
        NativeMailWatcher.stopAsync(this, reason)
        mode = MailWatchMode.OFF
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        if (startId != null) stopSelf(startId) else stopSelf()
        Log.i(TAG, "left the foreground: $reason")
    }

    /** The user swiped the app away: the page - and so the watcher - went with the task. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        val effect = decideMailWatch(mode, MailWatchCommand.TaskRemoved, MailWatchVault.armed(this) != null, currentRun)
        Log.i(TAG, "TaskRemoved in $mode -> ${effect.javaClass.simpleName}") // log-safe: an enum mode and a class name
        when (effect) {
            is MailWatchEffect.Leave -> leave(effect.reason, startId = null)
            MailWatchEffect.HandToNative -> startNative()
            else -> Unit
        }
    }

    override fun onDestroy() {
        if (running) {
            Log.w(TAG, "destroyed while holding the foreground ($mode) - the page is told")
            NativeMailWatcher.stopAsync(this, "the service was destroyed")
            mode = MailWatchMode.OFF
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
