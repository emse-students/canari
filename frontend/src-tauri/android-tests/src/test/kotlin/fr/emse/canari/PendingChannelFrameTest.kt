package fr.emse.canari

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies the state machine that makes the channel push handler independent of FCM's ordering.
 *
 * WHAT IT IS FOR. A salon message and the Graine seed that unlocks it travel as TWO pushes, sent by
 * two services in the same second, and FCM promises no order between them. Measured on hardware by
 * `NOTIF-18` on 2026-09-21, the seed landed 324 ms AFTER the message: the phone posted "nouveau
 * message dans #<salon>", absorbed the seed a third of a second later, and nothing redrew the
 * banner. The handler now HOLDS a frame it cannot open and the absorber redraws it.
 *
 * WHY IT IS A MIRROR RATHER THAN THE CODE. The real registry lives in
 * `CanariFirebaseMessagingService`, which cannot be configured in this module - no
 * `tauri.settings.gradle`, no `google-services.json`. What is tested here is the arithmetic that
 * decides WHICH frames are held, WHEN they are claimed and in what ORDER they are redrawn; the
 * seed lookup and the posting are Android's and the phone's.
 */
class PendingChannelFrameTest {

    /** The registry's capacity, mirroring `MAX_PENDING_CHANNEL_FRAMES`. */
    private val capacity = 8

    /** A frame held for its key material: the push itself, and the line posted in its place. */
    private class Held(val index: Int, var genericStamp: Long = 0L)

    /** A mirror of the registry - insertion-ordered, bounded, evicting the eldest. */
    private class Registry(private val capacity: Int) {
        val entries = LinkedHashMap<String, Held>()

        fun put(key: String, frame: Held) {
            entries[key] = frame
            if (entries.size > capacity) {
                val eldest = entries.keys.first()
                entries.remove(eldest)
            }
        }
    }

    /**
     * The handler's decision: ask the mirror, and register only when it has nothing AND the frame
     * could have been opened. `seeds` is what `lookupGraineSeed` would answer.
     */
    private fun claimOrHold(
        registry: Registry,
        key: String,
        index: Int,
        openable: Boolean,
        seeds: Set<String>,
        session: String,
    ): String? {
        if (!openable) return null
        val seed = if (seeds.contains(session)) session else null
        if (seed == null) registry.put(key, Held(index))
        return seed
    }

