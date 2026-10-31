package fr.emse.canari

import fr.emse.canari.push.BackgroundWelcomeAnswer
import fr.emse.canari.push.BackgroundWelcomeAnswer.Applied
import fr.emse.canari.push.BackgroundWelcomeAnswer.Level
import fr.emse.canari.push.BackgroundWelcomeAnswer.Outcome
import fr.emse.canari.push.BackgroundWelcomeAnswer.Refusal
import fr.emse.canari.push.BackgroundWelcomeAnswer.SettleReport
import fr.emse.canari.push.BackgroundWelcomeAnswer.Settlement
import fr.emse.canari.push.BackgroundWelcomeAnswer.StagedWelcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The background Welcome's reading of its answer (docs/wiki/backlog.md, Mi 9T 2026-10-22): the
 * phone logged "Welcome sent" for `HTTP 201 {status: "rejected", reason: "epoch_mismatch"}`.
 */
class BackgroundWelcomeAnswerTest {

    @Test
    fun aRefusalAnsweredWith201IsARefusal() {
        // THE READING: the server of the time answered a refusal with 201.
        val outcome = BackgroundWelcomeAnswer.classify(201, "rejected", "epoch_mismatch", 3)
        assertEquals(Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3), outcome)
    }

    @Test
    fun theTypedRefusalIsReadTheSameWay() {
        assertEquals(
            Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3),
            BackgroundWelcomeAnswer.classify(409, "rejected", "epoch_mismatch", 3),
        )
        assertEquals(
            Outcome.Refused(Refusal.CONCURRENT_COMMIT, "concurrent_commit", 7),
            BackgroundWelcomeAnswer.classify(409, "rejected", "concurrent_commit", 7),
        )
        assertEquals(
            Outcome.Refused(Refusal.NOT_A_MEMBER, "not_a_member", null),
            BackgroundWelcomeAnswer.classify(409, "rejected", "not_a_member", null),
        )
        assertEquals(
            Outcome.Refused(Refusal.OTHER, "something_new", null),
            BackgroundWelcomeAnswer.classify(409, "rejected", "something_new", null),
        )
    }

    @Test
    fun onlyAnAcceptedBodyIsAnAcceptance() {
        assertEquals(Outcome.Accepted, BackgroundWelcomeAnswer.classify(201, "accepted", null, null))
        // The server before the typed answer said `done`.
        assertEquals(Outcome.Accepted, BackgroundWelcomeAnswer.classify(201, "done", null, null))
        // A 2xx that does not say what happened is not an acceptance.
        assertEquals(Outcome.Unknown(201), BackgroundWelcomeAnswer.classify(201, null, null, null))
    }

    @Test
    fun noAnswerAndServerErrorsAreUnknownAndClientErrorsAreFailures() {
        assertEquals(Outcome.Unknown(null), BackgroundWelcomeAnswer.classify(null, null, null, null))
        assertEquals(Outcome.Unknown(502), BackgroundWelcomeAnswer.classify(502, null, null, null))
        assertEquals(Outcome.Failed(400), BackgroundWelcomeAnswer.classify(400, null, null, null))
        // The body's size answers every wire copy alike.
        assertEquals(Outcome.Failed(413), BackgroundWelcomeAnswer.classify(413, null, null, null))
    }

    /**
     * Only 400 and 413 refuse the commit's bytes: any other untyped 4xx may answer a silent retry of a
     * request the server accepted, so the stage is left for the foreground's resubmission.
     */
    @Test
    fun anUntypedRefusalOutsideTheWhitelistLeavesTheStage() {
        // The request guards, and what an edge or a proxy may answer with no typed body.
        listOf(401, 403, 404, 405, 408, 409, 418, 429).forEach { code ->
            val outcome = BackgroundWelcomeAnswer.classify(code, null, null, null)
            assertEquals("$code", Outcome.Unknown(code), outcome)
            assertEquals("$code", Settlement.Leave, BackgroundWelcomeAnswer.settle(outcome, 1))
        }
    }

    @Test
    fun anAcceptanceMergesARefusalClearsAndNoAnswerLeavesTheStage() {
        assertEquals(Settlement.Merge, BackgroundWelcomeAnswer.settle(Outcome.Accepted, 1))
        listOf(
            Outcome.Refused(Refusal.NOT_A_MEMBER, "not_a_member", null),
            Outcome.Refused(Refusal.OTHER, "x", null),
            Outcome.Failed(400),
        ).forEach { outcome ->
            assertEquals("$outcome", Settlement.Clear(null, null), BackgroundWelcomeAnswer.settle(outcome, 1))
        }
        // An answer nobody read may have been an acceptance: neither guess is made here.
        listOf(Outcome.Unknown(null), Outcome.Unknown(503)).forEach { outcome ->
            assertEquals("$outcome", Settlement.Leave, BackgroundWelcomeAnswer.settle(outcome, 1))
        }
        // The lock a `concurrent_commit` reports may be this commit's own first copy (a silent
        // retry of the POST): not a refusal of these bytes, so the stage is left too.
        assertEquals(
            Settlement.Leave,
            BackgroundWelcomeAnswer.settle(Outcome.Refused(Refusal.CONCURRENT_COMMIT, "concurrent_commit", 1), 1),
        )
    }

    @Test
    fun aStaleRefusalIsRecordedWithBothEpochs() {
        assertEquals(
            Settlement.Clear(1, 3),
            BackgroundWelcomeAnswer.settle(Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3), 1),
        )
        // Without the server's epoch there is nothing to record.
        assertEquals(
            Settlement.Clear(null, null),
            BackgroundWelcomeAnswer.settle(Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", null), 1),
        )
    }

    /**
     * A LINK'S ASK IS NEVER ANSWERED BY A PUSH (2026-10-31): the server refuses a target whose seat
     * awaits a member's admission, and the phone clears its stage and records the target, so the
     * requester's re-ask every 60 s is not answered again from the same mls.bin.
     */
    @Test
    fun aSeatAwaitingAdmissionClearsTheStageAndRecordsTheTarget() {
        val outcome = BackgroundWelcomeAnswer.classify(409, "rejected", "awaiting_admission", null)
        assertEquals(Outcome.Refused(Refusal.AWAITING_ADMISSION, "awaiting_admission", null), outcome)
        assertEquals(Settlement.Clear(null, null, targetRefused = true), BackgroundWelcomeAnswer.settle(outcome, 1))

        val staged = FakeStaged(report = SettleReport(ok = true, reason = null))
        assertEquals(Applied.Cleared, BackgroundWelcomeAnswer.apply(BackgroundWelcomeAnswer.settle(outcome, 1), staged))
        assertEquals(listOf("clear(target)"), staged.calls)
        val line = BackgroundWelcomeAnswer.describe(outcome, 1)
        assertTrue(line, line.startsWith("REFUSED awaiting_admission"))
    }

    /** The ordinary refusals of the native prepare are said quietly; anything else accuses. */
    @Test
    fun onlyAnUnexpectedPrepareRefusalIsAWarning() {
        listOf("newcomer", "foreground-active", "warm-process", "commit-pending").forEach { token ->
            assertEquals(token, Level.DEBUG, BackgroundWelcomeAnswer.prepareRefusalLevel(token))
        }
        listOf("identity-mismatch", "state-unreadable", "add-failed", "something-new", null).forEach { token ->
            assertEquals("$token", Level.WARN, BackgroundWelcomeAnswer.prepareRefusalLevel(token))
        }
    }

    @Test
    fun theLogLineNeverSaysSentForARefusal() {
        val line = BackgroundWelcomeAnswer.describe(
            Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3), 1,
        )
        assertTrue(line, line.startsWith("REFUSED epoch_mismatch"))
        assertTrue(line, !line.contains("sent"))
    }

    /** The staged Add as the service drives it, recording what was asked of it. */
    private class FakeStaged(private val report: SettleReport?) : StagedWelcome {
        val calls = mutableListOf<String>()
        override fun merge(): SettleReport? {
            calls += "merge"
            return report
        }
        override fun clear(staleBase: Long?, serverEpoch: Long?, targetRefused: Boolean): SettleReport? {
            calls += if (targetRefused) "clear(target)" else "clear($staleBase,$serverEpoch)"
            return report
        }
    }

    @Test
    fun noAnswerCallsNothingAndLeavesTheStageToTheForeground() {
        val staged = FakeStaged(report = SettleReport(ok = true, reason = null))

        val applied = BackgroundWelcomeAnswer.apply(BackgroundWelcomeAnswer.settle(Outcome.Unknown(null), 1), staged)

        assertEquals(Applied.Left("no definitive answer"), applied)
        assertEquals(emptyList<String>(), staged.calls)
        val (level, line) = BackgroundWelcomeAnswer.report(applied)
        assertEquals(Level.WARN, level)
        assertTrue(line, line.contains("foreground"))
    }

    @Test
    fun anAcceptanceWhoseMergeFindsTheLockBusyLeavesTheStageAndDeletesNothing() {
        val staged = FakeStaged(report = null)

        val applied = BackgroundWelcomeAnswer.apply(Settlement.Merge, staged)

        assertEquals(Applied.Left("lock busy"), applied)
        assertEquals(listOf("merge"), staged.calls)
        assertEquals(Level.WARN, BackgroundWelcomeAnswer.report(applied).first)
    }

    @Test
    fun anAcceptanceMerges() {
        val staged = FakeStaged(report = SettleReport(ok = true, reason = null))

        val applied = BackgroundWelcomeAnswer.apply(Settlement.Merge, staged)

        assertEquals(Applied.Merged, applied)
        assertEquals(listOf("merge"), staged.calls)
        assertEquals(Level.DEBUG, BackgroundWelcomeAnswer.report(applied).first)
    }

    @Test
    fun theNativeTokensAreReadAsTheirTypes() {
        assertEquals(
            Applied.AlreadySettled,
            BackgroundWelcomeAnswer.apply(Settlement.Merge, FakeStaged(SettleReport(false, "already-settled"))),
        )
        assertEquals(
            Applied.Left("left-to-foreground"),
            BackgroundWelcomeAnswer.apply(Settlement.Merge, FakeStaged(SettleReport(false, "left-to-foreground"))),
        )
        // The one error: the server holds a commit mls.bin no longer stages.
        val lost = BackgroundWelcomeAnswer.apply(Settlement.Merge, FakeStaged(SettleReport(false, "accepted-not-held")))
        assertEquals(Applied.NotHeld, lost)
        val (level, line) = BackgroundWelcomeAnswer.report(lost)
        assertEquals(Level.ERROR, level)
        assertTrue(line, line.contains("ACCEPTED AND NOT HELD"))
    }

    @Test
    fun aClearNeverMergesAndCarriesTheStaleEpochs() {
        val staged = FakeStaged(report = SettleReport(ok = true, reason = null))
        val refused = Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3)

        val applied = BackgroundWelcomeAnswer.apply(BackgroundWelcomeAnswer.settle(refused, 1), staged)

        assertEquals(Applied.Cleared, applied)
        assertEquals(listOf("clear(1,3)"), staged.calls)
        assertEquals(Level.WARN, BackgroundWelcomeAnswer.report(applied).first)
    }

    @Test
    fun aRefusedTargetIsRememberedForThatTargetAndNothingElse() {
        // A holder answering the same target from the same mls.bin would commit and be refused again
        // on each of the newcomer's asks.
        listOf("welcome_target_unknown", "welcome_target_not_member").forEach { token ->
            val refused = BackgroundWelcomeAnswer.classify(409, "rejected", token, 7)
            assertTrue("$refused", refused is Outcome.Refused && refused.reason != Refusal.OTHER)
            assertEquals(Settlement.Clear(null, null, targetRefused = true), BackgroundWelcomeAnswer.settle(refused, 7))

            val staged = FakeStaged(report = SettleReport(ok = true, reason = null))
            assertEquals(Applied.Cleared, BackgroundWelcomeAnswer.apply(BackgroundWelcomeAnswer.settle(refused, 7), staged))
            assertEquals(listOf("clear(target)"), staged.calls)
        }
    }
}
