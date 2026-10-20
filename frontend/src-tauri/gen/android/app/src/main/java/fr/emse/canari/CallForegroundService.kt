package fr.emse.canari

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import fr.emse.canari.call.CallOutput
import fr.emse.canari.call.CallServiceCommand
import fr.emse.canari.call.CallServiceEffect
import fr.emse.canari.call.OngoingCallSpec
import fr.emse.canari.call.decide
import fr.emse.canari.call.pickCallOutput

/**
 * AN IN-APP CALL KEEPS GOING WHEN THE APP LEAVES THE SCREEN (WP-C-BG-A).
 *
 * MEASURED ON THE Mi 9T (Android 16, `1.3.1-alpha.3`, 2026-10-20, CALL-LOCK-ANDROID): locked 40 s or
 * sent HOME 40 s, the call's signalling socket was reset 5 s in, the other party's voice stopped at
 * the same moment, and every resume attempt failed until the app came back - while the page's
 * JavaScript kept RUNNING (a `connection failed` every 4 s). So the process was not frozen: it was
 * cut off. A process with nothing in the foreground loses its network and its microphone; a process
 * with a FOREGROUND SERVICE keeps both, which is what Messenger, WhatsApp and Signal hold for a call.
 *
 * TYPE `microphone`, NOT `phoneCall`. `phoneCall` is for calls placed through Telecom's
 * `ConnectionService`, and Android 14 starts it only for an app that is the default dialer or holds
 * `MANAGE_OWN_CALLS` - a self-managed `ConnectionService` this app does not have. `microphone` is the
 * type Android documents for "communication apps" capturing in the background; its prerequisite is
 * `RECORD_AUDIO` granted, which a call has by definition, and a start from the foreground, which
 * [CallBridge] checks before it asks.
 *
 * What it holds, all of it released in [leave], which every exit goes through:
 * - the ONGOING `CallStyle` notification: the other party's name, a chronometer from the first
 *   `connected` (`CallService.connectedAt`, never this service's clock), a hang-up button handed to
 *   the page, which owns the call;
 * - the audio mode `MODE_IN_COMMUNICATION` and the call's output ([pickCallOutput]), re-chosen when a
 *   headset comes or goes, the previous mode restored at the end;
 * - a PARTIAL wake lock for the call's lifetime - no timeout, because the call's end is what
 *   releases it, and the notification is the visible witness that it is held.
 *
 * Every command goes through [decide], and every effect is logged with the command that caused it.
 */
class CallForegroundService : Service() {
    companion object {
        private const val TAG = "CallFgService"

        private const val ACTION_START = "fr.emse.canari.call.START"
        private const val ACTION_UPDATE = "fr.emse.canari.call.UPDATE"
        private const val ACTION_STOP = "fr.emse.canari.call.STOP"
        private const val ACTION_HANG_UP = "fr.emse.canari.call.HANG_UP"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_CONNECTED_AT = "connectedAtMs"
        private const val EXTRA_SPEAKER = "speaker"
        private const val EXTRA_REASON = "reason"

        /** The ongoing-call channel: silent, created on the first call of a build that places calls. */
        const val CHANNEL_ID = "canari_call_ongoing"

        /** One call at a time, so one notification id. Distinct from every push notification id. */
        private const val NOTIFICATION_ID = 0x0CA11

        /** Whether the service is in the foreground with a call. Written on the main thread. */
        @Volatile var running: Boolean = false
            private set

        /** The intent carrying [command] - the ONE encoding of a command, read back by [commandFrom]. */
        fun intentFor(context: Context, command: CallServiceCommand): Intent {
            val intent = Intent(context, CallForegroundService::class.java)
            when (command) {
                is CallServiceCommand.Start -> intent.setAction(ACTION_START).putSpec(command.spec)
                is CallServiceCommand.Update -> intent.setAction(ACTION_UPDATE).putSpec(command.spec)
                is CallServiceCommand.Stop -> intent.setAction(ACTION_STOP).putExtra(EXTRA_REASON, command.reason)
                CallServiceCommand.HangUp -> intent.setAction(ACTION_HANG_UP)
            }
            return intent
        }

        /**
         * The page that held the call is gone (its activity was destroyed): the call cannot go on,
         * so the service leaves. Called by `MainActivity.onDestroy`; a no-op with no call.
         */
        fun stopForPageGone(context: Context) {
            if (!running) return
            Log.w(TAG, "the page that held the call is gone - stopping the call service")
            try {
                context.startService(intentFor(context, CallServiceCommand.Stop("the page that held the call is gone")))
            } catch (e: IllegalStateException) {
                Log.e(TAG, "stop for a gone page not delivered: ${e.message}")
            }
        }

        private fun Intent.putSpec(spec: OngoingCallSpec): Intent {
            putExtra(EXTRA_TITLE, spec.title)
            putExtra(EXTRA_TEXT, spec.text)
            spec.connectedAtMs?.let { putExtra(EXTRA_CONNECTED_AT, it) }
            putExtra(EXTRA_SPEAKER, spec.speaker)
            return this
        }

        private fun Intent.spec(): OngoingCallSpec? {
            val title = getStringExtra(EXTRA_TITLE) ?: return null
            val text = getStringExtra(EXTRA_TEXT) ?: return null
            if (!hasExtra(EXTRA_SPEAKER)) return null
            val connectedAt = if (hasExtra(EXTRA_CONNECTED_AT)) getLongExtra(EXTRA_CONNECTED_AT, 0L) else null
            return OngoingCallSpec(title, text, connectedAt, getBooleanExtra(EXTRA_SPEAKER, true))
        }

        private fun commandFrom(intent: Intent?): CallServiceCommand? {
            if (intent == null) return null
            return when (intent.action) {
                ACTION_START -> intent.spec()?.let { CallServiceCommand.Start(it) }
                ACTION_UPDATE -> intent.spec()?.let { CallServiceCommand.Update(it) }
                ACTION_STOP -> CallServiceCommand.Stop(intent.getStringExtra(EXTRA_REASON) ?: "unspecified")
                ACTION_HANG_UP -> CallServiceCommand.HangUp
                else -> null
            }
        }

        /** A command as the log shows it: never the other party's name. */
        private fun describe(command: CallServiceCommand): String = when (command) {
            is CallServiceCommand.Start -> "start(${describe(command.spec)})"
            is CallServiceCommand.Update -> "update(${describe(command.spec)})"
            is CallServiceCommand.Stop -> "stop(${command.reason})"
            CallServiceCommand.HangUp -> "hang-up"
        }

        private fun describe(spec: OngoingCallSpec): String =
            "connected=${spec.connectedAtMs != null} speaker=${spec.speaker}"
    }

