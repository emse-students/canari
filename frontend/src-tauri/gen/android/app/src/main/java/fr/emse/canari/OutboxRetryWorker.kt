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

        /** Real drain attempts (never foreground deferrals) before the "open the app" nudge. */
        private const val MAX_DRAIN_ATTEMPTS = 3

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

    /**
     * THE QUEUE IS LOOKED AT FIRST, AND ONLY A DRAIN THAT RAN IS AN ATTEMPT.
     *
     * This used to check WorkManager's `runAttemptCount` before anything else, and that counter
     * counts every `Result.retry()` - including the foreground deferral below, which sends nothing.
     * So a worker enqueued for a reply the app then flushed itself went: deferred, deferred,
     * deferred, "max retries reached", and posted "Vous avez peut-etre des messages en attente" over
     * an EMPTY outbox. It also posted that nudge on the first failed drain, beside the reply
     * notification the receiver had already re-posted as pending. Measured on a Mi 9T, 2026-10-01.
     *
     * Now: an empty outbox owes nothing and succeeds; a deferral is not counted; a real drain that
     * leaves entries is counted in [PREFS_WORKER] under this request's id, and the nudge is posted
     * once, when [MAX_DRAIN_ATTEMPTS] real attempts have failed - the state it actually describes.
     */
    override fun doWork(): Result {
        val queued = CanariFirebaseMessagingService.readOutboxMirror(applicationContext).size
        if (queued == 0) {
            Log.d(TAG, "doWork: outbox empty - nothing owed (run $runAttemptCount)")
            forgetAttempts()
            return Result.success()
        }

        // Foreground guard: the TS outbox flusher is active while the WebView is visible.
        // Processing here in parallel would double-send (duplicate delivery). Defer - and a deferral
        // sends nothing, so it is NOT counted as an attempt.
        if (MainActivity.isInForeground) {
            Log.d(TAG, "doWork: app in foreground with $queued queued - outbox handled by TS, retry deferred (not an attempt)")
            return Result.retry()
        }

        val ctx = MlsContextLoader.loadPushContext(applicationContext)
        if (ctx == null) {
            Log.e(TAG, "doWork: push_context.json missing — permanent failure")
            forgetAttempts()
            return Result.failure()
        }

        val attempt = recordAttempt()
        Log.d(TAG, "doWork: drain attempt $attempt/$MAX_DRAIN_ATTEMPTS ($queued queued)")
        val service = CanariFirebaseMessagingService()
        val remaining = CanariFirebaseMessagingService.drainOutboxBackground(
            applicationContext, service, ctx
        )

        if (remaining == 0) {
            Log.d(TAG, "doWork: outbox drained — success")
            forgetAttempts()
            return Result.success()
        }
        if (attempt >= MAX_DRAIN_ATTEMPTS) {
            Log.e(TAG, "doWork: $remaining message(s) still queued after $attempt drain attempts — persistent failure")
            applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, true).apply()
            CanariFirebaseMessagingService.showPendingSyncNotification(applicationContext)
            forgetAttempts()
            return Result.failure()
        }
        Log.d(TAG, "doWork: $remaining message(s) still queued — retry")
        return Result.retry()
    }

    /** This request's own attempt counter - one per enqueued request, so two never share a count. */
    private val attemptsKey: String get() = "drain_attempts_$id"

    /** Counts one real drain attempt and returns the new total. */
    private fun recordAttempt(): Int {
        val prefs = applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
        val next = prefs.getInt(attemptsKey, 0) + 1
        // commit(): the count must be on disk before the drain, or a kill during it loses it.
        prefs.edit().putInt(attemptsKey, next).commit()
        return next
    }

    /** Drops this request's counter once it has a final result. */
    private fun forgetAttempts() {
        applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
            .edit().remove(attemptsKey).apply()
    }
}
