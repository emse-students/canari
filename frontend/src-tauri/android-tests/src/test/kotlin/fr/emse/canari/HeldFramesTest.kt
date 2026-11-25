package fr.emse.canari

import fr.emse.canari.push.HeldFrame
import fr.emse.canari.push.HeldFrames
import fr.emse.canari.push.HeldFrames.Replay
import fr.emse.canari.push.UnshownReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic of the frames held for the network or the lock ([HeldFrames]): one replay job per
 * conversation, a frame held once however often it is pushed, a frame kept for whatever says nothing
 * about it, and a replay that ends on durable state with nothing re-posted.
 */
class HeldFramesTest {

    private fun frame(group: String = "g1", key: String = "q1", stamps: Set<Long> = setOf(100L)) =
        HeldFrame(group, key, stamps, mapOf("groupId" to group, "queuedMessageId" to key))

    @Test
    fun `one unique replay job per conversation`() {
        assertEquals(HeldFrames.uniqueWorkName("g1"), HeldFrames.uniqueWorkName("g1"))
        assertNotEquals(HeldFrames.uniqueWorkName("g1"), HeldFrames.uniqueWorkName("g2"))
        assertTrue(
            "every job name is under the tag the app's takeover cancels",
            HeldFrames.uniqueWorkName("g1").startsWith(HeldFrames.WORK_TAG),
        )
    }

    /** A push and the move to the front cannot interleave: the hold asks, under the store's lock. */
    @Test
    fun `no frame is held while the app is in front`() {
        assertFalse(HeldFrames.admits(foreground = true))
        assertTrue(HeldFrames.admits(foreground = false))
    }

    @Test
    fun `holding the same frame twice keeps one entry and both of its generic lines`() {
        val once = HeldFrames.hold(emptyList(), frame(stamps = setOf(100L)))
        val twice = HeldFrames.hold(once, frame(stamps = setOf(200L)))

        assertEquals(1, twice.size)
        assertEquals(setOf(100L, 200L), twice.single().placeholderStamps)
    }

    @Test
    fun `different frames are held side by side`() {
        val held = HeldFrames.hold(HeldFrames.hold(emptyList(), frame(key = "q1")), frame(key = "q2"))

        assertEquals(listOf("q1", "q2"), held.map { it.frameKey })
        val otherGroup = HeldFrames.hold(held, frame(group = "g2", key = "q1"))
        assertEquals("the same queued id in another conversation is another frame", 3, otherGroup.size)
    }

    /** A run walks its conversation's frames once each, and settling removes exactly one. */
    @Test
    fun `a run picks each frame of its conversation once, and settling removes only that frame`() {
        val held = listOf(frame(key = "q1"), frame(group = "g2", key = "q1"), frame(key = "q2"))

        assertEquals("q1", HeldFrames.next(held, "g1", emptySet())?.frameKey)
        assertEquals("q2", HeldFrames.next(held, "g1", setOf("q1"))?.frameKey)
        assertNull(HeldFrames.next(held, "g1", setOf("q1", "q2")))

        val settled = HeldFrames.settle(held, frame(key = "q1"))
        assertEquals(listOf("g2" to "q1", "g1" to "q2"), settled.map { it.groupId to it.frameKey })
    }

    /** The move to the background hands every held conversation back to its replay. */
    @Test
    fun `every conversation with a held frame is handed back once`() {
        val held = listOf(frame(key = "q1"), frame(key = "q2"), frame(group = "g2", key = "q3"))

        assertEquals(setOf("g1", "g2"), HeldFrames.groupsHeld(held))
    }

    /**
     * THE LINE WAS READ OR SWIPED: nothing to upgrade, so the replay stops before any MLS work and
     * posts nothing - and says so at debug, because that is the mechanism working.
     */
    @Test
    fun `a frame whose generic line left the shade is gone, at debug, before any decrypt`() {
        val replay = HeldFrames.before(frame(stamps = setOf(100L)), foreground = false, shownStamps = setOf(999L))

        assertEquals(Replay.GONE, replay)
        assertEquals(HeldFrames.Level.DEBUG, HeldFrames.level(Replay.GONE))
        assertFalse("a gone frame is not kept", HeldFrames.keeps(Replay.GONE))
    }

    /**
     * THE APP IN FRONT KEEPS THE FRAME, AND DOES NOT RETRY IT. An app opened offline drains nothing,
     * so the frame is still owed; its move to the background hands the job back.
     */
    @Test
    fun `the app in front keeps the frame without retrying the run, at debug`() {
        val replay = HeldFrames.before(frame(), foreground = true, shownStamps = setOf(100L))

        assertEquals(Replay.FOREGROUND, replay)
        assertTrue(HeldFrames.keeps(Replay.FOREGROUND))
        assertEquals(HeldFrames.RunEnd.DONE, HeldFrames.runEnd(listOf(Replay.FOREGROUND)))
        assertEquals(HeldFrames.Level.DEBUG, HeldFrames.level(Replay.FOREGROUND))
    }

