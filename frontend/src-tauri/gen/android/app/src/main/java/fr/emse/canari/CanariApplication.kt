package fr.emse.canari

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
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
        migrateDeviceKeyFromJson()
        checkKeystoreHealth()
        recordInstallerPackage()
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

    /**
     * WP-SEC-1 one-shot migration: existing installs hold the device key only in
     * push_context.json. Promote it to the Android Keystore, then strip the field
     * from the JSON. The background readers (MlsContextLoader) never fall back to
     * the JSON — if the app has not run since the update, one push falls back to
     * the generic text and the next launch fixes it permanently.
     */
    private fun migrateDeviceKeyFromJson() {
        try {
            val file = File(MlsContextLoader.tauriDataDir(this), "push_context.json")
            if (!file.exists()) return
            val j = org.json.JSONObject(file.readText())
            val deviceKeyB64 = j.optString("deviceKeyB64", "")
            if (deviceKeyB64.isEmpty()) return
            val userId = j.optString("userId", "")
            val deviceId = j.optString("deviceId", "")
            if (userId.isEmpty() || deviceId.isEmpty()) return

            val stored = MlsDeviceKeyStore.store(this, userId, deviceId, deviceKeyB64)
            if (!stored) {
                Log.w(TAG, "migrateDeviceKeyFromJson: Keystore store failed — keeping JSON field for now")
                return
            }

            // Strip the field and rewrite.
            j.remove("deviceKeyB64")
            file.writeText(j.toString())
            Log.i(TAG, "migrateDeviceKeyFromJson: key promoted to Keystore, JSON stripped")
        } catch (e: Exception) {
            Log.e(TAG, "migrateDeviceKeyFromJson: exception: ${e.message}", e)
        }
    }

    internal fun processPendingPushSecret() {
        try {
            val file = File(MlsContextLoader.tauriDataDir(this), "pending_push_secret.txt")
            if (!file.exists()) return
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

    companion object {
        private const val TAG = "CanariApp"

        /**
         * Creates the notification channels if they do not exist yet.
         * Called from [CanariApplication.onCreate] and as a fallback from
         * [CanariFirebaseMessagingService.ensureNotificationChannels].
         *  - canari_messages : DMs and group messages (IMPORTANCE_HIGH, vibration, sound)
         *  - canari_social   : reactions/comments on posts (IMPORTANCE_DEFAULT, silent)
         *  - canari_forms    : form reminders (IMPORTANCE_DEFAULT, silent)
         *  - canari_calls    : incoming call rings (WP-XP-5: IMPORTANCE_HIGH, RINGTONE sound,
         *                      bypass-DND requested - the user can confirm it in channel settings)
         *  - canari_mentions : messages that @-mention the user (WP-XP-5: IMPORTANCE_HIGH,
         *                      bypass-DND requested)
         *
         * A channel's name and description are WRITTEN ONCE, at creation: Android keeps the strings
         * it was given and re-creating an existing channel changes nothing. A user who switches the
         * app's language therefore keeps the wording of the day they installed, until the channel is
         * deleted - which would also discard the sound and importance THEY chose. Naming the channel
         * in the wrong language is the smaller harm, and it is the reason [context] is threaded here
         * rather than the strings being read from the system locale.
         */
        internal fun ensureChannels(context: Context, manager: NotificationManager) {
            val res = appLocaleContext(context)
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
                        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audioAttrs)
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
                // Ringtone-class audio so an incoming call sounds like a call, not a message.
                // setBypassDnd is a REQUEST: the system honors it only if the user grants the
                // channel "override Do Not Disturb" (surfaced in the channel settings).
                val ringAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build()
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_CALLS,
                        res.getString(R.string.notif_channel_calls_name),
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = res.getString(R.string.notif_channel_calls_desc)
                        enableVibration(true)
                        vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
                        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ringAttrs)
                        setBypassDnd(true)
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
                        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audioAttrs)
                        setBypassDnd(true)
                    }
                )
            }
        }
    }
}
