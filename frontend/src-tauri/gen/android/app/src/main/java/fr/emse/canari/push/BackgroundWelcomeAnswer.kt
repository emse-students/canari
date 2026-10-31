package fr.emse.canari.push

/**
 * WHAT `POST /api/mls/push/send-welcome-and-commit` ANSWERED, AND WHAT THE PHONE DOES ABOUT IT.
 *
 * The background Welcome stages its Add in mls.bin, with the record of its submission, before the
 * commit leaves. A definitive answer settles it here - merged on acceptance, cleared on a refusal; an
 * answer nobody read settles nothing, and the foreground settles the stage against the server at its
 * next load, as it settles its own commits. This used to read `HTTP 201` as "Welcome sent" - and the
 * route answered 201 for a refusal too, so a phone answering from a stale epoch logged a success
 * for a Welcome the server had refused (Mi 9T, 2026-10-22, docs/wiki/backlog.md).
 *
 * **THE BODY'S `status` DECIDES, NEVER ITS PROSE, AND THE STATUS CODE ONLY WHEN THERE IS NO BODY.**
 * A server from before the typed answer says `201 {status: "rejected", reason}` for a refusal and
 * `201 {status: "done"}` for an acceptance; the current one says `409 {status: "rejected"}` and
 * `201 {status: "accepted"}`. Both are read the same way here, so the phone is right against either.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object BackgroundWelcomeAnswer {

    /** Why the gate refused, as the token it sent. */
    enum class Refusal(val token: String) {
        /** The phone's base is not the group's epoch: it answered from a state the group left. */
        EPOCH_MISMATCH("epoch_mismatch"),
        /**
         * Another commit held the group's lock - possibly THIS commit's own first copy, when the
         * request read is a silent retry: says nothing about these bytes, so the stage is left.
         */
        CONCURRENT_COMMIT("concurrent_commit"),
        /** The target was removed from the group: no Welcome is owed. */
        NOT_A_MEMBER("not_a_member"),
        /**
         * The target's seat is an invitation link's ask: only a member's own Accept admits it, never
         * a push (2026-10-31). A refusal of this target, not of the bytes' epoch.
         */
        AWAITING_ADMISSION("awaiting_admission"),
        /** No device is registered under the Welcome's target. */
        WELCOME_TARGET_UNKNOWN("welcome_target_unknown"),
        /** The Welcome's target is not on the roster, or not entitled to the key group. */
        WELCOME_TARGET_NOT_MEMBER("welcome_target_not_member"),
        /** A token this build was not taught - said, and settled like a refusal. */
        OTHER("other");

        companion object {
            fun of(token: String?): Refusal = entries.firstOrNull { it.token == token } ?: OTHER
        }
    }

    /** The classified answer. */
    sealed class Outcome {
        /**
         * The commit passed the gate, and its Welcome was stored in the same transaction: merge the
         * staged Add.
         */
        object Accepted : Outcome()

        /** The gate refused: nothing was recorded, fanned out or sent. */
        data class Refused(val reason: Refusal, val token: String?, val serverEpoch: Long?) : Outcome()

        /** An untyped 4xx that answers the commit's bytes ([BYTES_REFUSALS]: a malformed body, an old native caller): not accepted. */
        data class Failed(val httpCode: Int) : Outcome()

        /**
         * No answer about THESE BYTES was read (a transport failure, a 5xx, or any untyped 4xx outside
         * [BYTES_REFUSALS]): the server MAY have accepted. Nothing is
         * settled here - guessing either way is the fork this path exists to prevent.
         */
        data class Unknown(val httpCode: Int?) : Outcome()
    }

    /** What becomes of the Add staged in mls.bin. */
    sealed class Settlement {
        object Merge : Settlement()

        /**
         * Clear it. [staleBase] and [serverEpoch] are set only for an `epoch_mismatch`, recorded for
         * the group; [targetRefused] only for a refused target, recorded for that target alone - both
         * against the mls.bin the clear writes, so the same bytes do not answer again.
         */
        data class Clear(
            val staleBase: Long?,
            val serverEpoch: Long?,
            val targetRefused: Boolean = false,
        ) : Settlement()

        /** No answer was read: the stage stays in mls.bin, for the foreground to settle. */
        object Leave : Settlement()
    }

    /**
     * Classifies one answer.
     *
     * @param httpCode the status code, `null` when no response was read at all
     * @param status the body's `status` field, `null` when absent or unreadable
     * @param reason the body's `reason` field
     * @param currentEpoch the body's `currentEpoch` field
     */
    fun classify(httpCode: Int?, status: String?, reason: String?, currentEpoch: Long?): Outcome {
        if (httpCode == null) return Outcome.Unknown(null)
        if (status == "rejected") return Outcome.Refused(Refusal.of(reason), reason, currentEpoch)
        if (httpCode in 200..299) {
            return if (status == "accepted" || status == "done") Outcome.Accepted else Outcome.Unknown(httpCode)
        }
        return if (httpCode in BYTES_REFUSALS) Outcome.Failed(httpCode) else Outcome.Unknown(httpCode)
    }

    /**
     * The ONLY untyped 4xx that clear the stage - A WHITELIST: each refuses the commit's BYTES, so it
     * answers every wire copy of the request alike. 400 is the route's validation of the body. 413 is
     * the body's size, identical for both copies of a retried POST, so it refuses the first one too.
     *
     * **THE FIRST REQUEST IN CODE CAN BE THE SECOND ON THE WIRE.** `HttpURLConnection` silently
     * retries a POST that failed on a reused keep-alive connection, so the request whose answer is
     * read here may be a copy of one the server already accepted. Any other 4xx - 401/403 from the
     * push-secret guard, 408, 429 from the throttler, a 404/405/409 from an edge or a proxy - says
     * nothing of that earlier copy, so the stage is LEFT, and the foreground's resubmission through
     * the session route reads `duplicate` or a typed refusal - the resubmission rule of
     * `refusesOnlyThisRequest` (`src/lib/mls-client/commitSubmission.ts`). A typed `rejected` body
     * is read before this, by its token.
     */
    val BYTES_REFUSALS = setOf(400, 413)

    /**
     * What the staged Add becomes. An acceptance merges it, a refusal clears it - and a stale refusal
     * is recorded so the same bytes are not offered again: the newcomer re-asks every 60 s while its
     * app is open, and a phone that answered each ask would be refused each time. An answer nobody
     * read leaves it, settled by the foreground's resubmission of the same bytes. Nothing here retries.
     *
     * @param baseEpoch the epoch the staged commit was built on
     */
    fun settle(outcome: Outcome, baseEpoch: Long): Settlement = when (outcome) {
        Outcome.Accepted -> Settlement.Merge
        is Outcome.Refused -> when {
            // NOT A REFUSAL OF THESE BYTES: the lock it reports may be held by this commit's own
            // first copy (a silent `HttpURLConnection` retry), which may still land - the client's
            // resubmission rule (`resubmissionVerdict`, `commitSubmission.ts`) reads it the same way.
            // The group then answers `commit-pending` until the foreground settles the stage.
            outcome.reason == Refusal.CONCURRENT_COMMIT -> Settlement.Leave
            outcome.reason == Refusal.EPOCH_MISMATCH && outcome.serverEpoch != null && baseEpoch >= 0 ->
                Settlement.Clear(baseEpoch, outcome.serverEpoch)
            // The requester re-asks every 60 s while it waits for a member's Accept: the same bytes
            // are not offered for it again (`target-refused-known`).
            outcome.reason == Refusal.WELCOME_TARGET_UNKNOWN ||
                outcome.reason == Refusal.WELCOME_TARGET_NOT_MEMBER ||
                outcome.reason == Refusal.AWAITING_ADMISSION ->
                Settlement.Clear(null, null, targetRefused = true)
            else -> Settlement.Clear(null, null)
        }
        is Outcome.Failed -> Settlement.Clear(null, null)
        is Outcome.Unknown -> Settlement.Leave
    }

    /** What the native settlement reported, read from its JSON: `reason` is a token, never prose. */
    data class SettleReport(val ok: Boolean, val reason: String?)

    /**
     * The Add staged in mls.bin, as the service holds it: the seam a JVM test drives in place of the
     * JNI and the MLS state lock. Each call returns `null` when the lock was not acquired, so nothing
     * ran and the stage is still in mls.bin.
     */
    interface StagedWelcome {
        fun merge(): SettleReport?

        fun clear(staleBase: Long?, serverEpoch: Long?, targetRefused: Boolean): SettleReport?
    }

    /** What became of the staged Add once its settlement was applied. */
    sealed class Applied {
        object Merged : Applied()

        object Cleared : Applied()

        /** The foreground settled it before this answer was applied. */
        object AlreadySettled : Applied()

        /** Nothing was settled here: the stage is in mls.bin, for the foreground's resubmission. */
        data class Left(val why: String) : Applied()

        /** Accepted, and mls.bin holds neither the stage nor the epoch it creates. */
        object NotHeld : Applied()
    }

    /** The level a line is logged at, so the decision is tested here and only printed by the service. */
    enum class Level { DEBUG, WARN, ERROR }

    /**
     * The refusals of the native prepare (`prepare_welcome_background_with_key`, `background.rs`)
     * that are the ORDINARY course of a push, not a fault: a new person, whom only a member's gesture
     * admits, and the three ways the state is someone else's right now. Every member's phone meets
     * them on every re-ask (about one a minute per group), so they are said quietly.
     */
    private val EXPECTED_PREPARE_REFUSALS =
        setOf("newcomer", "foreground-active", "warm-process", "commit-pending")

    /**
     * The level a refusal of the native prepare is logged at: [Level.DEBUG] for an
     * [EXPECTED_PREPARE_REFUSALS] token, [Level.WARN] for any other - a refused key package, an
     * unreadable state, a token this build was not taught.
     *
     * THE ONE OWNER OF THAT LINE AND OF THIS SET: the Rust prepare says its refusal at debug only
     * (`welcome_refused`, `background.rs`), since its log reaches no logger in a killed app.
     */
    fun prepareRefusalLevel(token: String?): Level =
        if (token in EXPECTED_PREPARE_REFUSALS) Level.DEBUG else Level.WARN

    private const val ALREADY_SETTLED = "already-settled"
    private const val ACCEPTED_NOT_HELD = "accepted-not-held"

    /**
     * Applies a settlement to the staged Add. A busy lock, or a native refusal to write, leaves the
     * stage where it is: it is in mls.bin with its record, which is everything the foreground needs.
     */
    fun apply(settlement: Settlement, staged: StagedWelcome): Applied {
        val (report, done) = when (settlement) {
            Settlement.Leave -> return Applied.Left("no definitive answer")
            Settlement.Merge -> staged.merge() to Applied.Merged
            is Settlement.Clear ->
                staged.clear(settlement.staleBase, settlement.serverEpoch, settlement.targetRefused) to Applied.Cleared
        }
        return when {
            report == null -> Applied.Left("lock busy")
            report.ok -> done
            report.reason == ALREADY_SETTLED -> Applied.AlreadySettled
            report.reason == ACCEPTED_NOT_HELD -> Applied.NotHeld
            else -> Applied.Left(report.reason ?: "unspecified")
        }
    }

    /**
     * The level and suffix of the line that ends a background Welcome. Only an acceptance mls.bin no
     * longer holds is an error: the server holds a commit this device does not, and the foreground's
     * replay meets it and recovers through the usual ladder.
     */
    fun report(applied: Applied): Pair<Level, String> = when (applied) {
        Applied.Merged -> Level.DEBUG to "staged Add merged"
        Applied.Cleared -> Level.WARN to "staged Add cleared"
        Applied.AlreadySettled -> Level.DEBUG to "already settled by the foreground"
        is Applied.Left -> Level.WARN to
            "stage left in mls.bin (${applied.why}) - the foreground settles it against the server at its next load"
        Applied.NotHeld -> Level.ERROR to
            "ACCEPTED AND NOT HELD - mls.bin no longer holds the staged Add; the foreground's replay recovers"
    }

    /** The one line the phone logs for an answer, naming what happened. */
    fun describe(outcome: Outcome, baseEpoch: Long): String = when (outcome) {
        Outcome.Accepted -> "accepted at base $baseEpoch - Welcome sent"
        is Outcome.Refused -> when (outcome.reason) {
            Refusal.EPOCH_MISMATCH ->
                "REFUSED epoch_mismatch: built on base $baseEpoch, the group is at ${outcome.serverEpoch} - " +
                    "this phone answered from a state the group left; the Add is cleared, left to the foreground"
            Refusal.CONCURRENT_COMMIT ->
                "REFUSED concurrent_commit - the lock may be this commit's own first copy; the Add is left to the foreground"
            Refusal.NOT_A_MEMBER -> "REFUSED not_a_member - the target was removed; the Add is cleared"
            Refusal.AWAITING_ADMISSION ->
                "REFUSED awaiting_admission - the target's seat is a link's ask, answered only by a member; " +
                    "the Add is cleared, not answered again from this mls.bin"
            Refusal.WELCOME_TARGET_UNKNOWN, Refusal.WELCOME_TARGET_NOT_MEMBER ->
                "REFUSED ${outcome.token} - the server does not admit this target; the Add is cleared, " +
                    "not answered again from this mls.bin"
            Refusal.OTHER -> "REFUSED ${outcome.token} - the Add is cleared"
        }
        is Outcome.Failed -> "FAILED HTTP ${outcome.httpCode} - not accepted, the Add is cleared"
        is Outcome.Unknown ->
            "OUTCOME UNKNOWN (HTTP ${outcome.httpCode ?: "none"}) - the server may have accepted; the Add stays " +
                "staged in mls.bin for the foreground"
    }
}