    private var spec: OngoingCallSpec? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audio: CallAudio? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val command = commandFrom(intent)
        if (command == null) {
            // START_NOT_STICKY means the system never re-delivers a null intent, so this is an intent
            // this class did not write.
            Log.e(TAG, "unreadable command (action=${intent?.action}) - ignored")
            if (!running) stopSelf()
            return START_NOT_STICKY
        }
        val effect = decide(running, command)
        Log.i(TAG, "${describe(command)} -> ${effect.javaClass.simpleName}")
        when (effect) {
            is CallServiceEffect.EnterForeground -> enterForeground(effect.spec)
            is CallServiceEffect.Refresh -> refresh(effect.spec)
            is CallServiceEffect.Leave -> leave(effect.reason)
            CallServiceEffect.ForwardHangUp -> forwardHangUp()
            is CallServiceEffect.Ignore -> {
                Log.w(TAG, "ignored: ${effect.reason}")
                if (!running) stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun enterForeground(spec: OngoingCallSpec) {
        ensureChannel()
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(spec),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
            )
        } catch (e: Exception) {
            // A SecurityException (a while-in-use type started from the background, a missing
            // FOREGROUND_SERVICE_MICROPHONE) or ForegroundServiceStartNotAllowedException. The call
            // goes on in the foreground only; the page is told why. CallBridge checks both known
            // preconditions (on screen, RECORD_AUDIO) before it asks, so this is reached only by a
            // refusal nobody has named yet - and Android may count a service started with
            // `startForegroundService` that stops without `startForeground` as a crash of the app.
            // That is the loud outcome a refusal nobody named should have; it is NOT papered over by
            // starting without the microphone type.
            Log.e(TAG, "startForeground refused: ${e.javaClass.simpleName}: ${e.message}")
            CallBridge.emit("failed", "startForeground: ${e.javaClass.simpleName}: ${e.message}")
            stopSelf()
            return
        }
        running = true
        this.spec = spec
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:ongoing-call").apply {
            setReferenceCounted(false)
            acquire()
        }
        audio = CallAudio(getSystemService(Context.AUDIO_SERVICE) as AudioManager).also { it.open(spec.speaker) }
        val notifications = NotificationManagerCompat.from(this).areNotificationsEnabled()
        Log.i(TAG, "in the foreground: microphone service, wake lock held, notifications shown=$notifications")
        CallBridge.emit("started")
    }

    private fun refresh(spec: OngoingCallSpec) {
        val previous = this.spec
        this.spec = spec
        if (previous == spec) return
        if (previous?.speaker != spec.speaker) audio?.setSpeaker(spec.speaker, "the page asked")
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Re-posting under the foreground id replaces the notification in place; the service's
        // foreground state does not depend on it, so a user who blocked notifications keeps the call.
        manager.notify(NOTIFICATION_ID, notification(spec))
    }

    private fun forwardHangUp() {
        if (!CallBridge.hasPage()) {
            leave("hang-up pressed and no page holds the call")
            return
        }
        // The page ends the call (MLS hangup, relay close) and then sends `stop`, which is what
        // takes this service down - one end path, whoever pressed what.
        CallBridge.emit("hangup")
    }

    /** Every exit: the call ended, the page went, the task was removed. Idempotent. */
    private fun leave(reason: String) {
        val wasRunning = running
        release()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
        Log.i(TAG, "left the foreground: $reason (was running=$wasRunning)")
        if (wasRunning) CallBridge.emit("stopped", reason)
    }

    private fun release() {
        running = false
        spec = null
        audio?.close()
        audio = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    /** The user swiped the app away from Recents: the activity, its WebView and the call are gone. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (running) leave("the task was removed from Recents")
    }

    override fun onDestroy() {
        if (running) {
            Log.w(TAG, "destroyed while a call was in the foreground - releasing")
            release()
            CallBridge.emit("stopped", "the call service was destroyed")
        }
        super.onDestroy()
    }

    private fun notification(spec: OngoingCallSpec): android.app.Notification {
        val person = Person.Builder().setName(spec.title).setImportant(true).build()
        val hangUp = PendingIntent.getService(
            this, 0, intentFor(this, CallServiceCommand.HangUp),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // A tap brings the running task forward with a LAUNCHER intent, which carries no deep link
        // and so cannot replace one (MainActivity is singleTask; see durable-rules).
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp))
            .setContentText(spec.text)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (open != null) builder.setContentIntent(open)
        if (spec.connectedAtMs != null) {
            builder.setWhen(spec.connectedAtMs).setShowWhen(true).setUsesChronometer(true)
        } else {
            builder.setShowWhen(false)
        }
        return builder.build()
    }

    /**
     * Created on the first call, so a build that places no call never shows the channel. Silent:
     * the ongoing notification announces nothing, it is there to be found.
     */
    private fun ensureChannel() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        // The language chosen in the app, not the phone's - the rule every native string follows.
        val res = appLocaleContext(this)
        val channel = NotificationChannel(
            CHANNEL_ID,
            res.getString(R.string.notif_channel_call_ongoing_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = res.getString(R.string.notif_channel_call_ongoing_desc)
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
        Log.d(TAG, "created channel $CHANNEL_ID")
    }
}

/**
 * The call's audio: the communication mode and the output, owned by the service for the call's life.
 *
 * Replaces the page's label-matched `setSinkId`, which could only guess at an output by its name and
 * found none on the Mi 9T. The mode found at [open] is restored at [close]; the output is re-chosen
 * when the set of devices changes (a headset plugged or paired mid-call), and logged only when the
 * choice actually changes.
 */
private class CallAudio(private val manager: AudioManager) {
    private companion object {
        const val TAG = "CallAudio"
    }

    private var previousMode: Int? = null
    private var speaker = true
    private var applied: CallOutput? = null
    private var appliedOnce = false

    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = route("a device was added")
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = route("a device was removed")
    }

    fun open(speaker: Boolean) {
        previousMode = manager.mode
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        this.speaker = speaker
        Log.i(TAG, "mode ${previousMode} -> MODE_IN_COMMUNICATION (read back ${manager.mode})")
        route("call started")
        // Called back on the main looper, where every other method here runs.
        manager.registerAudioDeviceCallback(devices, Handler(Looper.getMainLooper()))
    }

    fun setSpeaker(on: Boolean, why: String) {
        speaker = on
        route(why)
    }

    private fun route(why: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val available = manager.availableCommunicationDevices
            val wanted = pickCallOutput(available.map { classify(it.type) }, speaker)
            if (appliedOnce && wanted == applied) return
            appliedOnce = true
            applied = wanted
            if (wanted == null) {
                manager.clearCommunicationDevice()
                Log.w(TAG, "no ${if (speaker) "speaker" else "personal output"} among ${available.size} device(s) - the platform routes ($why)")
                return
            }
            val device = available.first { classify(it.type) == wanted }
            val ok = manager.setCommunicationDevice(device)
            if (ok) Log.i(TAG, "voice -> $wanted ($why)") else Log.e(TAG, "setCommunicationDevice($wanted) refused ($why)")
        } else {
            // API 28-30: speakerphone on or off; a Bluetooth headset would need SCO started, which this
            // service does not do below API 31 - the platform's wired/earpiece choice applies.
            val wanted = if (speaker) CallOutput.SPEAKER else CallOutput.EARPIECE
            if (appliedOnce && wanted == applied) return
            appliedOnce = true
            applied = wanted
            @Suppress("DEPRECATION")
            manager.isSpeakerphoneOn = speaker
            Log.i(TAG, "speakerphone=$speaker on API ${Build.VERSION.SDK_INT} ($why)")
        }
    }

    fun close() {
        manager.unregisterAudioDeviceCallback(devices)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            manager.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            manager.isSpeakerphoneOn = false
        }
        previousMode?.let { manager.mode = it }
        Log.i(TAG, "released: output cleared, mode restored to $previousMode")
    }

    private fun classify(type: Int): CallOutput = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> CallOutput.SPEAKER
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> CallOutput.EARPIECE
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> CallOutput.WIRED_HEADSET
        AudioDeviceInfo.TYPE_USB_HEADSET -> CallOutput.USB_HEADSET
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> CallOutput.BLUETOOTH_SCO
        AudioDeviceInfo.TYPE_HEARING_AID -> CallOutput.HEARING_AID
        else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) {
            CallOutput.BLE_HEADSET
        } else {
            CallOutput.OTHER
        }
    }
}
