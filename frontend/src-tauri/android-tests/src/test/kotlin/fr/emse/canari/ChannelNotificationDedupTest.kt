package fr.emse.canari

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies that ONE salon message produces ONE line, whichever of its two triggers arrives second.
 *
 * WHAT IT IS FOR. Android has had one notification builder since 2026-09-18, with two triggers: the
 * FCM push and the WebSocket frame the app receives while backgrounded. The builder recognises one
 * message by the SENDER'S INSTANT, and until 2026-09-22 the salon push payload carried no timestamp
 * at all - so a channel message that arrived both ways reached `showMessageNotification` twice with
 * `sentAt = 0`, matched nothing, and was added to the shade twice. Reported by the user on
 * 2026-09-18 as part of `G1`.
 *
 * THE FIX IS A FIELD, NOT A HEURISTIC, and that is what these cases pin. The push now carries
 * `channel_messages.createdAt` and the socket frame reads the SAME stored column off
 * `channel.message.created`, so the two numbers are equal by construction and the comparison is
 * exact. A wall clock read at either end would stamp one message twice, which is the shape this
 * must never regress to.
 *
 * WHY IT IS A MIRROR RATHER THAN THE CODE. The decision lives in `CanariFirebaseMessagingService`,
 * which cannot be configured in this module - no `tauri.settings.gradle`, no `google-services.json`.
 * What is tested here is the arithmetic: which stamp a post carries, when a line is recognised as
 * already in the shade, and when the already-announced set may refuse a post. The shade read and
 * the posting are Android's.
 */
class ChannelNotificationDedupTest {

    /** A line as `MessagingStyle` holds it: the instant is the whole of its identity here. */
    private data class Line(val timestamp: Long, val body: String)

    /** The shade, plus the set of messages this device has ever announced. */
    private class Shade {
        val lines = mutableListOf<Line>()
        val announced = mutableSetOf<String>()
    }

    /** `alertedKey` - one announced message, by its conversation and its sender's instant. */
    private fun alertedKey(notifKey: String, sentAt: Long): String = "$notifKey:$sentAt"

    /**
     * The builder's decision, mirroring `showMessageNotification`.
     *
     * @return the instant of the line it posted, or 0 when nothing reached the shade.
     */
    private fun post(
        shade: Shade,
        notifKey: String,
        body: String,
        sentAt: Long,
        supersedes: Long = 0L,
    ): Long {
        // THE FILTER COMES BEFORE THE BOUND, so superseding a line never costs a real one.
        val existing = shade.lines.filter { supersedes == 0L || it.timestamp != supersedes }
        val stamp = if (sentAt > 0) sentAt else WALL_CLOCK
        val alreadyPosted = sentAt > 0 && existing.any { it.timestamp == stamp }
        val alertedKey = if (sentAt > 0) alertedKey(notifKey, sentAt) else null
        if (alertedKey != null && !alreadyPosted && supersedes == 0L &&
            shade.announced.contains(alertedKey)
        ) {
            return 0L
        }
        shade.lines.clear()
        shade.lines.addAll(existing)
        if (!alreadyPosted) shade.lines.add(Line(stamp, body))
        alertedKey?.let { shade.announced.add(it) }
        return stamp
    }

    /** Stands in for `System.currentTimeMillis()`, which is only ever read when there is no stamp. */
    private val WALL_CLOCK = 1_700_000_000_000L

    private val salon = "channel_1b2c3d4e"
    private val instant = 1_758_499_191_859L

    @Test
    fun `a salon message arriving both ways shows one line`() {
        val shade = Shade()
        // The push wins the race, with the stored instant it now carries.
        post(shade, salon, "Bonjour", instant)
        // The socket frame reads the SAME column and reaches the builder second.
        post(shade, salon, "Bonjour", instant)
        assertEquals(1, shade.lines.size)
        assertEquals(instant, shade.lines[0].timestamp)
    }

    @Test
    fun `the two triggers need not render the message identically`() {
        val shade = Shade()
        // The push renders the decrypted plaintext; the socket frame labels a media message. The
        // key is the instant alone precisely so these two still count as one message.
        post(shade, salon, "Photo.jpg", instant)
        post(shade, salon, "[Media]", instant)
        assertEquals(1, shade.lines.size)
        assertEquals("Photo.jpg", shade.lines[0].body)
    }

    @Test
    fun `without a stamp the same message is added twice - the state before the field existed`() {
        val shade = Shade()
        post(shade, salon, "Bonjour", 0L)
        post(shade, salon, "Bonjour", 0L)
        assertEquals(2, shade.lines.size)
    }

    @Test
    fun `two messages one millisecond apart are two lines`() {
        val shade = Shade()
        post(shade, salon, "Bonjour", instant)
        post(shade, salon, "et bonsoir", instant + 1)
        assertEquals(2, shade.lines.size)
    }

    @Test
    fun `a dismissed message is not announced a second time`() {
        val shade = Shade()
        post(shade, salon, "Bonjour", instant)
        // A swipe, or `MainActivity.onResume`'s cancel-all: the shade forgets, the set does not.
        shade.lines.clear()
        assertEquals(0L, post(shade, salon, "Bonjour", instant))
        assertTrue(shade.lines.isEmpty())
    }

    @Test
    fun `a late seed redraws the generic banner rather than being refused as already announced`() {
        val shade = Shade()
        // The message arrives before the seed that opens it: a generic banner goes up, and the
        // instant it carries is what the redraw supersedes.
        val generic = post(shade, salon, "nouveau message dans #general", instant)
        assertEquals(instant, generic)
        assertTrue(shade.announced.contains(alertedKey(salon, instant)))

        // The seed lands. WITHOUT the supersede exemption this post is refused - the set already
        // holds this message - and the reader keeps "nouveau message" for ever.
        val redrawn = post(shade, salon, "Bonjour", instant, supersedes = generic)
        assertEquals(instant, redrawn)
        assertEquals(1, shade.lines.size)
        assertEquals("Bonjour", shade.lines[0].body)
    }

    @Test
    fun `a redraw does not lose the other lines of the same salon`() {
        val shade = Shade()
        post(shade, salon, "Bonjour", instant)
        val generic = post(shade, salon, "nouveau message dans #general", instant + 5)
        post(shade, salon, "Bonsoir", instant + 5, supersedes = generic)
        assertEquals(2, shade.lines.size)
        assertEquals(listOf("Bonjour", "Bonsoir"), shade.lines.map { it.body })
        assertFalse(shade.lines.any { it.body.startsWith("nouveau message") })
    }
}
