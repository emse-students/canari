package fr.emse.canari

import fr.emse.canari.push.OutboxRetry
import fr.emse.canari.push.OutboxRetry.Decision
import fr.emse.canari.push.OutboxRetry.Prospect
import fr.emse.canari.push.OutboxRetry.Run
import fr.emse.canari.push.QueuedSendAnswer
import fr.emse.canari.push.QueuedSendAnswer.BodyRead
import fr.emse.canari.push.QueuedSendAnswer.KeptCause
import fr.emse.canari.push.QueuedSendAnswer.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE BACKGROUND OUTBOX RETRY ENDS ON DURABLE STATE, NEVER ON A COUNT (#3912 review, round 11): three
 * failed drains - about three and a half minutes of backoff - used to end it, so a backend down that
 * long while the phone was online left a reply waiting for the app to open.
 */
class OutboxRetryTest {

    /** What one drain leaves when every POST of [entries] answered [code] (or no answer, for null). */
    private fun drainLeaves(entries: Int, code: Int?): List<Prospect> = List(entries) {
        val outcome = if (code == null) Outcome.Kept(KeptCause.TRANSPORT_FAILED)
        else QueuedSendAnswer.classify(code) { BodyRead.Json(1L) }
        (outcome as Outcome.Kept).cause.prospect
    }

    @Test
    fun `three transport failures in a row still end in retry`() {
        repeat(3) { assertEquals(Decision.RETRY, OutboxRetry.decide(drainLeaves(2, null))) }
        // And a fourth, and a tenth: there is no cap.
        repeat(10) { assertEquals(Decision.RETRY, OutboxRetry.decide(drainLeaves(1, 503))) }
    }

    @Test
    fun `one 4xx refusal ends in the nudge`() {
        assertEquals(Decision.GIVE_UP, OutboxRetry.decide(drainLeaves(1, 400)))
        assertEquals(Decision.GIVE_UP, OutboxRetry.decide(drainLeaves(1, 403) + drainLeaves(3, null)))
    }

    @Test
    fun `a server fault and the three 4xx that say later are not yet`() {
        for (code in listOf(500, 502, 503, 504, 408, 425, 429, 204)) {
            assertEquals("HTTP $code", listOf(Prospect.NOT_YET), drainLeaves(1, code))
        }
    }

    @Test
    fun `every other 4xx is final`() {
        for (code in listOf(400, 401, 403, 404, 409, 410, 413, 422)) {
            assertTrue("HTTP $code", OutboxRetry.isFinalRefusal(code))
            assertEquals("HTTP $code", listOf(Prospect.NEVER), drainLeaves(1, code))
        }
        assertFalse(OutboxRetry.isFinalRefusal(500))
    }

    @Test
    fun `a drain that leaves nothing is done`() {
        assertEquals(Decision.DONE, OutboxRetry.decide(emptyList()))
    }

    @Test
    fun `a run in front ends its request, three times, and the background run drains at once`() {
        // Each deferral ENDS the request (Result.success), so no backoff grows: the request the
        // background edge enqueues drains on its first run.
        repeat(3) { assertEquals(Run.END_FOR_PAGE, OutboxRetry.run(queued = 1, appInFront = true)) }
        assertEquals(Run.DRAIN, OutboxRetry.run(queued = 1, appInFront = false))
    }

    @Test
    fun `an empty mirror owes nothing, in front or not`() {
        assertEquals(Run.NOTHING_OWED, OutboxRetry.run(queued = 0, appInFront = true))
        assertEquals(Run.NOTHING_OWED, OutboxRetry.run(queued = 0, appInFront = false))
    }
}
