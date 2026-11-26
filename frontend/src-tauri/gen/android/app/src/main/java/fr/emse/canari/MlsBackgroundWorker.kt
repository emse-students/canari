package fr.emse.canari

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters
import fr.emse.canari.push.SweepFailureLedger

/**
 * The pending-DB sweep a refused push frame enqueues (`nativeProcessBackgroundTasks` ->
 * `background.rs` `cleanup_pending_db`).
 *
 * **IT DOES NOT RETRY THE FRAME**: it never fetches, decrypts or re-posts, so the generic line a
 * refused push drew stays until the app's drain reads the message. Step 6 of the background ladder
 * said otherwise until 2026-11-25. A frame the server could not be reached for is replayed by
 * [HeldFrameWorker] instead.
 */
class MlsBackgroundWorker(context: Context, workerParams: WorkerParameters) :
    Worker(context, workerParams) {

    companion object {
        const val TAG = "CanariWorker"
        /** ID of the foreground notification shown when the worker runs in expedited mode. */
        private const val FOREGROUND_NOTIF_ID = fr.emse.canari.push.FixedNotifIds.WORKER_FOREGROUND
        /** ID of the "open the app" notification shown after [SweepFailureLedger.GIVE_UP_AFTER] consecutive REAL failures. */
        private const val FAILURE_NOTIF_ID = fr.emse.canari.push.FixedNotifIds.BACKGROUND_FAILURE

        const val PREFS_WORKER = "canari_worker_prefs"
        /** Set when a streak of real failures gave up; read by `enqueueWorkerIfHealthy`, which then enqueues nothing. */
        const val KEY_FAILED   = "mls_bg_failed"
        /** The streak of consecutive REAL sweep failures [SweepFailureLedger] folds, across work requests. */
        const val KEY_CONSECUTIVE_FAILURES = "mls_bg_consecutive_failures"

        /**
         * Resets the persistent failure flag and the failure streak - to be called from
         * [MainActivity.onResume] as soon as the user opens the app, so that the next FCM messages
         * enqueue again and a new streak starts from zero.
         */
        fun resetFailureFlag(context: Context) {
            context.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, false).putInt(KEY_CONSECUTIVE_FAILURES, 0).apply()
            Log.d(TAG, "resetFailureFlag: flag and failure streak reset")
        }

        /** Shows a notification inviting the user to open the app to unblock the sync. */
        private fun showWorkerFailureNotification(ctx: Context) {
            val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            CanariApplication.ensureChannels(ctx, manager)
            val res = appLocaleContext(ctx)
            val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
            val pi = PendingIntent.getActivity(
                ctx, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notif = NotificationCompat.Builder(ctx, CanariFirebaseMessagingService.CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(res.getString(R.string.notif_sync_blocked_title))
                .setContentText(res.getString(R.string.notif_sync_blocked_body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pi)
                .build()
            manager.notify(FAILURE_NOTIF_ID, notif)
            Log.w(TAG, "showWorkerFailureNotification: notification shown")
        }
    }

    /**
     * Prunes `mls_pending.db` under [filesDir] (`background.rs` `cleanup_pending_db`), the same call
     * as iOS's `canari_native_cleanup_pending_db`. It reads neither `mls.bin` nor the push context,
     * so it is handed neither. True when the sweep completed.
     */
    external fun nativeProcessBackgroundTasks(filesDir: String): Boolean

    /**
     * Required for expedited workers: provides the foreground notification shown
     * if Android decides to promote the worker to a ForegroundService (rare in practice).
     */
    override fun getForegroundInfo(): ForegroundInfo {
        val res = appLocaleContext(applicationContext)
        val notification = NotificationCompat.Builder(
            applicationContext, CanariFirebaseMessagingService.CHANNEL_MESSAGES
        )
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(res.getString(R.string.app_name))
            .setContentText(res.getString(R.string.notif_sync_running_body))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        return ForegroundInfo(FOREGROUND_NOTIF_ID, notification)
    }

    override fun doWork(): Result {
        Log.d(TAG, "doWork: starting (attempt $runAttemptCount)")
        val filesDir = MlsContextLoader.tauriDataDir(applicationContext).also { it.mkdirs() }.absolutePath
        // THE SWEEP TOUCHES `mls_pending.db` ALONE, through SQLite's own locking (WAL, busy timeout),
        // so nothing here waits for the foreground or for `MlsStateLock`: neither guards a file this
        // work reads. Both used to return `Result.retry()`, and three of those raised the "open the
        // app" notice with the app open ([SweepFailureLedger]).
        val outcome: SweepFailureLedger.Outcome = try {
            if (nativeProcessBackgroundTasks(filesDir)) {
                SweepFailureLedger.Outcome.Swept
            } else {
                SweepFailureLedger.Outcome.Failed("native sweep answered false")
            }
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "doWork: native library not loaded: ${e.message}") // log-safe: message of a system or native call (UnsatisfiedLinkError); this try parses and names no user input
            SweepFailureLedger.Outcome.Failed("native library not loaded")
        } catch (e: Exception) {
            Log.e(TAG, "doWork: sweep threw ${e.javaClass.simpleName}: ${e.message}") // log-safe: message of a system or native call (Exception); this try parses and names no user input
            SweepFailureLedger.Outcome.Failed("sweep threw")
        }

        val prefs = applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
        val decision = SweepFailureLedger.next(prefs.getInt(KEY_CONSECUTIVE_FAILURES, 0), outcome)
        prefs.edit().putInt(KEY_CONSECUTIVE_FAILURES, decision.consecutiveFailures).apply()
        val cause = (outcome as? SweepFailureLedger.Outcome.Failed)?.cause
        val streak = decision.consecutiveFailures
        return when (decision.verdict) {
            SweepFailureLedger.Verdict.DONE -> {
                Log.d(TAG, "doWork: pending DB swept")
                Result.success()
            }
            SweepFailureLedger.Verdict.RETRY -> {
                Log.e(TAG, "doWork: $cause -> retry (consecutive failures=$streak/${SweepFailureLedger.GIVE_UP_AFTER})")
                Result.retry()
            }
            SweepFailureLedger.Verdict.GIVE_UP -> {
                Log.e(TAG, "doWork: $cause -> giving up (consecutive failures=$streak)")
                prefs.edit().putBoolean(KEY_FAILED, true).apply()
                if (decision.raisesNotice) showWorkerFailureNotification(applicationContext)
                Result.failure()
            }
        }
    }

}