package fr.emse.canari

import fr.emse.canari.push.WakeAnswer
import fr.emse.canari.push.WakeAnswer.Outcome
import org.junit.Assert.assertEquals
import org.junit.Test

/** What a wake-up push's fetch became: a frame to dispatch, a row already gone, or a failure. */
class WakeAnswerTest {

    private val frame = mapOf("type" to "message", "groupId" to "g1", "queuedMessageId" to "q1")

    @Test
    fun `a frame answer is dispatched as the full push it stands for`() {
        assertEquals(Outcome.Frame(frame), WakeAnswer.classify(200, "frame", frame))
    }

    @Test
    fun `a gone answer is an answer, not a failure`() {
        assertEquals(Outcome.Gone, WakeAnswer.classify(200, "gone", null))
    }

    @Test
    fun `every other answer is a failure that names its stage`() {
        assertEquals(Outcome.Failed("transport"), WakeAnswer.classify(null, null, null))
        assertEquals(Outcome.Failed("http-403"), WakeAnswer.classify(403, null, null))
        assertEquals(Outcome.Failed("http-502"), WakeAnswer.classify(502, "frame", frame))
        assertEquals(Outcome.Failed("unknown-status"), WakeAnswer.classify(200, "later", null))
        assertEquals(Outcome.Failed("unknown-status"), WakeAnswer.classify(200, null, frame))
        assertEquals(Outcome.Failed("frame-without-fields"), WakeAnswer.classify(200, "frame", null))
        assertEquals(
            Outcome.Failed("frame-without-type"),
            WakeAnswer.classify(200, "frame", mapOf("groupId" to "g1")),
        )
    }

    @Test
    fun `a frame that is itself a wake is refused, or the dispatcher would fetch again`() {
        assertEquals(
            Outcome.Failed("frame-is-a-wake"),
            WakeAnswer.classify(200, "frame", mapOf("type" to WakeAnswer.WAKE_TYPE)),
        )
    }
}
