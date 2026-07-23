package fr.emse.canari

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Shared deferred-retry engine for the outbox drain (WP-XP-8). When the opportunistic outbox drain
 * (FCM, Welcome, boot) leaves messages unsent, this worker retries with exponential backoff behind
 * Android WorkManager. After 3 consecutive failures the worker enters a persistent failure state and
 * shows the "open the app" nudge — the same UX as [MlsBackgroundWorker].
 *
 * iOS counterpart: BGTaskScheduler handler `fr.emse.canari.outboxRetry` in canari_push.mm.
 */
class OutboxRetryWorker(context: Context, workerParams: WorkerParameters) :
    Worker(context, workerParams) {

    companion object {
        const val TAG = "CanariOutboxRetry"

        /** SharedPreferences file for the persistent failure flag. */
        const val PREFS_WORKER = "canari_outbox_retry_prefs"
        const val KEY_FAILED = "outbox_retry_failed"

        /**
         * Resets the persistent failure flag so the next outbox drain failure can enqueue a fresh
         * worker. Called from [MainActivity.onResume] when the user opens the app.
         */
        fun resetFailureFlag(context: Context) {
            context.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, false).apply()
            Log.d(TAG, "resetFailureFlag: flag reset")
        }

        /** True when the worker is in persistent failure state (user must open the app). */
        fun isInFailureState(context: Context): Boolean {
            return context.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .getBoolean(KEY_FAILED, false)
        }

        /**
         * Enqueues a one-shot expedited work request with exponential backoff (30s → 60s → 120s …).
         * No-op when the persistent failure flag is set: the user must open the app to reset it.
         */
        fun enqueueIfHealthy(context: Context) {
            if (isInFailureState(context)) {
                Log.w(TAG, "enqueueIfHealthy: persistent failure — ignored (user must open the app)")
                return
            }
            val request = OneTimeWorkRequestBuilder<OutboxRetryWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    30_000L,
                    TimeUnit.MILLISECONDS
                )
                .build()
            WorkManager.getInstance(context).enqueue(request)
            Log.d(TAG, "enqueueIfHealthy: worker enqueued")
        }
    }

    override fun doWork(): Result {
        if (runAttemptCount >= 3) {
            Log.e(TAG, "doWork: max retries reached ($runAttemptCount) — persistent failure")
            applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, true).apply()
            CanariFirebaseMessagingService.showPendingSyncNotification(applicationContext)
            return Result.failure()
        }
        Log.d(TAG, "doWork: attempt $runAttemptCount")

        // Foreground guard: the TS outbox flusher is active while the WebView is visible.
        // Processing here in parallel would double-send (duplicate delivery). Defer the retry
        // — on the next attempt the app will likely be in the background, otherwise the
        // foreground already handled it.
        if (MainActivity.isInForeground) {
            Log.d(TAG, "doWork: app in foreground — outbox handled by TS, retry deferred")
            return Result.retry()
        }

        val ctx = MlsContextLoader.loadPushContext(applicationContext)
        if (ctx == null) {
            Log.e(TAG, "doWork: push_context.json missing — permanent failure")
            return Result.failure()
        }

        val service = CanariFirebaseMessagingService()
        val remaining = CanariFirebaseMessagingService.drainOutboxBackground(
            applicationContext, service, ctx
        )

        return if (remaining == 0) {
            Log.d(TAG, "doWork: outbox drained — success")
            Result.success()
        } else {
            Log.d(TAG, "doWork: $remaining message(s) still queued — retry")
            // Show the nudge on every failure so the user can choose to open the app early,
            // without waiting for the 3-attempt threshold.
            CanariFirebaseMessagingService.showPendingSyncNotification(applicationContext)
            Result.retry()
        }
    }
}
