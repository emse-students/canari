package fr.emse.canari

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters

class MlsBackgroundWorker(context: Context, workerParams: WorkerParameters) :
    Worker(context, workerParams) {

    companion object {
        const val TAG = "CanariWorker"
        /** ID of the foreground notification shown when the worker runs in expedited mode. */
        private const val FOREGROUND_NOTIF_ID = 9998
        /** ID of the "open the app" notification shown after 3 consecutive failures. */
        private const val FAILURE_NOTIF_ID = 9997

        const val PREFS_WORKER = "canari_worker_prefs"
        const val KEY_FAILED   = "mls_bg_failed"

        /**
         * Resets the persistent failure flag - to be called from [MainActivity.onResume]
         * as soon as the user opens the app, so that the next FCM messages enqueue again.
         */
        fun resetFailureFlag(context: Context) {
            context.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, false).apply()
            Log.d(TAG, "resetFailureFlag: flag reset")
        }

        /** Shows a notification inviting the user to open the app to unblock the sync. */
        private fun showWorkerFailureNotification(ctx: Context) {
            val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            CanariApplication.ensureChannels(manager)
            val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
            val pi = PendingIntent.getActivity(
                ctx, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notif = NotificationCompat.Builder(ctx, CanariFirebaseMessagingService.CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Canari - Synchronisation en attente")
                .setContentText("Ouvrez l'app pour recevoir vos messages chiffrés.")
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pi)
                .build()
            manager.notify(FAILURE_NOTIF_ID, notif)
            Log.w(TAG, "showWorkerFailureNotification: notification shown")
        }
    }

    // Dedicated JNI bridge for queue processing (Welcome, etc.)
    external fun nativeProcessBackgroundTasks(filesDir: String, stateBytes: ByteArray, pin: String, userId: String, deviceId: String): Boolean

    /**
     * Required for expedited workers: provides the foreground notification shown
     * if Android decides to promote the worker to a ForegroundService (rare in practice).
     */
    override fun getForegroundInfo(): ForegroundInfo {
        val notification = NotificationCompat.Builder(
            applicationContext, CanariFirebaseMessagingService.CHANNEL_MESSAGES
        )
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Canari")
            .setContentText("Synchronisation des messages…")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        return ForegroundInfo(FOREGROUND_NOTIF_ID, notification)
    }

    override fun doWork(): Result {
        if (runAttemptCount >= 3) {
            Log.e(TAG, "doWork: max retries reached, giving up")
            applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, true).apply()
            showWorkerFailureNotification(applicationContext)
            return Result.failure()
        }
        Log.d(TAG, "doWork: starting (attempt $runAttemptCount)")

        // Foreground guard: if the app came back to the foreground since the enqueue, the Tauri
        // MLS engine is already processing via WebSocket and writing mls.bin. Processing here in
        // parallel would clobber the state (lost KeyPackages, epoch gaps). We defer: on the next
        // retry the app will likely be in the background again, otherwise the foreground handled it.
        if (MainActivity.isInForeground) {
            Log.d(TAG, "doWork: app in foreground -> MLS handled by the foreground, retry deferred")
            return Result.retry()
        }

        val ctx = MlsContextLoader.loadPushContext(applicationContext)
        if (ctx == null) {
            Log.e(TAG, "doWork: push_context.json missing or invalid -> failure")
            return Result.failure()
        }
        val filesDir = MlsContextLoader.tauriDataDir(applicationContext).also { it.mkdirs() }.absolutePath

        // Acquire lock BEFORE reading mls.bin: FCM threads write mls.bin concurrently
        // (nativeDecryptMessage). Reading outside the lock risks JNI-processing stale state.
        // tryLock throws InterruptedException under Android memory pressure - must be caught.
        val lockAcquired = try {
            MlsStateLock.LOCK.tryLock(15, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "doWork: thread interrupted during tryLock: ${e.message}")
            return Result.retry()
        }
        if (!lockAcquired) {
            Log.w(TAG, "doWork: MlsStateLock not acquired after 15s -> retry")
            return Result.retry()
        }
        return try {
            val stateBytes = MlsContextLoader.loadMlsState(applicationContext)
            if (stateBytes == null) {
                Log.e(TAG, "doWork: mls.bin absent -> failure")
                return Result.failure()
            }
            Log.d(TAG, "doWork: MLS state=${stateBytes.size} bytes, filesDir=$filesDir")
            val success = nativeProcessBackgroundTasks(filesDir, stateBytes, ctx.pin, ctx.userId, ctx.deviceId)
            if (success) {
                Log.d(TAG, "doWork: nativeProcessBackgroundTasks -> success")
                Result.success()
            } else {
                Log.w(TAG, "doWork: nativeProcessBackgroundTasks -> false, retry")
                Result.retry()
            }
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "doWork: native library not loaded -> retry: ${e.message}")
            Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "doWork: unexpected exception -> failure: ${e.message}")
            Result.failure()
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

}