package fr.emse.canari

import fr.emse.canari.push.SweepFailureLedger
import fr.emse.canari.push.SweepFailureLedger.Outcome
import fr.emse.canari.push.SweepFailureLedger.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * When `MlsBackgroundWorker` raises "Synchronisation en attente" ([SweepFailureLedger]).
 *
 * The case that failed (owner's report, 2026-11-26): the notice under a correctly decrypted message,
 * raised by WorkManager's `runAttemptCount` after three runs that had failed at nothing - the app in
 * front, the MLS lock held by a push. Those runs no longer exist as outcomes; a run is a sweep that
 * succeeded or one that failed, and only a streak of the second raises the notice.
 */
class SweepFailureLedgerTest {

    private val failed = Outcome.Failed("native sweep answered false")

    /** Folds [outcomes] from a zero streak, as the worker does across runs through its prefs. */
    private fun fold(outcomes: List<Outcome>, from: Int = 0): List<SweepFailureLedger.Decision> {
        var streak = from
        return outcomes.map { outcome ->
            SweepFailureLedger.next(streak, outcome).also { streak = it.consecutiveFailures }
        }
    }

    @Test
    fun `three runs that did not fail raise no notice, however many times WorkManager ran them`() {
        val decisions = fold(listOf(Outcome.Swept, Outcome.Swept, Outcome.Swept, Outcome.Swept))
        assertTrue(decisions.none { it.raisesNotice })
        assertTrue(decisions.all { it.verdict == Verdict.DONE && it.consecutiveFailures == 0 })
    }

    @Test
    fun `three real failures in a row raise exactly one notice, on the third`() {
        val decisions = fold(listOf(failed, failed, failed))
        assertEquals(listOf(Verdict.RETRY, Verdict.RETRY, Verdict.GIVE_UP), decisions.map { it.verdict })
        assertEquals(listOf(false, false, true), decisions.map { it.raisesNotice })
    }

    @Test
    fun `a request already queued that fails after the give-up stops without a second notice`() {
        val after = SweepFailureLedger.next(SweepFailureLedger.GIVE_UP_AFTER, failed)
        assertEquals(Verdict.GIVE_UP, after.verdict)
        assertFalse(after.raisesNotice)
    }

    @Test
    fun `a sweep that succeeds resets the streak, so two failures either side raise nothing`() {
        val decisions = fold(listOf(failed, failed, Outcome.Swept, failed, failed))
        assertTrue(decisions.none { it.raisesNotice })
        assertEquals(listOf(1, 2, 0, 1, 2), decisions.map { it.consecutiveFailures })
    }

    @Test
    fun `the streak is durable across work requests - failures of three pushes are three failures`() {
        // Each push enqueues its own request; the streak is read back from the prefs, not the request.
        val first = SweepFailureLedger.next(0, failed)
        val second = SweepFailureLedger.next(first.consecutiveFailures, failed)
        val third = SweepFailureLedger.next(second.consecutiveFailures, failed)
        assertTrue(third.raisesNotice)
    }

    @Test
    fun `an opened app resets the streak to zero, and the next failure starts a new one`() {
        // `resetFailureFlag` writes 0; the ledger then counts from there.
        assertEquals(1, SweepFailureLedger.next(0, failed).consecutiveFailures)
        assertEquals(Verdict.RETRY, SweepFailureLedger.next(0, failed).verdict)
    }
}