    @Test
    fun `a frame whose line is still shown is decrypted, and replaces only the lines still shown`() {
        val held = frame(stamps = setOf(100L, 200L))

        assertNull(HeldFrames.before(held, foreground = false, shownStamps = setOf(200L, 300L)))
        assertEquals(setOf(200L), HeldFrames.stillShown(held, setOf(200L, 300L)))
    }

    /**
     * A LOCK TIMEOUT IS NOT A VERDICT ON THE FRAME. It was read as a refusal, which dropped the frame
     * and accused it at WARN; it keeps the frame and retries now, like a network still refusing.
     */
    @Test
    fun `a held lock and a network still refusing keep the frame and retry the run, without accusing`() {
        listOf(Replay.STILL_UNREACHABLE, Replay.STATE_BUSY).forEach {
            assertTrue(it.name, HeldFrames.keeps(it))
            assertEquals(it.name, HeldFrames.RunEnd.RETRY, HeldFrames.runEnd(listOf(Replay.UPGRADED, it)))
            assertNotEquals(it.name, HeldFrames.Level.WARN, HeldFrames.level(it))
        }
    }

    @Test
    fun `every verdict on the frame settles it`() {
        val verdicts = listOf(
            Replay.UPGRADED, Replay.GONE, Replay.EMPTY, Replay.UNSHOWN, Replay.CONSUMED, Replay.NOT_READABLE, Replay.FAILED,
        )
        verdicts.forEach { assertFalse(it.name, HeldFrames.keeps(it)) }
        assertEquals(HeldFrames.RunEnd.DONE, HeldFrames.runEnd(verdicts))
        assertEquals("a run with nothing held is done", HeldFrames.RunEnd.DONE, HeldFrames.runEnd(emptyList()))
    }

    /**
     * A frame that decrypted to nothing a line can show, and one the app's drain already read, are the
     * mechanism working: debug. Only a frame that should have opened and did not accuses.
     */
    @Test
    fun `only a frame that should have opened and did not accuses`() {
        assertEquals(HeldFrames.Level.DEBUG, HeldFrames.level(Replay.EMPTY))
        assertEquals(HeldFrames.Level.DEBUG, HeldFrames.level(Replay.CONSUMED))
        assertEquals(HeldFrames.Level.DEBUG, HeldFrames.level(Replay.UNSHOWN))
        assertEquals(HeldFrames.Level.WARN, HeldFrames.level(Replay.NOT_READABLE))
        assertEquals(
            listOf(Replay.NOT_READABLE),
            Replay.values().filter { HeldFrames.level(it) == HeldFrames.Level.WARN },
        )
    }

    /**
     * ONLY A CONTROL FRAME HOLDS NO MESSAGE. An unknown kind, a sender MLS did not verify and a seed
     * request are real messages whose generic line the live push keeps; the replay removed it.
     */
    @Test
    fun `only a control frame removes its generic line`() {
        assertEquals(Replay.EMPTY, HeldFrames.ofUnshown(UnshownReason.CONTROL_FRAME))
        assertEquals(
            listOf(UnshownReason.CONTROL_FRAME),
            UnshownReason.values().filter { HeldFrames.ofUnshown(it) == Replay.EMPTY },
        )
        UnshownReason.values().filterNot { it.dropsGenericLine }.forEach {
            assertEquals(it.name, Replay.UNSHOWN, HeldFrames.ofUnshown(it))
        }
    }

    /**
     * A THROW SETTLES ITS FRAME, SAID ONCE AT ERROR: kept, a frame that throws every time held back its
     * conversation's other frames for ever and accused again on every pause.
     */
    @Test
    fun `a replay that threw is settled, at error, and does not retry the run`() {
        assertFalse(HeldFrames.keeps(Replay.FAILED))
        assertFalse(HeldFrames.stopsRun(Replay.FAILED))
        assertEquals(HeldFrames.Level.ERROR, HeldFrames.level(Replay.FAILED))
        assertEquals(HeldFrames.RunEnd.DONE, HeldFrames.runEnd(listOf(Replay.FAILED)))
    }

    /**
     * THE NEXT FRAME MEETS THE SAME NETWORK, LOCK OR APP: a run stops at the first kept replay rather
     * than spend a full network timeout per remaining frame. A verdict on one frame goes on.
     */
    @Test
    fun `a run stops at the first replay that says nothing about the frame`() {
        listOf(Replay.STILL_UNREACHABLE, Replay.STATE_BUSY, Replay.FOREGROUND).forEach {
            assertTrue(it.name, HeldFrames.stopsRun(it))
        }
        Replay.values().filterNot { HeldFrames.keeps(it) }.forEach {
            assertFalse(it.name, HeldFrames.stopsRun(it))
        }
    }
}
