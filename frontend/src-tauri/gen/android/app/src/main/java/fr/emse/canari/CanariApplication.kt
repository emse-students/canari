package fr.emse.canari

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.util.Log
import java.io.File

/**
 * Custom Application loaded BEFORE any Android component (including the FCM services).
 * Roles:
 *  1. Load the native Rust library mines_app_lib.
 *  2. Create the Android notification channels (required since API 26).
 *  3. Transfer the pushSecret from pending_push_secret.txt to the Android Keystore
 *     (written by Tauri after FCM registration, read exactly once then deleted).
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
        createNotificationChannels()
        processPendingPushSecret()
        checkKeystoreHealth()
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        ensureChannels(manager)
    }

    /**
     * Verifies that the Android Keystore can read the push secret (key not lost).
     * Writes `keystore_ok.flag` if OK, deletes it otherwise.
     * The Tauri command `check_push_secret_health` reads this flag to signal the UI.
     * Silent call: an error here must not block startup.
     */
    internal fun checkKeystoreHealth() {
        try {
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
         * Creates the three notification channels if they do not exist yet.
         * Called from [CanariApplication.onCreate] and as a fallback from
         * [CanariFirebaseMessagingService.ensureNotificationChannels].
         *  - canari_messages : DMs and group messages (IMPORTANCE_HIGH, vibration, sound)
         *  - canari_social   : reactions/comments on posts (IMPORTANCE_DEFAULT, silent)
         *  - canari_forms    : form reminders (IMPORTANCE_DEFAULT, silent)
         */
        internal fun ensureChannels(manager: NotificationManager) {
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_MESSAGES) == null) {
                val audioAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_MESSAGES,
                        "Messages Canari",
                        NotificationManager.IMPORTANCE_HIGH
                    ).apply {
                        description = "Notifications de messages reçus via Canari"
                        enableVibration(true)
                        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), audioAttrs)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_SOCIAL) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_SOCIAL,
                        "Activité sociale Canari",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = "Réactions et commentaires sur vos publications"
                        enableVibration(false)
                        setSound(null, null)
                    }
                )
            }
            if (manager.getNotificationChannel(CanariFirebaseMessagingService.CHANNEL_FORMS) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CanariFirebaseMessagingService.CHANNEL_FORMS,
                        "Rappels de formulaires",
                        NotificationManager.IMPORTANCE_DEFAULT
                    ).apply {
                        description = "Rappels avant l'ouverture des formulaires"
                        enableVibration(false)
                        setSound(null, null)
                    }
                )
            }
        }
    }
}
