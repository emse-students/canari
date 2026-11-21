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
    fun `a refused entry is told and does not strand the ones that can still go`() {
        // Alone, it ends the request - nothing left can go - and is told.
        assertEquals(Decision.DONE, OutboxRetry.decide(drainLeaves(1, 400)))
        assertTrue(OutboxRetry.tells(drainLeaves(1, 400)))
        // Beside entries that can still go, the retry goes on for them (review of #3928).
        val mixed = drainLeaves(1, 403) + drainLeaves(3, null)
        assertEquals(Decision.RETRY, OutboxRetry.decide(mixed))
        assertTrue(OutboxRetry.tells(mixed))
        assertFalse(OutboxRetry.tells(drainLeaves(3, null)))
    }

    @Test
    fun `only a device that can send nothing gives up`() {
        assertEquals(Decision.GIVE_UP, OutboxRetry.decide(listOf(Prospect.BLOCKED, Prospect.BLOCKED)))
        assertEquals(Decision.GIVE_UP, OutboxRetry.decide(listOf(Prospect.BLOCKED) + drainLeaves(1, null)))
    }

    @Test
    fun `the native batch's token is read where it was classified`() {
        assertEquals(Prospect.NEVER, Prospect.of("never"))
        assertEquals(Prospect.BLOCKED, Prospect.of("never", batch = true))
        assertEquals(Prospect.NOT_YET, Prospect.of("not-yet"))
        assertEquals(Prospect.NOT_YET, Prospect.of("not-yet", batch = true))
        assertEquals(Prospect.NOT_YET, Prospect.of(null))
    }

    @Test
    fun `a 403 sender_not_active while the re-add is in flight is not yet, any other 403 is final`() {
        val pending = QueuedSendAnswer.classify(403, { QueuedSendAnswer.Refusal("sender_not_active", "pending") }) { BodyRead.NotJson }
        assertEquals(Outcome.Kept(KeptCause.SENDER_BEING_READDED), pending)
        assertEquals(Prospect.NOT_YET, (pending as Outcome.Kept).cause.prospect)
        for (refusal in listOf(
            QueuedSendAnswer.Refusal("sender_not_active", "removed"),
            QueuedSendAnswer.Refusal("sender_not_member", null),
            QueuedSendAnswer.Refusal.UNREAD,
        )) {
            assertEquals(Outcome.Kept(KeptCause.REFUSED), QueuedSendAnswer.classify(403, { refusal }) { BodyRead.NotJson })
        }
    }

    @Test
    fun `a refused push secret blocks the device instead of marking each entry unsendable`() {
        // A revoked or rotated secret meets every entry alike (review of #3928): it is the DEVICE's,
        // so it gives up once, with the nudge, and leaves the entries sendable - never NEVER.
        val typed = QueuedSendAnswer.classify(403, { QueuedSendAnswer.Refusal(QueuedSendAnswer.PUSH_SECRET_REJECTED, null) }) { BodyRead.NotJson }
        assertEquals(Outcome.Kept(KeptCause.CREDENTIAL_REFUSED), typed)
        assertEquals(Prospect.BLOCKED, (typed as Outcome.Kept).cause.prospect)
        val unauthorized = QueuedSendAnswer.classify(401, { error("a 401 is the credential whatever its body") }) { BodyRead.NotJson }
        assertEquals(Outcome.Kept(KeptCause.CREDENTIAL_REFUSED), unauthorized)
        assertEquals(Decision.GIVE_UP, OutboxRetry.decide(drainLeaves(1, 401) + drainLeaves(2, null)))
        assertFalse(OutboxRetry.tells(drainLeaves(3, 401)))
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
            // A 401 is the device's credential, not this frame's: BLOCKED, tested above.
            if (code != 401) assertEquals("HTTP $code", listOf(Prospect.NEVER), drainLeaves(1, code))
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
        repeat(3) { assertEquals(Run.END_FOR_PAGE, OutboxRetry.run(sendable = 1, appInFront = true)) }
        assertEquals(Run.DRAIN, OutboxRetry.run(sendable = 1, appInFront = false))
    }

    @Test
    fun `an empty mirror owes nothing, in front or not`() {
        assertEquals(Run.NOTHING_OWED, OutboxRetry.run(sendable = 0, appInFront = true))
        assertEquals(Run.NOTHING_OWED, OutboxRetry.run(sendable = 0, appInFront = false))
    }
}
