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
 * while ANY of them is [Prospect.NOT_YET].
 *
 * AN ENTRY THAT CAN NEVER GO DOES NOT STRAND THE OTHERS (review of #3928): it is marked in the
 * mirror (`unsendable`), skipped by every later drain, told to the member (the nudge) and shown by
 * the page as failed with its Retry at the next open - never deleted. Only a [Prospect.BLOCKED]
 * drain - this DEVICE cannot send anything from here - ends the retry.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object OutboxRetry {

    /** Whether a later drain can send an entry a drain left. */
    enum class Prospect {
        /** No answer, a server fault, a capture, out of budget, a passing encrypt failure: a retry may send it. */
        NOT_YET,

        /**
         * THIS ENTRY will not go from here: the server refused the frame (a 4xx that is not a
         * "later"), its group is not held on this device or removed it, or it is malformed. Marked
         * and skipped from then on; the page shows it as failed.
         */
        NEVER,

        /**
         * NOTHING will go from this device's state: no push secret, no MLS state, or a key that
         * does not open it. Only the app, opened, can act on it.
         */
        BLOCKED;

        companion object {
            /**
             * The token the native batch classified a failure with (`SendProspect` in Rust):
             * `never` is [NEVER] for an entry and [BLOCKED] for a whole batch ([batch]); anything
             * else, `not-yet` included, is [NOT_YET].
             */
            fun of(token: String?, batch: Boolean = false): Prospect = when (token) {
                "never" -> if (batch) BLOCKED else NEVER
                else -> NOT_YET
            }
        }
    }

    /**
     * The 4xx statuses that say "later", not "never": a timeout, too early, too many. Every other
     * 4xx is the server's refusal of THIS frame or of this device's credential, and the same frame
     * sent again meets it again - except the typed ones [QueuedSendAnswer] reads first.
     */
    private val RETRYABLE_4XX = setOf(408, 425, 429)

    /** Whether a refused status [code] is final - see [RETRYABLE_4XX]. */
    fun isFinalRefusal(code: Int): Boolean = code in 400..499 && code !in RETRYABLE_4XX

    /** What a worker run does once it has looked at the queue. */
    enum class Run {
        /** No entry a drain could send: nothing owed, the request ends. */
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

    /** [sendable]: mirror entries not marked unsendable; [appInFront]: the activity is resumed. */
    fun run(sendable: Int, appInFront: Boolean): Run = when {
        sendable == 0 -> Run.NOTHING_OWED
        appInFront -> Run.END_FOR_PAGE
        else -> Run.DRAIN
    }

    /** What a drain's leftovers decide. */
    enum class Decision {
        /** Nothing left a retry could send: the request succeeds. */
        DONE,

        /** At least one entry left can still go: retry, under WorkManager's backoff. */
        RETRY,

        /** This device can send nothing from here: end, and ask the user to open the app. */
        GIVE_UP,
    }

    /** Decides from the [Prospect] of every entry a drain left. */
    fun decide(left: Collection<Prospect>): Decision = when {
        left.any { it == Prospect.BLOCKED } -> Decision.GIVE_UP
        left.any { it == Prospect.NOT_YET } -> Decision.RETRY
        else -> Decision.DONE
    }

    /** Whether the drain marked an entry that will never go - the member is then told (the nudge). */
    fun tells(left: Collection<Prospect>): Boolean = left.any { it == Prospect.NEVER }
}
