package fr.emse.canari

import fr.emse.canari.call.RingClosed
import fr.emse.canari.call.RingFacts
import fr.emse.canari.call.RingOutput
import fr.emse.canari.call.RingSequencer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * ONE RING PER CALL, AND A CLOSED CALL NEVER RINGS AGAIN (review of #2877).
 *
 * [RingSequencer] is the state the in-app player and the native CallStyle ring share. Driven here
 * with the screen injected and every Android effect recorded, in the order the sequencer asked for
 * them - which is the order the defects the review found depended on.
 */
class RingSequencerTest {
    private var onScreen = true
    private val effects = mutableListOf<String>()
    private val warnings = mutableListOf<String>()
    private lateinit var rings: RingSequencer

    private val output = object : RingOutput {
        override fun play(ring: RingFacts) {
            effects += "play ${ring.callId}"
        }

        override fun silence(callId: String, reason: String) {
            // The Android half abandons the audio focus here, always with its one context.
            effects += "silence $callId"
        }

        override fun cancelNative(callId: String) {
            effects += "cancelNative $callId"
        }

        override fun postNative(ring: RingFacts, why: String, silent: Boolean) {
            effects += if (silent) "postNative ${ring.callId} silent" else "postNative ${ring.callId}"
        }

        override fun log(accuse: Boolean, message: String) {
            if (accuse) warnings += message
        }
    }

    private fun facts(callId: String) = RingFacts(callId, "group-$callId", "caller", hasVideo = false, appSounds = true)

    /** What the FCM service does: claim, and post under the claim. */
    private fun nativePost(callId: String, silent: Boolean = false): Boolean =
        rings.claimNative(callId, silent) { effects += if (silent) "notify $callId silent" else "notify $callId" } != null

    @Before
    fun setUp() {
        onScreen = true
        effects.clear()
        warnings.clear()
        rings = RingSequencer({ onScreen }, output)
    }

    @Test
    fun `on screen the player rings, and a second start of the same call rings nothing more`() {
        rings.startInApp(facts("a"))
        rings.startInApp(facts("a"))
        assertEquals(listOf("play a"), effects)
        assertEquals("a", rings.ringingInApp)
    }

    @Test
    fun `off screen a start is refused and the native ring is posted instead`() {
        onScreen = false
        rings.startInApp(facts("a"))
        assertEquals(listOf("postNative a"), effects)
        assertNull(rings.ringingInApp)
    }

    @Test
    fun `a second call silences the first - the stop that releases its audio focus - before it plays`() {
        rings.startInApp(facts("a"))
        rings.startInApp(facts("b"))
        assertEquals(listOf("play a", "silence a", "play b"), effects)
        assertEquals("b", rings.ringingInApp)
    }

    @Test
    fun `leaving the screen hands the call to the native ring, and coming back takes it back`() {
        rings.startInApp(facts("a"))
        onScreen = false
        rings.leftScreen(screenOff = false)
        // The worker's post comes back through the claim.
        assertTrue(nativePost("a"))
        onScreen = true
        rings.startInApp(facts("a"))
        assertEquals(
            listOf("play a", "silence a", "postNative a", "notify a", "cancelNative a", "play a"),
            effects,
        )
        assertFalse(rings.nativeRinging("a"))
    }

    @Test
    fun `a native post landing after the app took the call is refused - never two rings`() {
        rings.startInApp(facts("a"))
        assertFalse(nativePost("a"))
        assertEquals(listOf("play a"), effects)
        assertEquals(0, rings.nativeCount())
    }

    @Test
    fun `the power button silences the ringer but keeps a SILENT notice, answerable from the lock screen`() {
        rings.startInApp(facts("a"))
        onScreen = false
        rings.leftScreen(screenOff = true)
        // The worker's silent post is the one a silenced call is allowed; a ringing one is not.
        assertTrue(nativePost("a", silent = true))
        assertTrue(rings.nativeRinging("a"))
        onScreen = true
        rings.startInApp(facts("a"))
        assertEquals(listOf("play a", "silence a", "postNative a silent", "notify a silent"), effects)
        assertEquals(RingClosed.SILENCED, rings.closedReason("a"))
        // An answer from that notice closes it as any answer does.
        rings.close("a", RingClosed.ANSWERED, "answered on the lock screen")
        assertFalse(rings.nativeRinging("a"))
    }

    @Test
    fun `a silenced call is never rung again by a redelivered call_ring`() {
        rings.startInApp(facts("a"))
        onScreen = false
        rings.leftScreen(screenOff = true)
        assertFalse(nativePost("a"))
        assertTrue(nativePost("a", silent = true))
    }

    @Test
    fun `the expected refusals are not accused - an overlap of two rings is`() {
        onScreen = false
        rings.startInApp(facts("off")) // a start off screen: the design working
        onScreen = true
        rings.startInApp(facts("a"))
        rings.leftScreen(screenOff = true)
        rings.startInApp(facts("a")) // the restart after a power-button silence
        rings.close("b", RingClosed.ANSWERED, "answered on the native ring")
        rings.startInApp(facts("b")) // the return after a native answer
        assertEquals(emptyList<String>(), warnings)

        rings.startInApp(facts("c"))
        assertFalse(nativePost("c")) // a post overlapping the in-app ring
        assertEquals(1, warnings.size)
        rings.close("d", RingClosed.ENDED, "call_ring_end")
        rings.startInApp(facts("d")) // the page still shows a call that ended
        assertEquals(2, warnings.size)
    }

    @Test
    fun `an answer on the native ring closes the call - the page's restart on resume rings nothing`() {
        onScreen = false
        assertTrue(nativePost("a"))
        rings.close("a", RingClosed.ANSWERED, "answered on the native ring")
        onScreen = true
        rings.startInApp(facts("a"))
        assertEquals(listOf("notify a", "cancelNative a"), effects)
        assertNull(rings.ringingInApp)
    }

    @Test
    fun `an end stops the player of that call and takes its native ring down`() {
        rings.startInApp(facts("a"))
        assertFalse(rings.close("b", RingClosed.ENDED, "another call ended"))
        rings.close("a", RingClosed.ENDED, "call_ring_end")
        assertEquals(listOf("play a", "silence a"), effects)
        // A stale incoming state after Doze, or a late FCM redelivery: neither rings it again.
        rings.startInApp(facts("a"))
        assertFalse(nativePost("a"))
        assertEquals(listOf("play a", "silence a"), effects)
    }

    @Test
    fun `a redelivered call_ring rings once, and the app coming to the front clears the native rings without closing them`() {
        onScreen = false
        assertTrue(nativePost("a"))
        assertFalse(nativePost("a"))
        val takenDown = mutableListOf<String>()
        rings.clearNative { takenDown += it }
        assertEquals(listOf("a"), takenDown)
        assertNull(rings.closedReason("a"))
        onScreen = true
        rings.startInApp(facts("a"))
        assertEquals(listOf("notify a", "play a"), effects)
    }

    @Test
    fun `a post that throws releases its claim`() {
        try {
            rings.claimNative("a") { throw IllegalStateException("notify refused") }
        } catch (_: IllegalStateException) {
        }
        assertFalse(rings.nativeRinging("a"))
        assertTrue(nativePost("a"))
    }

    @Test
    fun `the photo is drawn only while the native ring is still up`() {
        onScreen = false
        assertTrue(nativePost("a"))
        assertTrue(rings.whileNativeRinging("a") { effects += "photo a" })
        rings.close("a", RingClosed.ENDED, "declined")
        assertFalse(rings.whileNativeRinging("a") { effects += "photo a" })
        assertEquals(listOf("notify a", "photo a", "cancelNative a"), effects)
    }
}