    /** The absorber's decision: take every stamped frame the mirror can now answer for. */
    private fun drain(registry: Registry, seeds: Set<String>, sessionOf: (String) -> String): List<Held> {
        val taken = mutableListOf<Held>()
        val it = registry.entries.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (e.value.genericStamp == 0L) continue
            if (!seeds.contains(sessionOf(e.key))) continue
            taken.add(e.value)
            it.remove()
        }
        return taken.sortedBy { it.index }
    }

    /**
     * THE DEFECT ITSELF: the message arrives first, the seed second, and the banner is corrected.
     */
    @Test
    fun `a frame whose seed has not arrived is held, and the seed claims it`() {
        val registry = Registry(capacity)
        val seeds = mutableSetOf<String>()

        val seed = claimOrHold(registry, "c:s:0", 0, openable = true, seeds = seeds, session = "s")
        assertNull("the mirror has nothing, so the banner goes up generic", seed)
        assertEquals(1, registry.entries.size)

        // The generic banner landed and the handler recorded the instant it carries.
        registry.entries["c:s:0"]!!.genericStamp = 1_000L

        // 324 ms later, the key frame is absorbed.
        seeds.add("s")
        val redrawn = drain(registry, seeds) { it.split(":")[1] }

        assertEquals("exactly the held frame is redrawn", 1, redrawn.size)
        assertEquals("and it supersedes the line it replaces", 1_000L, redrawn[0].genericStamp)
        assertTrue("and it is no longer held", registry.entries.isEmpty())
    }

    /**
     * THE WINDOW THE 0 STAMP EXISTS TO CLOSE.
     *
     * The absorber can run between the registration and the post. It must not take a frame whose
     * generic line has no instant yet - superseding 0 would replace nothing and leave the message
     * on screen twice. The posting path re-reads the mirror afterwards and claims it there.
     */
    @Test
    fun `the drain leaves a frame whose generic post is still in flight`() {
        val registry = Registry(capacity)
        val seeds = mutableSetOf<String>()
        claimOrHold(registry, "c:s:0", 0, openable = true, seeds = seeds, session = "s")

        seeds.add("s")
        val redrawn = drain(registry, seeds) { it.split(":")[1] }

        assertTrue("nothing is taken while the stamp is unknown", redrawn.isEmpty())
        assertEquals("and the frame stays held for the posting path", 1, registry.entries.size)
    }

    /** A frame the server could not inline can never be opened, so holding it would never end. */
    @Test
    fun `a frame with no ciphertext is never held`() {
        val registry = Registry(capacity)

        val seed = claimOrHold(registry, "c:s:0", 0, openable = false, seeds = emptySet(), session = "s")

        assertNull(seed)
        assertTrue("nothing retries it, so nothing waits for it", registry.entries.isEmpty())
    }

    /** The seed was already there: the ordinary case, and it registers nothing. */
    @Test
    fun `a frame whose seed is already mirrored is opened and never held`() {
        val registry = Registry(capacity)

        val seed = claimOrHold(registry, "c:s:0", 0, openable = true, seeds = setOf("s"), session = "s")

        assertEquals("s", seed)
        assertTrue(registry.entries.isEmpty())
    }

    /**
     * ONE ENTRY PER MESSAGE, and redrawn in message order.
     *
     * Two messages of one session can both arrive before its seed, and each owns a different
     * generic line. Keying on the session alone would drop one of them; taking them in arrival
     * order would put the second line above the first in the shade.
     */
    @Test
    fun `two messages of one session are both held and redrawn in message order`() {
        val registry = Registry(capacity)
        val seeds = mutableSetOf<String>()

        // The second message overtakes the first, which is exactly what FCM allows.
        claimOrHold(registry, "c:s:1", 1, openable = true, seeds = seeds, session = "s")
        claimOrHold(registry, "c:s:0", 0, openable = true, seeds = seeds, session = "s")
        registry.entries["c:s:1"]!!.genericStamp = 2_000L
        registry.entries["c:s:0"]!!.genericStamp = 2_100L

        seeds.add("s")
        val redrawn = drain(registry, seeds) { it.split(":")[1] }

        assertEquals("both, not one", 2, redrawn.size)
        assertEquals("message 0 is redrawn first, whatever order they arrived in", 0, redrawn[0].index)
        assertEquals(1, redrawn[1].index)
    }

    /** A seed for another session claims nothing: the held frame stays held. */
    @Test
    fun `a seed for a different session claims nothing`() {
        val registry = Registry(capacity)
        claimOrHold(registry, "c:s:0", 0, openable = true, seeds = emptySet(), session = "s")
        registry.entries["c:s:0"]!!.genericStamp = 1_000L

        val redrawn = drain(registry, setOf("other")) { it.split(":")[1] }

        assertTrue(redrawn.isEmpty())
        assertEquals(1, registry.entries.size)
    }

    /**
     * TERMINATION IS A CAPACITY, NOT A CLOCK.
     *
     * A frame whose key material never comes is never claimed, so the only thing that can end it
     * is a newer frame taking its place - and the eldest is the one that goes.
     */
    @Test
    fun `the registry is bounded and drops the eldest`() {
        val registry = Registry(capacity)
        for (i in 0 until capacity + 3) {
            claimOrHold(registry, "c:s:$i", i, openable = true, seeds = emptySet(), session = "s")
        }

        assertEquals(capacity, registry.entries.size)
        assertTrue("the first three are gone", registry.entries.keys.none { it in setOf("c:s:0", "c:s:1", "c:s:2") })
        assertTrue("the newest is kept", registry.entries.containsKey("c:s:10"))
    }

    /**
     * WHAT `supersedes` DOES TO THE HISTORY: it drops exactly one line, and BEFORE the bound.
     *
     * MessagingStyle re-injects the conversation's last `MAX_NOTIF_MESSAGES - 1` lines. Filtering
     * after that bound would spend one of the slots on the line being removed, so a redraw would
     * silently shorten the history by one; filtering first keeps it full.
     */
    @Test
    fun `superseding drops one line and costs the history nothing`() {
        val maxMessages = 6
        val history = (1L..6L).toList()

        fun reinject(previous: List<Long>, supersedes: Long) =
            previous.filter { supersedes == 0L || it != supersedes }.takeLast(maxMessages - 1)

        assertEquals("nothing superseded: the ordinary bound", listOf(2L, 3L, 4L, 5L, 6L), reinject(history, 0L))
        assertEquals(
            "the generic line goes and a fifth real line takes its place",
            listOf(1L, 2L, 3L, 4L, 5L),
            reinject(history, 6L)
        )
        assertEquals("an instant no line carries changes nothing", 5, reinject(history, 99L).size)
    }
}
