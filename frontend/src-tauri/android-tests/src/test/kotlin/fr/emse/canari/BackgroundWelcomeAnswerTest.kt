package fr.emse.canari

import fr.emse.canari.push.BackgroundWelcomeAnswer
import fr.emse.canari.push.BackgroundWelcomeAnswer.Outcome
import fr.emse.canari.push.BackgroundWelcomeAnswer.Refusal
import fr.emse.canari.push.BackgroundWelcomeAnswer.Settlement
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
        assertEquals(Outcome.Failed(403), BackgroundWelcomeAnswer.classify(403, null, null, null))
    }

    @Test
    fun onlyAnAcceptanceInstalls() {
        assertEquals(Settlement.Install, BackgroundWelcomeAnswer.settle(Outcome.Accepted, 1))
        listOf(
            Outcome.Refused(Refusal.CONCURRENT_COMMIT, "concurrent_commit", 1),
            Outcome.Refused(Refusal.NOT_A_MEMBER, "not_a_member", null),
            Outcome.Refused(Refusal.OTHER, "x", null),
            Outcome.Failed(400),
            Outcome.Unknown(null),
            Outcome.Unknown(503),
        ).forEach { outcome ->
            assertEquals("$outcome", Settlement.Discard(null, null), BackgroundWelcomeAnswer.settle(outcome, 1))
        }
    }

    @Test
    fun aStaleRefusalIsRecordedWithBothEpochs() {
        assertEquals(
            Settlement.Discard(1, 3),
            BackgroundWelcomeAnswer.settle(Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3), 1),
        )
        // Without the server's epoch there is nothing to record.
        assertEquals(
            Settlement.Discard(null, null),
            BackgroundWelcomeAnswer.settle(Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", null), 1),
        )
    }

    @Test
    fun theLogLineNeverSaysSentForARefusal() {
        val line = BackgroundWelcomeAnswer.describe(
            Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3), 1,
        )
        assertTrue(line, line.startsWith("REFUSED epoch_mismatch"))
        assertTrue(line, !line.contains("sent"))
    }
}
