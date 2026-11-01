package fr.emse.canari

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.os.Build
import android.util.Log
import app.tauri.gallery.ConversationShortcuts
import fr.emse.canari.call.IncomingRing
import java.io.File

/**
 * Custom Application loaded BEFORE any Android component (including the FCM services).
 * Roles:
 *  1. Load the native Rust library mines_app_lib.
 *  2. Create the Android notification channels (required since API 26).
 *  3. Transfer the pushSecret from pending_push_secret.txt to the Android Keystore
 *     (written by Tauri after FCM registration, read exactly once then deleted).
 *  4. Record the installing package so the WebView can tell a Play install from a
 *     sideload (see [recordInstallerPackage]).
 *
 * Registered in AndroidManifest.xml via android:name=".CanariApplication".
 */
class CanariApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // WHY THE CONTEXT IS CACHED HERE. A notification built for a WEBSOCKET frame is asked for
        // by Rust, over a JNI upcall from a thread with no Android component behind it - no
        // Activity, no Service, nothing holding a Context. This is the one object guaranteed to
        // exist for the life of the process, and `onCreate` runs before any component of ours can.
        appContext = applicationContext
        try {
            System.loadLibrary("mines_app_lib")
        } catch (_: UnsatisfiedLinkError) {
            // The lib is not available on this architecture - native calls
            // will fail gracefully (a generic notification is shown).
        }
        // Channels live in the system, not in our storage, so they are the one thing that can
        // always be done here.
        createNotificationChannels()

        if (DirectBoot.storageReadable(this)) {
            initStorageBackedState()
        } else {
            // Every initialiser below reads credential-encrypted storage, and while it is locked
            // each one of them would misread "cannot open" as "nothing there" - the files report
            // exists() == false and the prefs load empty and stay empty for the life of the
            // process. Running them now cannot help and can only teach this process something
            // false, so they are deferred to the unlock (WP-DIRECTBOOT-1).
            Log.w(TAG, "onCreate: storage locked (pre-unlock process) - deferring init to ACTION_USER_UNLOCKED")
            registerUnlockReceiver()
        }
    }

    /**
     * The startup work that needs credential-encrypted storage, in its original order.
     * Idempotent: each step either no-ops or converges, so running it again after an unlock is
     * safe - which is what [registerUnlockReceiver] does.
     */
    private fun initStorageBackedState() {
        processPendingPushSecret()
        checkKeystoreHealth()
        recordInstallerPackage()
        // Before any push can be handled by this process: the key that seals the native caches,
        // created here and nowhere else ([NativeCacheKey]).
        try {
            NativeCacheKey.ensure(this)
        } catch (e: Exception) {
            Log.e(TAG, "NativeCacheKey.ensure: exception: ${e.message}", e)
        }
        // A SALON TAKES NO CONVERSATION SHORTCUT SINCE 2026-11-01 (`showMessageNotification`), and the
        // ones the socket trigger published before it would hold the shared dynamic budget until the
        // next sign-out. Removed from the record's own list, so every later start finds none.
        try {
            // The count is logged by the recorder itself, once, when there was anything to remove.
            ConversationShortcuts.removeRecordedWithPrefix(this, "${ConversationShortcuts.ID_PREFIX}channel_")
        } catch (e: Exception) {
            Log.e(TAG, "salon conversation shortcuts: not retired: ${e.message}", e)
        }
    }

    /**
     * Runs the deferred init the moment the user unlocks, for a process that was started before
     * they did. `ACTION_USER_UNLOCKED` is delivered to a runtime receiver only - it cannot be
     * declared in the manifest - and it is unregistered immediately so a re-lock/unlock cycle
     * later in the same boot does not run this again.
     */
    private fun registerUnlockReceiver() {
        try {
            registerReceiver(
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        Log.i(TAG, "onUserUnlocked: storage available - running deferred init")
                        try { context.applicationContext.unregisterReceiver(this) } catch (_: Exception) {}
                        initStorageBackedState()
                    }
                },
                IntentFilter(Intent.ACTION_USER_UNLOCKED),
            )
        } catch (e: Exception) {
            // Never fatal: the next process start does the work anyway.
            Log.e(TAG, "registerUnlockReceiver: ${e.message}", e)
        }
    }

    /**
     * Writes the package that installed this app into `installer_package.txt`, read by the
     * Tauri command `get_installer_package`.
     *
     * The Play build is signed by Google Play App Signing and the GitHub APK by our upload
     * key, so NEITHER can install over the other. The in-app update prompt must therefore
     * send a Play install to the Play Store and a sideload to the APK - a build-time
     * constant cannot know which this is, only the system can.
     *
     * Writes an empty file when there is no installing package (adb / `pm install`), which
     * the reader treats as a sideload. Rewritten at every startup rather than cached: it
     * costs nothing and no staleness can survive a restart. Silent on failure like its
     * neighbours - an update hint must never block startup.
     */
    internal fun recordInstallerPackage() {
        try {
            val installer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                packageManager.getInstallSourceInfo(packageName).installingPackageName
            } else {
                @Suppress("DEPRECATION")
                packageManager.getInstallerPackageName(packageName)
            }
            File(MlsContextLoader.tauriDataDir(this), "installer_package.txt")
                .writeText(installer ?: "")
            Log.d(TAG, "recordInstallerPackage: installed by ${installer ?: "(none - sideload)"}")
        } catch (e: Exception) {
            Log.e(TAG, "recordInstallerPackage: exception: ${e.message}", e)
        }
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        ensureChannels(this, manager)
    }

    /**
     * Verifies that the Android Keystore can read the push secret (key not lost).
     * Writes `keystore_ok.flag` if OK, deletes it otherwise.
     * The Tauri command `check_push_secret_health` reads this flag to signal the UI.
     * Silent call: an error here must not block startup.
     */
    internal fun checkKeystoreHealth() {
        try {
            if (!DirectBoot.storageReadable(this)) {
                // `push_context.json` merely LOOKS absent while locked, and the early return below
                // would read that as "not authenticated yet". It happens to be harmless - the
                // return is also what stops the flag being DELETED and background push falsely
                // reported dead - but two causes under one predicate is not a safety property.
                Log.w(TAG, "checkKeystoreHealth: storage locked - cannot tell, deferring")
                return
            }
            val dataDir = MlsContextLoader.tauriDataDir(this)
            val contextFile = File(dataDir, "push_context.json")
            if (!contextFile.exists()) return // not authenticated yet, no secret expected
            val markerFile = File(dataDir, "keystore_ok.flag")
            val secret = PushSecretKeystore.retrieve(this)
            if (secret != null) {
                markerFile.writeText("ok")
                Log.d(TAG, "checkKeystoreHealth: Keystore operational")
            } else {
                markerFile.delete()
                Log.e(TAG, "checkKeystoreHealth: Keystore lost - background push disabled")
            }
        } catch (e: Exception) {
            Log.e(TAG, "checkKeystoreHealth: exception: ${e.message}", e)
        }
    }

    internal fun processPendingPushSecret() {
        synchronized(PushSecretKeystore.handoffLock) {
            try {
                val file = File(MlsContextLoader.tauriDataDir(this), "pending_push_secret.txt")
                if (!file.exists()) return@synchronized
                // Read raw bytes first so the overwrite covers the exact file size, including
                // any trailing newline. secret.length is a char count and diverges from byte
                // count for multi-byte UTF-8 sequences, leaving secret bytes unzeroed.
                val rawBytes = file.readBytes()
                val secret = rawBytes.toString(Charsets.UTF_8).trim()
                if (secret.isNotEmpty()) {
                    PushSecretKeystore.store(this, secret)
                    Log.i(TAG, "processPendingPushSecret: secret stored in the Keystore")
                }
                file.writeBytes(ByteArray(rawBytes.size) { 0 })
                file.delete()
            } catch (e: Exception) {
                Log.e(TAG, "processPendingPushSecret: push secret transfer failed: ${e.message}", e)
            }
        }
    }

    companion object {
        private const val TAG = "CanariApp"

        /**
         * The id of the channel `tauri-plugin-notification` creates when it loads
         * (`DEFAULT_NOTIFICATION_CHANNEL_ID` in its `TauriNotificationManager.kt`, 2.4.0), named
         * and described with the hardcoded English literal "Default" - a resource Paraglide and
         * `strings.xml` cannot reach, so a French app's notification settings listed six French
         * channels and one called "Default" (measured 2026-09-23).
         */
        private const val PLUGIN_DEFAULT_CHANNEL_ID = "default"

        /**
         * Deletes the plugin's empty "Default" channel. NOTHING POSTS TO IT: every builder in this app
         * names a `canari_*` channel, so the row is empty in BOTH build types and deleting it
         * loses no user setting.
         *
         * Called from `MainActivity.onResume`, not from [onCreate]: the plugin creates the channel
         * when it LOADS, which is after the Application exists, so a deletion at process start would
         * run before the creation it is meant to undo. It runs on every resume because the plugin
         * re-creates the channel at every load; the call is idempotent and cheap.
         */
        internal fun removePluginDefaultChannel(context: Context) {
            try {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return
                if (manager.getNotificationChannel(PLUGIN_DEFAULT_CHANNEL_ID) == null) return
                manager.deleteNotificationChannel(PLUGIN_DEFAULT_CHANNEL_ID)
                Log.d(TAG, "removePluginDefaultChannel: deleted the plugin's \"Default\" channel")
            } catch (e: Exception) {
                Log.e(TAG, "removePluginDefaultChannel: exception: ${e.message}", e)
            }
        }

        /**
         * The process-wide Application context, or null before [onCreate] has run.
         *
         * `@Volatile` because it is written on the main thread and read from whatever thread the
         * JNI upcall attached - see [CanariFirebaseMessagingService.notifyMessageFromWebSocket].
         */
        @Volatile
        private var appContext: Context? = null

        /** @return the Application context, or null if this process has no [CanariApplication]. */
        internal fun appContext(): Context? = appContext

        /**
         * The channel ids that carried the platform's default sound before the palette-A sounds
         * (2026-10-09). A channel's sound is IMMUTABLE once created, so the new sounds live on new
         * ids (`_v2`) and these are deleted: left alone they would stay in the user's settings as a
         * second, dead "Messages" entry. Deleting is idempotent and cheap, and the user's per-channel
         * choices on the old ids are NOT carried - the sound is the thing that changed.
         */
        private val SUPERSEDED_CHANNELS =
            listOf("canari_messages", "canari_mentions", "canari_reactions") + IncomingRing.SUPERSEDED_CHANNEL_IDS

        /**
         * What the user had set on the superseded `canari_calls`, read before it is deleted. [silent]
         * is a channel whose sound the user set to None: it stays silent - the new ring is not a
         * reason to make a sound the user turned off.
         */
        private class OldCallsChannel(
            val importance: Int,
            val vibrates: Boolean,
            val silent: Boolean,
            val lockscreenVisibility: Int,
            val showBadge: Boolean,
        )

        /** SharedPreferences holding the one-time "re-grant Do Not Disturb" ask ([isDndRegrantOwed]). */
        private const val CALLS_CHANNEL_PREFS = "canari_calls_channel"
        private const val KEY_DND_REGRANT_OWED = "dnd_regrant_owed"

        /**
         * Reads and LOGS the superseded calls channel before it is deleted: its importance, whether
         * the user granted it "override Do Not Disturb" and whether it vibrates. The importance and
         * the vibration are carried to `canari_calls_v2`; the DND bypass CANNOT be - only the user
         * grants it - so a granted one records an ask the page shows until it is answered
         * ([isDndRegrantOwed], [dndRegrantAnswered]).
         * Null when there is no old channel (a fresh install, or the move is done).
         */
        private fun supersededCallsChannel(context: Context, manager: NotificationManager): OldCallsChannel? {
            for (id in IncomingRing.SUPERSEDED_CHANNEL_IDS) {
                val old = manager.getNotificationChannel(id) ?: continue
                val bypass = old.canBypassDnd()
                val silent = old.sound == null
                Log.i(TAG, "supersededCallsChannel: $id importance=${old.importance} canBypassDnd=$bypass shouldVibrate=${old.shouldVibrate()} silent=$silent lockscreenVisibility=${old.lockscreenVisibility} showBadge=${old.canShowBadge()} - carried to ${IncomingRing.CHANNEL_ID} (bypass owed to the user)")
                if (bypass) {
                    context.getSharedPreferences(CALLS_CHANNEL_PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean(KEY_DND_REGRANT_OWED, true).apply()
                }
                return OldCallsChannel(old.importance, old.shouldVibrate(), silent, old.lockscreenVisibility, old.canShowBadge())
            }
            return null
        }

        /** Whether the Do Not Disturb ask was shown in this process ([IncomingRing.dndAsk]). */
        private val dndAskedThisLaunch = java.util.concurrent.atomic.AtomicBoolean(false)

        /**
         * Whether the page asks the user, now, to grant the new calls channel "override Do Not
         * Disturb" again ([IncomingRing.dndAsk]). Only the user's answer clears the debt
         * ([dndRegrantAnswered]) - or the channel already having it, granted by hand; an unanswered
         * ask comes back at the next launch, never on every page load.
         */
        internal fun isDndRegrantOwed(context: Context): Boolean {
            val prefs = context.getSharedPreferences(CALLS_CHANNEL_PREFS, Context.MODE_PRIVATE)
            val owed = prefs.getBoolean(KEY_DND_REGRANT_OWED, false)
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val granted = manager.getNotificationChannel(IncomingRing.CHANNEL_ID)?.canBypassDnd() == true
            return when (IncomingRing.dndAsk(owed, granted, dndAskedThisLaunch.get())) {
                IncomingRing.DndAsk.NONE -> false
                IncomingRing.DndAsk.CLEAR -> {
                    prefs.edit().remove(KEY_DND_REGRANT_OWED).apply()
                    Log.i(TAG, "isDndRegrantOwed: ${IncomingRing.CHANNEL_ID} already overrides Do Not Disturb - the ask is dropped")
                    false
                }
                IncomingRing.DndAsk.ASK -> {
                    dndAskedThisLaunch.set(true)
                    Log.i(TAG, "isDndRegrantOwed: the user is still owed the calls channel Do Not Disturb ask - asked once this launch")
                    true
                }
            }
        }

        /** The user answered the ask - opened the settings, or closed it: it is not asked again. */
        internal fun dndRegrantAnswered(context: Context, how: String) {
            context.getSharedPreferences(CALLS_CHANNEL_PREFS, Context.MODE_PRIVATE)
                .edit().remove(KEY_DND_REGRANT_OWED).apply()
            Log.i(TAG, "dndRegrantAnswered: the Do Not Disturb ask is answered ($how)")
        }

        private fun deleteSupersededChannels(manager: NotificationManager) {
            for (id in SUPERSEDED_CHANNELS) {
                if (manager.getNotificationChannel(id) == null) continue
                manager.deleteNotificationChannel(id)
                Log.d(TAG, "deleteSupersededChannels: deleted $id (replaced by its _v2 channel)")
            }
        }

        /** The bundled palette-A sound `res/raw/<name>`, as a channel sound. */
        private fun gazouillisUri(context: Context, rawId: Int): android.net.Uri =
            android.net.Uri.parse("android.resource://${context.packageName}/$rawId")

        /**
         * Creates the notification channels if they do not exist yet.
         * Called from [CanariApplication.onCreate] and as a fallback from
         * [CanariFirebaseMessagingService.ensureNotificationChannels].
         *  - canari_messages_v2 : DMs and group messages (IMPORTANCE_HIGH, vibration, palette-A "message" trill)
         *  - canari_social   : reactions/comments on posts (IMPORTANCE_DEFAULT, silent)
         *  - canari_forms    : form reminders (IMPORTANCE_DEFAULT, silent)
         *  - canari_calls_v2 : incoming call rings (WP-XP-5: IMPORTANCE_HIGH, RINGTONE usage,
         *                      bypass-DND requested - the user can confirm it in channel settings;
         *                      Canari's own ring `res/raw/canari_ring.wav` since 2026-11-01, which
         *                      the user may still change there)
         *  - canari_mentions_v2 : messages that @-mention the user (WP-XP-5: IMPORTANCE_HIGH,
         *                      bypass-DND requested)
         *
         * A channel's name and description are written HERE ONLY WHEN THE CHANNEL IS ABSENT (each
         * block below checks `getNotificationChannel(id) == null` first). Android itself would accept
         * a new name and description from a second `createNotificationChannel` on an existing id -
         * only the importance, sound and vibration are fixed once created (or once the user changed
         * them) - but this code never makes that call, so a user who switches the app's language
         * keeps the wording of the day the channel was created. Renaming on a language change is
         * possible without touching the user's sound or importance, and is not done. [context] is
         * threaded here so the creation uses the app's language rather than the system locale.
         */
        internal fun ensureChannels(context: Context, manager: NotificationManager) {
            val res = appLocaleContext(context)
            // Read BEFORE the delete: what the user set on the old calls channel is carried to v2.
            val oldCalls = supersededCallsChannel(context, manager)
            deleteSupersededChannels(manager)
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_MESSAGES) == null) {
                val audioAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_MESSAGES,
                        res.getString(R.string.notif_channel_messages_name),
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = res.getString(R.string.notif_channel_messages_desc)
                        enableVibration(true)
                        setSound(gazouillisUri(context, R.raw.canari_gazouillis_message), audioAttrs)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_SOCIAL) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_SOCIAL,
                        res.getString(R.string.notif_channel_social_name),
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = res.getString(R.string.notif_channel_social_desc)
                        enableVibration(false)
                        setSound(null, null)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_FORMS) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_FORMS,
                        res.getString(R.string.notif_channel_forms_name),
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = res.getString(R.string.notif_channel_forms_desc)
                        enableVibration(false)
                        setSound(null, null)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_CALLS) == null) {
                // Ringtone-class audio so an incoming call sounds like a call, not a message, and
                // Canari's own ring (`IncomingRing`, owner 2026-11-01), with the importance and the
                // vibration the user left on the old `canari_calls` (`supersededCallsChannel`).
                // setBypassDnd is a REQUEST: the system honors it only if the user grants the channel
                // "override Do Not Disturb" (surfaced in the channel settings) - which is why a grant
                // the old channel had is owed again, and the app asks for it once.
                val ringAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build()
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_CALLS,
                        res.getString(R.string.notif_channel_calls_name),
                        IncomingRing.inheritedImportance(oldCalls?.importance)
                    ).apply {
                        description = res.getString(R.string.notif_channel_calls_desc)
                        enableVibration(oldCalls?.vibrates ?: true)
                        vibrationPattern = IncomingRing.VIBRATION_PATTERN
                        // A sound the user set to None stays None; otherwise Canari's ring.
                        if (oldCalls?.silent == true) setSound(null, null)
                        else setSound(gazouillisUri(context, R.raw.canari_ring), ringAttrs)
                        oldCalls?.let {
                            lockscreenVisibility = it.lockscreenVisibility
                            setShowBadge(it.showBadge)
                        }
                        setBypassDnd(true)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_REACTIONS) == null) {
                // Heard but not intrusive: IMPORTANCE_DEFAULT makes a sound and shows in the shade
                // without a heads-up, and there is no vibration and no bypassDnd. A reaction is
                // something you want to know about, not something that should interrupt you - which
                // is the entire reason it left CHANNEL_MESSAGES.
                val audioAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_REACTIONS,
                        res.getString(R.string.notif_channel_reactions_name),
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = res.getString(R.string.notif_channel_reactions_desc)
                        enableVibration(false)
                        setSound(gazouillisUri(context, R.raw.canari_gazouillis_reaction), audioAttrs)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_MENTIONS) == null) {
                val audioAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_MENTIONS,
                        res.getString(R.string.notif_channel_mentions_name),
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = res.getString(R.string.notif_channel_mentions_desc)
                        enableVibration(true)
                        setSound(gazouillisUri(context, R.raw.canari_gazouillis_mention), audioAttrs)
                        setBypassDnd(true)
                    }
                )
            }
        }
    }
}
