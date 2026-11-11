package fr.emse.canari

import fr.emse.canari.push.ConversationShape
import fr.emse.canari.push.FallbackLine
import fr.emse.canari.push.FallbackLine.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The line standing in for an unreadable message names the sender only where the title does not
 * (owner, 2026-11-11): a direct message, titled with the sender, reads "Nouveau message".
 */
class FallbackLineTest {

    @Test
    fun `a direct message does not repeat the sender its title names`() {
        assertEquals(Kind.NEW_MESSAGE, FallbackLine.of(senderName = "Alice", groupName = ""))
        // A DM whose push names the conversation after the sender is still a DM.
        assertEquals(Kind.NEW_MESSAGE, FallbackLine.of(senderName = "Alice", groupName = "Alice"))
    }

    @Test
    fun `a group names the sender, because its title is the group`() {
        assertEquals(Kind.FROM_SENDER, FallbackLine.of(senderName = "Alice", groupName = "Groupe"))
    }

    @Test
    fun `nobody to name reads the generic encrypted line`() {
        assertEquals(Kind.ENCRYPTED, FallbackLine.of(senderName = "", groupName = ""))
        assertEquals(Kind.ENCRYPTED, FallbackLine.of(senderName = "", groupName = "Groupe"))
    }

    @Test
    fun `the group predicate is the one the title reads`() {
        assertTrue(ConversationShape.isGroup(groupName = "Groupe", senderName = "Alice"))
        assertFalse(ConversationShape.isGroup(groupName = "", senderName = "Alice"))
        assertFalse(ConversationShape.isGroup(groupName = "Alice", senderName = "Alice"))
    }
}
