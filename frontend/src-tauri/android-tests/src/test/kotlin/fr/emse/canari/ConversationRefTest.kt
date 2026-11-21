package fr.emse.canari

import fr.emse.canari.push.ConversationRef
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The conversation a log line names ([ConversationRef]): a salon by its own id, never the
 * `channel_` prefix every salon shares (device reading of #3912, 2026-11-20) - the scheme of the
 * push-outcome line (#3914).
 */
class ConversationRefTest {
    @Test
    fun `a salon is named by its own id, a conversation by its group id`() {
        assertEquals("ch:9f8e7d6c", ConversationRef.of("channel_9f8e7d6c5b4a"))
        assertEquals("g:01234567", ConversationRef.of("0123456789"))
        assertEquals("ch:ab", ConversationRef.of("channel_ab"))
    }

    @Test
    fun `no conversation is a question mark`() {
        assertEquals("?", ConversationRef.of(null))
        assertEquals("?", ConversationRef.of(""))
    }
}
