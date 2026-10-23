package fr.emse.canari

import fr.emse.canari.push.BackgroundWelcomeAnswer
import fr.emse.canari.push.BackgroundWelcomeAnswer.Applied
import fr.emse.canari.push.BackgroundWelcomeAnswer.InstallReport
import fr.emse.canari.push.BackgroundWelcomeAnswer.Level
import fr.emse.canari.push.BackgroundWelcomeAnswer.Outcome
import fr.emse.canari.push.BackgroundWelcomeAnswer.Refusal
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

    /** The staged state as the service drives it, recording what was asked of it. */
    private class FakeStaged(private val install: InstallReport?) : StagedWelcome {
        val calls = mutableListOf<String>()
        override fun install(): InstallReport? {
            calls += "install"
            return install
        }
        override fun discard(staleBase: Long?, serverEpoch: Long?, targetRefused: Boolean) {
            calls += if (targetRefused) "discard(target)" else "discard($staleBase,$serverEpoch)"
        }
        override fun handOver(): Boolean {
            calls += "handOver"
            return handOverWorks
        }
        var handOverWorks = true
    }

    @Test
    fun anAcceptanceWhoseInstallFindsTheLockBusyHandsTheStateOverAndNeverDeletesIt() {
        // The MLS state lock was not acquired, so the install never ran. The staged state is this
        // device's own accepted commit: it is handed over to the next mls.bin writer or foreground
        // load, never deleted.
        val staged = FakeStaged(install = null)

        val applied = BackgroundWelcomeAnswer.apply(Settlement.Install, staged)

        assertEquals(Applied.HandedOver("lock busy"), applied)
        assertEquals(listOf("install", "handOver"), staged.calls)
        val (level, line) = BackgroundWelcomeAnswer.report(applied, Outcome.Accepted)
        assertEquals(Level.WARN, level)
        assertTrue(line, line.contains("handed over") && line.contains("lock busy"))
    }

    @Test
    fun aHandOverThatFailsIsAnAcceptanceNotInstalled() {
        val staged = FakeStaged(install = null).apply { handOverWorks = false }

        val applied = BackgroundWelcomeAnswer.apply(Settlement.Install, staged)

        assertEquals(Applied.NotInstalled("hand-over-failed", "lock busy"), applied)
        assertEquals(listOf("install", "handOver"), staged.calls)
        val (level, line) = BackgroundWelcomeAnswer.report(applied, Outcome.Accepted)
        assertEquals(Level.ERROR, level)
        assertTrue(line, line.contains("ACCEPTED AND NOT INSTALLED"))
    }

    @Test
    fun anAcceptanceTheNativeSideHandedOverIsAWarningNotALoss() {
        // The foreground was active: the native install wrote nothing and kept the state for the
        // foreground's load, which installs it before it reads.
        val staged = FakeStaged(install = InstallReport(ok = false, reason = "handed-over", error = null))

        val applied = BackgroundWelcomeAnswer.apply(Settlement.Install, staged)

        assertEquals(Applied.HandedOver("foreground active"), applied)
        assertEquals(listOf("install"), staged.calls)
        assertEquals(Level.WARN, BackgroundWelcomeAnswer.report(applied, Outcome.Accepted).first)
    }

    @Test
    fun anAcceptanceInstallsAndDeletesNothingMore() {
        val staged = FakeStaged(install = InstallReport(ok = true, reason = null, error = null))

        val applied = BackgroundWelcomeAnswer.apply(Settlement.Install, staged)

        assertEquals(Applied.Installed, applied)
        assertEquals(listOf("install"), staged.calls)
        assertEquals(Level.DEBUG, BackgroundWelcomeAnswer.report(applied, Outcome.Accepted).first)
    }

    @Test
    fun anInstallTheNativeSideRefusesIsAnErrorNamingItsReason() {
        // The native install removes its own staged file on every path it runs; nothing more here.
        val staged = FakeStaged(install = InstallReport(ok = false, reason = "install-refused", error = "moved"))

        val applied = BackgroundWelcomeAnswer.apply(Settlement.Install, staged)

        assertEquals(Applied.NotInstalled("install-refused", "moved"), applied)
        assertEquals(listOf("install"), staged.calls)
        val (level, line) = BackgroundWelcomeAnswer.report(applied, Outcome.Accepted)
        assertEquals(Level.ERROR, level)
        assertTrue(line, line.contains("install-refused"))
    }

    @Test
    fun aDiscardNeverInstallsAndCarriesTheStaleEpochs() {
        val staged = FakeStaged(install = InstallReport(ok = true, reason = null, error = null))
        val refused = Outcome.Refused(Refusal.EPOCH_MISMATCH, "epoch_mismatch", 3)

        val applied = BackgroundWelcomeAnswer.apply(BackgroundWelcomeAnswer.settle(refused, 1), staged)

        assertEquals(Applied.Discarded, applied)
        assertEquals(listOf("discard(1,3)"), staged.calls)
        assertEquals(Level.WARN, BackgroundWelcomeAnswer.report(applied, refused).first)
        // An answer nobody read may have been an acceptance: said at error.
        assertEquals(Level.ERROR, BackgroundWelcomeAnswer.report(applied, Outcome.Unknown(null)).first)
    }

    @Test
    fun aRefusedTargetIsRememberedForThatTargetAndNothingElse() {
        // A holder answering the same target from the same mls.bin would commit and be refused again
        // on each of the newcomer's asks.
        listOf("welcome_target_unknown", "welcome_target_not_member").forEach { token ->
            val refused = BackgroundWelcomeAnswer.classify(409, "rejected", token, 7)
            assertTrue("$refused", refused is Outcome.Refused && refused.reason != Refusal.OTHER)
            assertEquals(Settlement.Discard(null, null, targetRefused = true), BackgroundWelcomeAnswer.settle(refused, 7))

            val staged = FakeStaged(install = null)
            assertEquals(Applied.Discarded, BackgroundWelcomeAnswer.apply(BackgroundWelcomeAnswer.settle(refused, 7), staged))
            assertEquals(listOf("discard(target)"), staged.calls)
        }
    }
}
