package fr.emse.canari

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Boot/relaunch re-registration (WP-XP-4). Fired at device boot (`BOOT_COMPLETED`, delivered
 * after the user unlocks - credential-encrypted storage is available) and after an app update
 * (`MY_PACKAGE_REPLACED`). Without it, an FCM token that rotated while the phone was off stays
 * dead server-side (pushes sent to the old token) until the user manually opens the app, and
 * outbox messages queued before the reboot wait just as long.
 *
 * Two best-effort steps, both silent no-ops when the device is not enrolled yet:
 *  1. Force-read the current FCM token ([FirebaseMessaging.getToken] - `onNewToken` only fires
 *     on CHANGE, which the process missed while off), persist it (`fcm_token.txt` + prefs) and
 *     re-register it on the backend via PushSecret
 *     ([CanariFirebaseMessagingService.refreshTokenOnBackend]).
 *  2. Warm the MLS state and drain the outbox mirror
 *     ([CanariFirebaseMessagingService.drainOutboxBackground]) so messages queued before the
 *     reboot go out now instead of at the next push/open.
 *
 * iOS counterpart: no OS boot hook exists; the equivalent launch-time force-fetch lives in
 * `canari_push.mm` `CanariPushSetup` (tokenWithCompletion -> CanariPersistFcmToken).
 */
class CanariBootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "CanariBoot"
        /** Max wait for the FCM token force-read; boot is not latency-sensitive. */
        private const val TOKEN_FETCH_TIMEOUT_S = 20L
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            Log.w(TAG, "onReceive: unexpected action $action")
            return
        }
        Log.i(TAG, "onReceive: $action -> push token re-registration + outbox drain")
        val appContext = context.applicationContext
        val pendingResult = goAsync()
        val wakeLock = (appContext.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "canari:boot_reregister")
        wakeLock.acquire(60_000L)
        Thread(null, {
            try {
                reRegisterToken(appContext)
                drainPendingOutbox(appContext)
            } catch (e: Exception) {
                Log.e(TAG, "onReceive: exception: ${e.message}")
            } finally {
                if (wakeLock.isHeld) wakeLock.release()
                pendingResult.finish()
            }
        }, "canari-boot").start()
    }

    /**
     * Force-reads the current FCM token, persists it where the Rust command `get_fcm_token`
     * and the foreground registration read it, and re-registers it on the backend. Unconditional
     * backend refresh (even for an unchanged token): the POST is tiny, once per boot, and also
     * heals a token entry the backend dropped/expired while the device was off.
     */
    private fun reRegisterToken(context: Context) {
        val token = try {
            Tasks.await(FirebaseMessaging.getInstance().token, TOKEN_FETCH_TIMEOUT_S, TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.w(TAG, "reRegisterToken: FCM token fetch failed: ${e.message}")
            return
        }
        if (token.isNullOrEmpty()) {
            Log.w(TAG, "reRegisterToken: empty token")
            return
        }
        val prefs = context.getSharedPreferences(
            CanariFirebaseMessagingService.PREFS_NAME, Context.MODE_PRIVATE
        )
        val previous = prefs.getString(CanariFirebaseMessagingService.KEY_FCM_TOKEN, null)
        prefs.edit().putString(CanariFirebaseMessagingService.KEY_FCM_TOKEN, token).apply()
        try {
            val dataDir = MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }
            File(dataDir, "fcm_token.txt").writeText(token)
        } catch (e: Exception) {
            Log.w(TAG, "reRegisterToken: unable to write fcm_token.txt: ${e.message}")
        }
        Log.i(TAG, "reRegisterToken: token ${if (token == previous) "unchanged" else "ROTATED"}")

        val pushCtx = MlsContextLoader.loadPushContext(context)
        val secret = CanariFirebaseMessagingService.retrievePushSecret(context)
        if (pushCtx == null || secret == null) {
            Log.d(TAG, "reRegisterToken: context/secret absent -> backend refresh deferred to foreground")
            return
        }
        CanariFirebaseMessagingService.refreshTokenOnBackend(pushCtx, secret, token)
    }

    /**
     * Drains messages queued in the outbox mirror before the reboot, via the exact same
     * encrypt+POST path the FCM service and the quick-reply receiver use. Loading the MLS state
     * through the JNI also warms it for the next background decrypt.
     */
    private fun drainPendingOutbox(context: Context) {
        if (CanariFirebaseMessagingService.readOutboxMirror(context).isEmpty()) {
            Log.d(TAG, "drainPendingOutbox: outbox empty")
            return
        }
        val pushCtx = MlsContextLoader.loadPushContext(context)
        if (pushCtx == null) {
            Log.w(TAG, "drainPendingOutbox: push_context.json absent -> abort")
            return
        }
        // Bare service instance: only backs the JNI-bound native calls (never used as a Context).
        val service = CanariFirebaseMessagingService()
        val remaining = CanariFirebaseMessagingService.drainOutboxBackground(context, service, pushCtx)
        Log.i(TAG, "drainPendingOutbox: done, $remaining message(s) still queued")
    }
}
