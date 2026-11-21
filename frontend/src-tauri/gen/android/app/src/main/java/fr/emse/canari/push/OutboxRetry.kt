package fr.emse.canari.push

/**
 * WHEN THE BACKGROUND OUTBOX RETRY ENDS: on durable state saying a retry cannot succeed, never on a
 * count of attempts.
 *
 * `OutboxRetryWorker` used to give up after three real drains. With WorkManager's backoff from 30 s
 * that is about three and a half minutes, so a backend down for a few minutes while the phone was
 * online spent every attempt, and a reply queued in the outbox then waited for the user to open the
 * app (#3912 review, round 11). A count answers "how long have we tried"; the decision needs "can a
 * retry ever succeed". So the drain says WHY each entry it leaves remains ([Prospect]), classified
 * where it is known, and the worker retries - with no cap, WorkManager's backoff bounding the cost -
 * while every one of them is [Prospect.NOT_YET].
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object OutboxRetry {

    /** Whether a later drain can send an entry a drain left. */
    enum class Prospect {
        /** No answer, a server fault, a capture, out of budget, not encryptable yet: a retry may send it. */
        NOT_YET,

        /**
         * Durable state says no retry from here will send it: the server refused the frame (a 4xx
         * that is not a "later"), or this device holds no push secret or no MLS state to send with.
         * Only the app, opened, can act on it.
         */
        NEVER,
    }

    /**
     * The 4xx statuses that say "later", not "never": a timeout, too early, too many. Every other
     * 4xx is the server's refusal of THIS frame or of this device's credential, and the same frame
     * sent again meets it again.
     */
    private val RETRYABLE_4XX = setOf(408, 425, 429)

    /** Whether a refused status [code] is final - see [RETRYABLE_4XX]. */
    fun isFinalRefusal(code: Int): Boolean = code in 400..499 && code !in RETRYABLE_4XX

    /** What a worker run does once it has looked at the queue. */
    enum class Run {
        /** The mirror is empty: nothing owed, the request ends. */
        NOTHING_OWED,

        /**
         * The app is in front: the outbox is the page's while it is visible, so this request ENDS
         * (not an attempt, and no `Result.retry()` that would grow the backoff of a chain the next
         * request is appended behind). The app's move to the background enqueues a fresh one.
         */
        END_FOR_PAGE,

        /** Drain now. */
        DRAIN,
    }

    /** [queued]: entries in the mirror; [appInFront]: the activity is resumed. */
    fun run(queued: Int, appInFront: Boolean): Run = when {
        queued == 0 -> Run.NOTHING_OWED
        appInFront -> Run.END_FOR_PAGE
        else -> Run.DRAIN
    }

    /** What a drain's leftovers decide. */
    enum class Decision {
        /** Nothing left: the request succeeds. */
        DONE,

        /** Every entry left can still go: retry, under WorkManager's backoff. */
        RETRY,

        /** At least one entry can never go from here: end, and ask the user to open the app. */
        GIVE_UP,
    }

    /** Decides from the [Prospect] of every entry a drain left. */
    fun decide(left: Collection<Prospect>): Decision = when {
        left.isEmpty() -> Decision.DONE
        left.any { it == Prospect.NEVER } -> Decision.GIVE_UP
        else -> Decision.RETRY
    }
}
