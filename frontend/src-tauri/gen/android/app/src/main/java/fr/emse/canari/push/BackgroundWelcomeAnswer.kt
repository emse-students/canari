package fr.emse.canari.push

/**
 * WHAT `POST /api/mls/push/send-welcome-and-commit` ANSWERED, AND WHAT THE PHONE DOES ABOUT IT.
 *
 * The background Welcome stages its post-add state and installs it only once the server ACCEPTS the
 * commit; every other answer discards it. This used to read `HTTP 201` as "Welcome sent" - and the
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
        /** Another commit held the group's lock: says nothing about the next request. */
        CONCURRENT_COMMIT("concurrent_commit"),
        /** The target was removed from the group: no Welcome is owed. */
        NOT_A_MEMBER("not_a_member"),
        /** A token this build was not taught - said, and settled like a refusal. */
        OTHER("other");

        companion object {
            fun of(token: String?): Refusal = entries.firstOrNull { it.token == token } ?: OTHER
        }
    }

    /** The classified answer. */
    sealed class Outcome {
        /**
         * The commit passed the gate, and its Welcome was stored in the same transaction: install the
         * staged state.
         */
        object Accepted : Outcome()

        /** The gate refused: nothing was recorded, fanned out or sent. */
        data class Refused(val reason: Refusal, val token: String?, val serverEpoch: Long?) : Outcome()

        /** A 4xx with no typed refusal (malformed body, bad secret, an old native caller): not accepted. */
        data class Failed(val httpCode: Int) : Outcome()

        /**
         * No answer was read (a transport failure, a 5xx): the server MAY have accepted. Not installed,
         * because installing on a refusal is the fork this whole path exists to prevent.
         */
        data class Unknown(val httpCode: Int?) : Outcome()
    }

    /** What to do with the staged state. */
    sealed class Settlement {
        object Install : Settlement()

        /** Discard it; [staleBase] and [serverEpoch] are set only for an `epoch_mismatch`. */
        data class Discard(val staleBase: Long?, val serverEpoch: Long?) : Settlement()
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
        return if (httpCode in 400..499) Outcome.Failed(httpCode) else Outcome.Unknown(httpCode)
    }

    /**
     * What the staged state becomes. Only [Outcome.Accepted] installs; a stale refusal is recorded so
     * the same bytes are not offered again - the newcomer re-asks every 60 s while its app is open,
     * and a phone that answered each ask would be refused each time. Nothing here retries: the
     * foreground replays the group's commits at its next start, and answers from there.
     *
     * @param baseEpoch the epoch the staged commit was built on
     */
    fun settle(outcome: Outcome, baseEpoch: Long): Settlement = when (outcome) {
        Outcome.Accepted -> Settlement.Install
        is Outcome.Refused ->
            if (outcome.reason == Refusal.EPOCH_MISMATCH && outcome.serverEpoch != null && baseEpoch >= 0) {
                Settlement.Discard(baseEpoch, outcome.serverEpoch)
            } else {
                Settlement.Discard(null, null)
            }
        is Outcome.Failed, is Outcome.Unknown -> Settlement.Discard(null, null)
    }

    /** What the native install reported, read from its JSON. */
    data class InstallReport(val ok: Boolean, val reason: String?, val error: String?)

    /**
     * The staged post-add state, as the service holds it: the seam a JVM test drives in place of the
     * JNI and the MLS state lock.
     */
    interface StagedWelcome {
        /**
         * Installs the staged state under the MLS state lock. `null` when the lock was not acquired,
         * so the install never ran and the staged file is still on disk.
         */
        fun install(): InstallReport?

        /** Deletes the staged file; records a stale base only when both epochs are given. */
        fun discard(staleBase: Long?, serverEpoch: Long?)
    }

    /** What became of the staged state once its settlement was applied. */
    sealed class Applied {
        object Installed : Applied()

        /** The native install ran and refused; it removed its own staged file. */
        data class NotInstalled(val reason: String?, val error: String?) : Applied()

        /** The MLS state lock was busy: the install never ran, and the staged file was deleted here. */
        object LockBusy : Applied()

        object Discarded : Applied()
    }

    /** The level a line is logged at, so the decision is tested here and only printed by the service. */
    enum class Level { DEBUG, WARN, ERROR }

    /**
     * Applies a settlement to the staged state. A busy lock on an install is the one case the
     * staged file would outlive the attempt - it holds the group's old epoch secret - so it is
     * deleted here, never left for a later attempt to find.
     */
    fun apply(settlement: Settlement, staged: StagedWelcome): Applied = when (settlement) {
        Settlement.Install -> {
            val report = staged.install()
            when {
                report == null -> {
                    staged.discard(null, null)
                    Applied.LockBusy
                }
                report.ok -> Applied.Installed
                else -> Applied.NotInstalled(report.reason, report.error)
            }
        }
        is Settlement.Discard -> {
            staged.discard(settlement.staleBase, settlement.serverEpoch)
            Applied.Discarded
        }
    }

    /**
     * The level and suffix of the line that ends a background Welcome. An acceptance not installed
     * is an error: the server holds a commit this device does not, and the foreground's replay meets
     * it and recovers through the usual ladder. An answer nobody read may have been an acceptance.
     */
    fun report(applied: Applied, outcome: Outcome): Pair<Level, String> = when (applied) {
        Applied.Installed -> Level.DEBUG to "state installed"
        Applied.LockBusy -> Level.ERROR to
            "ACCEPTED AND NOT INSTALLED reason=lock busy - the staged file was deleted"
        is Applied.NotInstalled -> Level.ERROR to
            "ACCEPTED AND NOT INSTALLED reason=${applied.reason} ${applied.error ?: ""}".trimEnd()
        Applied.Discarded ->
            (if (outcome is Outcome.Unknown) Level.ERROR else Level.WARN) to "staged state discarded"
    }

    /** The one line the phone logs for an answer, naming what happened. */
    fun describe(outcome: Outcome, baseEpoch: Long): String = when (outcome) {
        Outcome.Accepted -> "accepted at base $baseEpoch - Welcome sent"
        is Outcome.Refused -> when (outcome.reason) {
            Refusal.EPOCH_MISMATCH ->
                "REFUSED epoch_mismatch: built on base $baseEpoch, the group is at ${outcome.serverEpoch} - " +
                    "this phone answered from a state the group left; nothing installed, left to the foreground"
            Refusal.CONCURRENT_COMMIT -> "REFUSED concurrent_commit - another commit won the lock; nothing installed"
            Refusal.NOT_A_MEMBER -> "REFUSED not_a_member - the target was removed; nothing installed"
            Refusal.OTHER -> "REFUSED ${outcome.token} - nothing installed"
        }
        is Outcome.Failed -> "FAILED HTTP ${outcome.httpCode} - not accepted, nothing installed"
        is Outcome.Unknown ->
            "OUTCOME UNKNOWN (HTTP ${outcome.httpCode ?: "none"}) - the server may have accepted; nothing installed"
    }
}
