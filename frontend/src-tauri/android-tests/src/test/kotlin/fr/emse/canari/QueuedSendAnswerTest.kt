package fr.emse.canari

import fr.emse.canari.push.OutboxRetry
import fr.emse.canari.push.QueuedSendAnswer
import fr.emse.canari.push.UnsendableCause
import fr.emse.canari.push.QueuedSendAnswer.BodyRead
import fr.emse.canari.push.QueuedSendAnswer.KeptCause
import fr.emse.canari.push.QueuedSendAnswer.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * The background sender's reading of `POST /api/mls/push/send` (#3366 review, 2026-11-12): only a
 * JSON 2xx drops the message from the native outbox; a non-JSON body and a body lost in transport
 * are both kept, each under its own cause.
 */
class QueuedSendAnswerTest {

    @Test
    fun aJson2xxIsSentWithItsReceiveTime() {
        assertEquals(Outcome.Sent(1_700L), QueuedSendAnswer.classify(201) { BodyRead.Json(1_700L) })
        assertEquals(Outcome.Sent(1_700L), QueuedSendAnswer.classify(200) { BodyRead.Json(1_700L) })
    }

    @Test
    fun aJson2xxWithoutAReceiveTimeIsSentUndated() {
        assertEquals(Outcome.Sent(0L), QueuedSendAnswer.classify(201) { BodyRead.Json(0L) })
        assertEquals(Outcome.Sent(0L), QueuedSendAnswer.classify(201) { BodyRead.Json(-5L) })
    }

    @Test
    fun aNonJson2xxIsACaptivePortalAndIsKept() {
        assertEquals(
            Outcome.Kept(KeptCause.BODY_NOT_JSON),
            QueuedSendAnswer.classify(200) { BodyRead.NotJson },
        )
    }

    @Test
    fun aBodyLostInTransportIsKeptAsATransportFailureNotAsNonJson() {
        assertEquals(
            Outcome.Kept(KeptCause.BODY_READ_FAILED, "unexpected end of stream"),
            QueuedSendAnswer.classify(201) { BodyRead.TransportFailed("unexpected end of stream") },
        )
    }

    /**
     * The drain marks a line unsendable exactly when [UnsendableCause.of] names a cause, and writes
     * that cause on it: so every cause that will NEVER go carries one, and no other does - a 403
     * refusal is said "refused" on the page, never "5xx" (Mi 9T, 1.7.3-alpha.6).
     */
    @Test
    fun everyCauseThatNeverGoesCarriesItsUnsendableVerdictAndNoOtherDoes() {
        for (cause in KeptCause.entries) {
            assertEquals(
                "verdict of $cause",
                cause.prospect == OutboxRetry.Prospect.NEVER,
                UnsendableCause.of(cause) != null,
            )
        }
        val refused = QueuedSendAnswer.classify(403) { BodyRead.NotJson } as Outcome.Kept
        assertEquals(UnsendableCause.REFUSED, UnsendableCause.of(refused.cause))
        assertEquals("refused", UnsendableCause.REFUSED.wire)
        assertEquals("not_encryptable", UnsendableCause.NOT_ENCRYPTABLE.wire)
    }

    @Test
    fun aRefusedStatusIsKeptAndItsBodyIsNeverRead() {
        for (code in listOf(204, 500, 503, 408, 429)) {
            assertEquals(
                Outcome.Kept(KeptCause.NOT_ACCEPTED_STATUS),
                QueuedSendAnswer.classify(code) { fail("the body of HTTP $code was read"); BodyRead.NotJson },
            )
        }
        for (code in listOf(400, 409)) {
            assertEquals(
                Outcome.Kept(KeptCause.REFUSED),
                QueuedSendAnswer.classify(code) { fail("the body of HTTP $code was read"); BodyRead.NotJson },
            )
        }
    }
}
