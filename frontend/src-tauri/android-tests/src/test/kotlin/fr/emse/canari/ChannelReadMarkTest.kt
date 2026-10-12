package fr.emse.canari

import fr.emse.canari.push.ChannelReadMark
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** "Mark as read" on a salon notification: when it is offered, and which salon it names. */
class ChannelReadMarkTest {

    @Test
    fun `a salon conversation id names its channel and a DM or group does not`() {
        assertEquals("abc-123", ChannelReadMark.channelIdOf("channel_abc-123"))
        assertNull(ChannelReadMark.channelIdOf("3f2a9c1e-group"))
        assertNull(ChannelReadMark.channelIdOf(""))
        assertNull(ChannelReadMark.channelIdOf("channel_"))
    }

    @Test
    fun `the action needs a salon AND the instant the notification stands for`() {
        assertTrue(ChannelReadMark.offered("channel_abc", 1_700_000_000_000L))
        assertFalse(ChannelReadMark.offered("channel_abc", 0L))
        assertFalse(ChannelReadMark.offered("channel_abc", -5L))
        assertFalse(ChannelReadMark.offered("dm-group", 1_700_000_000_000L))
    }
}
