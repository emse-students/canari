package fr.emse.canari

import fr.emse.canari.call.CallAudioLease
import fr.emse.canari.call.CallAudioLife
import fr.emse.canari.call.CallAudioSlot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A CALL THAT REPLACES ANOTHER IN THE SERVICE TAKES ITS AUDIO OVER, NEVER CLOSES AND REOPENS IT
 * (review of #4012): the focus events carry the new call's id, and the live voice keeps its mode,
 * output and focus. A closed audio refuses the callbacks the main looper still delivers.
 */
class CallAudioSlotTest {
    /** A fake audio: records, in one shared journal, what was done to it. */
    private class FakeAudio(callId: String, private val journal: MutableList<String>) : CallAudioLease {
        override var callId: String = callId
            private set
        var closes = 0

        init {
            journal += "open $callId"
        }

        override fun handOver(newCallId: String) {
            journal += "hand over $callId -> $newCallId"
            callId = newCallId
        }

        override fun close(why: String) {
            closes++
            journal += "close $callId"
        }
    }

    private val journal = mutableListOf<String>()
    private val logs = mutableListOf<Pair<Boolean, String>>()
    private val log: (Boolean, String) -> Unit = { accuse, message -> logs += accuse to message }
    private val slot = CallAudioSlot<FakeAudio>(log)

    @Test
    fun theFirstOpenMakesTheAudioOfItsCall() {
        val audio = slot.open("call-a-0000") { FakeAudio(it, journal) }
        assertEquals("call-a-0000", audio.callId)
        assertSame(audio, slot.current)
        assertEquals(listOf("open call-a-0000"), journal)
        assertFalse(logs.single().first)
    }

    /** The same audio object, relabelled - nothing closed, nothing reopened, so no glitch. */
    @Test
    fun aReplacementHandsTheSameAudioOverToTheNewCallId() {
        val audio = slot.open("call-a-0000") { FakeAudio(it, journal) }
        val after = slot.handOver("call-b-1111")
        assertSame(audio, after)
        assertSame(audio, slot.current)
        assertEquals("call-b-1111", audio.callId)
        assertEquals(0, audio.closes)
        assertEquals(listOf("open call-a-0000", "hand over call-a-0000 -> call-b-1111"), journal)
        assertFalse(logs.last().first)
        // Release still closes exactly once, under the new call's id.
        slot.close("the call left the foreground")
        assertEquals(1, audio.closes)
        assertEquals("close call-b-1111", journal.last())
    }

    @Test
    fun aHandoverWithNoAudioOrToTheSameCallIsAccused() {
        assertNull(slot.handOver("call-b-1111"))
        assertTrue(logs.last().first)
        val audio = slot.open("call-a-0000") { FakeAudio(it, journal) }
        assertSame(audio, slot.handOver("call-a-0000"))
        assertTrue(logs.last().first)
        assertEquals(listOf("open call-a-0000"), journal)
    }

    /** The service opens once per foreground entry; an audio still held is closed, never leaked. */
    @Test
    fun anOpenThatFindsAnAudioStillHeldClosesItAndAccuses() {
        val old = slot.open("call-a-0000") { FakeAudio(it, journal) }
        slot.open("call-b-1111") { FakeAudio(it, journal) }
        assertEquals(listOf("open call-a-0000", "close call-a-0000", "open call-b-1111"), journal)
        assertEquals(1, old.closes)
        assertTrue(logs.last().first)
    }

    @Test
    fun closeReleasesTheCurrentAudioOnceAndASecondCloseIsAccused() {
        val audio = slot.open("call-a-0000") { FakeAudio(it, journal) }
        slot.close("the call left the foreground")
        assertNull(slot.current)
        assertEquals(1, audio.closes)
        assertFalse(logs.last().first)
        slot.close("again")
        assertEquals(1, audio.closes)
        assertTrue(logs.last().first)
        assertTrue(logs.last().second.startsWith("no audio to close"))
    }

    /** A device callback or focus change posted before the close and run after it does nothing. */
    @Test
    fun aClosedAudioRefusesLateCallbacksWithOneAccusingLineEach() {
        val life = CallAudioLife(log)
        assertTrue(life.admits("output re-route", "call-a-0000"))
        assertTrue(logs.isEmpty())
        assertTrue(life.close("call-a-0000"))
        assertFalse(life.admits("output re-route", "call-a-0000"))
        assertFalse(life.admits("audio focus change", "call-a-0000"))
        assertEquals(2, logs.size)
        assertTrue(logs.all { it.first })
        // A second close is refused, said, and does nothing.
        assertFalse(life.close("call-a-0000"))
        assertEquals(3, logs.size)
    }
}
