package fr.emse.canari

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import fr.emse.canari.push.OutboxRetry
import java.util.concurrent.TimeUnit

/**
 * Shared deferred-retry engine for the outbox drain (WP-XP-8). When the opportunistic outbox drain
 * (FCM, Welcome, boot) leaves messages unsent, this worker retries with exponential backoff behind
 * Android WorkManager - for as long as every entry left CAN still go ([OutboxRetry]). It ends in a
 * persistent failure state, with the "open the app" nudge, only when durable state says a retry
 * cannot succeed: an entry the server refused, no push secret, no MLS state, an unreadable push
 * context. Never on a count of attempts.
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

        /** The ONE unique work name every enqueue goes under. */
        private const val UNIQUE_WORK = "canari_outbox_retry"

        /** Set once the requests of the builds before [UNIQUE_WORK] have been cancelled. */
        private const val KEY_LEGACY_CANCELLED = "outbox_retry_legacy_cancelled"

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
         * THE APP'S MOVE TO THE BACKGROUND HANDS THE OUTBOX BACK TO THIS WORKER. A run that finds the
         * app in front ENDS its request ([OutboxRetry.Run.END_FOR_PAGE]), so nothing native would
         * retry an entry the page had not sent by the time it left the screen; this enqueues a fresh
         * request whenever the mirror still holds one. Called by [MainActivity.onPause], off the main
         * thread (it reads the mirror).
         */
        fun enqueueIfMirrorHolds(context: Context) {
            val queued = CanariFirebaseMessagingService.readOutboxMirrorOrNull(context)
            when {
                queued == null -> {
                    Log.w(TAG, "enqueueIfMirrorHolds: outbox mirror unreadable - a retry is enqueued, the worker reads it again")
                    enqueueIfHealthy(context)
                }
                queued.isEmpty() -> Log.d(TAG, "enqueueIfMirrorHolds: outbox mirror empty - nothing to hand back")
                else -> {
                    Log.d(TAG, "enqueueIfMirrorHolds: ${queued.size} queued as the app leaves the front - retry enqueued")
                    enqueueIfHealthy(context)
                }
            }
        }

        /**
         * Enqueues the retry under ONE unique name, with exponential backoff (30s -> 60s -> 120s
         * ...). No-op when the persistent failure flag is set: the user must open the app to reset it.
         *
         * ONLY WITH A NETWORK (`NetworkType.CONNECTED`, as the iOS twin's
         * `requiresNetworkConnectivity`): a drain run offline fails by construction, and WorkManager
         * runs it once a network is back rather than spending a run of its backoff.
         *
         * UNIQUE, `APPEND_OR_REPLACE`: each enqueue owes one drain AFTER it. `KEEP` would drop an
         * enqueue that arrives while a run is past its drain, and that run's success would leave the
         * new entry unretried; appended, it runs once the current one ends (a failed or cancelled
         * one is replaced). The plain `enqueue` of earlier builds left unconstrained requests behind:
         * they carry WorkManager's default tag, the worker's class name, and are cancelled ONCE,
         * before the first unique enqueue, recorded in [PREFS_WORKER].
         */
        fun enqueueIfHealthy(context: Context) {
            if (isInFailureState(context)) {
                Log.w(TAG, "enqueueIfHealthy: persistent failure — ignored (user must open the app)")
                return
            }
            val workManager = WorkManager.getInstance(context)
            val prefs = context.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
            if (!prefs.getBoolean(KEY_LEGACY_CANCELLED, false)) {
                try {
                    // Waited on: the cancel must land before the unique enqueue, which carries
                    // the same class tag.
                    workManager.cancelAllWorkByTag(OutboxRetryWorker::class.java.name).result.get()
                    prefs.edit().putBoolean(KEY_LEGACY_CANCELLED, true).commit()
                    Log.i(TAG, "enqueueIfHealthy: the requests of earlier builds were cancelled once")
                } catch (e: Exception) {
                    Log.e(TAG, "enqueueIfHealthy: cancelling the earlier builds' requests failed - tried again at the next enqueue: ${e.javaClass.simpleName}")
                }
            }
            val request = OneTimeWorkRequestBuilder<OutboxRetryWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    30_000L,
                    TimeUnit.MILLISECONDS
                )
                .build()
            workManager.enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
            Log.d(TAG, "enqueueIfHealthy: worker enqueued")
        }
    }

    /**
     * THE QUEUE IS LOOKED AT FIRST, AND THE RETRY ENDS ON DURABLE STATE, NEVER ON A COUNT.
     *
     * An empty mirror owes nothing and succeeds (measured on a Mi 9T, 2026-10-01: a count of
     * WorkManager's runs once posted the nudge over an empty outbox). With the app in front the
     * outbox is the page's: the request ENDS - a `Result.retry()` there grew the backoff of a chain
     * the next request is appended behind, so a reply queued after a long foreground session could
     * wait for hours - and the move to the background enqueues a fresh one
     * ([enqueueIfMirrorHolds]). Otherwise the drain says why each entry it left remains
     * ([OutboxRetry.Prospect]): every one NOT_YET is a retry under WorkManager's backoff, with no
     * cap (three attempts used to end it, about three and a half minutes - a backend down that long
     * spent them all, #3912 review); one NEVER, or an unreadable push context, ends it with the nudge.
     */
    override fun doWork(): Result {
        val queued = CanariFirebaseMessagingService.readOutboxMirror(applicationContext).size
        when (OutboxRetry.run(queued, MainActivity.isInForeground)) {
            OutboxRetry.Run.NOTHING_OWED -> {
                Log.d(TAG, "doWork: outbox empty - nothing owed (run $runAttemptCount)")
                // Emptied by something that is not a native drain (the app's own flush while the
                // WebView ran in the background): the nudge follows the mirror here too.
                CanariFirebaseMessagingService.settleOutboxNudge(applicationContext, "OutboxRetryWorker")
                return Result.success()
            }
            OutboxRetry.Run.END_FOR_PAGE -> {
                // Processing here in parallel with the page's flusher would double-send. Ended, not
                // retried: the background edge enqueues the next request.
                Log.d(TAG, "doWork: app in front with $queued queued - the outbox is the page's, this request ends (the move to the background enqueues the next)")
                return Result.success()
            }
            OutboxRetry.Run.DRAIN -> Unit
        }

        val ctxRead = MlsContextLoader.readPushContext(applicationContext)
        val ctx = ctxRead.context
        if (ctx == null) {
            Log.e(TAG, "doWork: push_context.json ${ctxRead.verdict.describe()} with $queued queued - no retry can send them, the app must open")
            giveUp()
            return Result.failure()
        }

        Log.d(TAG, "doWork: drain run $runAttemptCount ($queued queued)")
        val service = CanariFirebaseMessagingService()
        val left = CanariFirebaseMessagingService.drainOutbox(applicationContext, service, ctx)
        return when (OutboxRetry.decide(left)) {
            OutboxRetry.Decision.DONE -> {
                Log.d(TAG, "doWork: outbox drained - success")
                Result.success()
            }
            OutboxRetry.Decision.RETRY -> {
                Log.d(TAG, "doWork: ${left.size} message(s) still queued, each can still go - retry")
                Result.retry()
            }
            OutboxRetry.Decision.GIVE_UP -> {
                val never = left.count { it == OutboxRetry.Prospect.NEVER }
                Log.e(TAG, "doWork: ${left.size} message(s) still queued, $never of them refused for good or unsendable from here - the app must open") // log-safe: two counts, no content
                giveUp()
                Result.failure()
            }
        }
    }

    /** The persistent failure state and the "open the app" nudge; the flag is reset by opening it. */
    private fun giveUp() {
        applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_FAILED, true).apply()
        CanariFirebaseMessagingService.showPendingSyncNotification(applicationContext)
    }
}
