package fr.emse.canari

import fr.emse.canari.push.HeldFrame
import fr.emse.canari.push.HeldFrames
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic of the frames held for the network ([HeldFrames]): one replay job per conversation,
 * a frame held once however often it is pushed, and a replay that ends on durable state - the app in
 * front, or no generic line of the frame left in the shade - with nothing re-posted.
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

    /**
     * THE LINE WAS READ OR SWIPED: nothing to upgrade, so the replay stops before any MLS work and
     * posts nothing - and says so at debug, because that is the mechanism working.
     */
    @Test
    fun `a frame whose generic line left the shade is gone, at debug, before any decrypt`() {
        val replay = HeldFrames.before(frame(stamps = setOf(100L)), foreground = false, shownStamps = setOf(999L))

        assertEquals(HeldFrames.Replay.GONE, replay)
        assertEquals(HeldFrames.Level.DEBUG, HeldFrames.level(HeldFrames.Replay.GONE))
        assertFalse("a gone frame is not kept", HeldFrames.keeps(HeldFrames.Replay.GONE))
    }

    /** THE APP OPENED FIRST: its engine owns the state and its drain reads the frame. */
    @Test
    fun `the app in front owns the frame, at debug`() {
        val replay = HeldFrames.before(frame(), foreground = true, shownStamps = setOf(100L))

        assertEquals(HeldFrames.Replay.FOREGROUND, replay)
        assertEquals(HeldFrames.Level.DEBUG, HeldFrames.level(HeldFrames.Replay.FOREGROUND))
        assertFalse(HeldFrames.keeps(HeldFrames.Replay.FOREGROUND))
    }

    @Test
    fun `a frame whose line is still shown is decrypted, and replaces only the lines still shown`() {
        val held = frame(stamps = setOf(100L, 200L))

        assertNull(HeldFrames.before(held, foreground = false, shownStamps = setOf(200L, 300L)))
        assertEquals(setOf(200L), HeldFrames.stillShown(held, setOf(200L, 300L)))
    }

    @Test
    fun `only a network still refusing keeps the frame and retries the run`() {
        assertTrue(HeldFrames.keeps(HeldFrames.Replay.STILL_UNREACHABLE))
        HeldFrames.Replay.values().filter { it != HeldFrames.Replay.STILL_UNREACHABLE }.forEach {
            assertFalse(it.name, HeldFrames.keeps(it))
        }
        assertEquals(
            HeldFrames.RunEnd.RETRY,
            HeldFrames.runEnd(listOf(HeldFrames.Replay.UPGRADED, HeldFrames.Replay.STILL_UNREACHABLE)),
        )
        assertEquals(
            HeldFrames.RunEnd.DONE,
            HeldFrames.runEnd(listOf(HeldFrames.Replay.UPGRADED, HeldFrames.Replay.GONE, HeldFrames.Replay.NOT_READABLE)),
        )
        assertEquals("a run with nothing held is done", HeldFrames.RunEnd.DONE, HeldFrames.runEnd(emptyList()))
    }

    @Test
    fun `a frame that should have opened and did not accuses`() {
        assertEquals(HeldFrames.Level.WARN, HeldFrames.level(HeldFrames.Replay.NOT_READABLE))
    }
}
