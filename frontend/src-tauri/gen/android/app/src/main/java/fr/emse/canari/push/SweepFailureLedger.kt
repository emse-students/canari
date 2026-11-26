package fr.emse.canari.push

/**
 * WHEN `MlsBackgroundWorker` TELLS THE MEMBER TO OPEN THE APP: on a durable count of consecutive
 * REAL failures of the pending-DB sweep, never on WorkManager's `runAttemptCount` (2026-11-26).
 *
 * The worker used to raise "Synchronisation en attente" once `runAttemptCount` reached 3. That
 * column counts every `Result.retry()`, and the worker returned retry for runs that had failed at
 * nothing: the app in front (a deferral to the foreground engine), `MlsStateLock` held 15 s by a
 * push decrypting (contention). Three of those in a row - about seventy seconds of backoff with the
 * app open - drew the notice right under a correctly decrypted message, and set the flag that holds
 * back every later enqueue until the next `onResume`. A count of runs answers "how many times did I
 * run"; the notice needs "is the sweep broken" (`durable-rules.md`, a column is only evidence for
 * the question it was written to answer).
 *
 * Neither deferral guarded anything the work reads: the sweep (`background.rs` `cleanup_pending_db`)
 * touches `mls_pending.db` alone, through SQLite's own locking, never `mls.bin` - so both are gone,
 * not reclassified. The worker types each run's outcome where it is known ([Outcome]), and this
 * ledger alone turns a run of them into a decision. The count lives in the worker's prefs, so it survives the work
 * request: three failures across three pushes are three failures. It resets on a sweep that
 * succeeds and when the app is opened (`MlsBackgroundWorker.resetFailureFlag`).
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object SweepFailureLedger {

    /** Consecutive real failures that raise the notice and stop the retries. */
    const val GIVE_UP_AFTER = 3

    /** What one run of the sweep did, typed where it happened. */
    sealed interface Outcome {
        /** `cleanup_pending_db` returned Ok: nothing is owed until the next refused frame. */
        object Swept : Outcome

        /**
         * The sweep could not run or did not finish: the native call answered false, the native
         * library is not loaded, or it threw. [cause] is a fixed word for the log, never a value.
         */
        data class Failed(val cause: String) : Outcome
    }

    /** What the worker answers WorkManager after a run. */
    enum class Verdict {
        /** The work is done - `Result.success()`. */
        DONE,

        /** A real failure under the threshold - `Result.retry()`, WorkManager's backoff bounding it. */
        RETRY,

        /** The threshold is reached - notice, persistent flag, `Result.failure()`. */
        GIVE_UP,
    }

    /**
     * The count to persist after a run, and what to answer. The notice is raised by the run that
     * REACHES the threshold only: a request already queued when the streak gave up still runs, and
     * its failure must not post the notice a second time.
     */
    data class Decision(val consecutiveFailures: Int, val verdict: Verdict) {
        /** True for the one run whose failure completes the streak. */
        val raisesNotice: Boolean get() = consecutiveFailures == GIVE_UP_AFTER
    }

    /** Folds one run's [outcome] onto the persisted streak of [consecutiveFailures]. */
    fun next(consecutiveFailures: Int, outcome: Outcome): Decision = when (outcome) {
        Outcome.Swept -> Decision(0, Verdict.DONE)
        is Outcome.Failed -> {
            val streak = consecutiveFailures.coerceAtLeast(0) + 1
            Decision(streak, if (streak >= GIVE_UP_AFTER) Verdict.GIVE_UP else Verdict.RETRY)
        }
    }
}
