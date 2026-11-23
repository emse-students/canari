package fr.emse.canari

import fr.emse.canari.call.CallAudioLease
import fr.emse.canari.call.CallAudioSlot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A REPLACED CALL CLOSES ITS AUDIO, AND THE NEW CALL OPENS ITS OWN (review of #4012): the focus events
 * of the call in the foreground always carry ITS id, never the replaced call's.
 */
class CallAudioSlotTest {
    /** A fake audio: records, in one shared journal, when it was made and when it was closed. */
    private class FakeAudio(override val callId: String, private val journal: MutableList<String>) : CallAudioLease {
        var closes = 0
        init {
            journal += "open $callId"
        }
        override fun close(why: String) {
            closes++
            journal += "close $callId"
        }
    }

    private val journal = mutableListOf<String>()
    private val logs = mutableListOf<Pair<Boolean, String>>()
    private val slot = CallAudioSlot<FakeAudio> { accuse, message -> logs += accuse to message }

    @Test
    fun theFirstOpenMakesTheAudioOfItsCall() {
        val audio = slot.open("call-a-0000") { FakeAudio(it, journal) }
        assertEquals("call-a-0000", audio.callId)
        assertSame(audio, slot.current)
        assertEquals(listOf("open call-a-0000"), journal)
        assertFalse(logs.single().first)
    }

    @Test
    fun aReplacementClosesTheOldAudioBeforeTheNewOneOpensWithTheNewCallId() {
        val old = slot.open("call-a-0000") { FakeAudio(it, journal) }
        val new = slot.open("call-b-1111") { FakeAudio(it, journal) }
        // Closed BEFORE the new one asks for the focus: the old request never answers for the new call.
        assertEquals(listOf("open call-a-0000", "close call-a-0000", "open call-b-1111"), journal)
        assertEquals(1, old.closes)
        assertEquals("call-b-1111", new.callId)
        assertSame(new, slot.current)
        assertEquals(0, new.closes)
        // An ordinary replacement is logged, not accused (the service accuses the missing stop).
        assertFalse(logs.last().first)
        assertTrue(logs.last().second.contains("call=call-a-0"))
    }

    /** The service never reopens the call it holds; if it ever did, the line accuses and nothing leaks. */
    @Test
    fun reopeningTheSameCallStillClosesTheOldAudioAndAccuses() {
        val old = slot.open("call-a-0000") { FakeAudio(it, journal) }
        slot.open("call-a-0000") { FakeAudio(it, journal) }
        assertEquals(1, old.closes)
        assertTrue(logs.last().first)
    }

    @Test
    fun closeReleasesTheCurrentAudioOnceAndEmptiesTheSlot() {
        val audio = slot.open("call-a-0000") { FakeAudio(it, journal) }
        slot.close("the call left the foreground")
        assertNull(slot.current)
        assertEquals(1, audio.closes)
        // A second close finds nothing and says so; the audio is never closed twice.
        slot.close("again")
        assertEquals(1, audio.closes)
        assertTrue(logs.last().second.startsWith("no audio to close"))
    }
}
