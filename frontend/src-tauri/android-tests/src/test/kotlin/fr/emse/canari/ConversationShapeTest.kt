package fr.emse.canari

import fr.emse.canari.push.ConversationShape
import fr.emse.canari.push.ConversationShape.Shape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A direct message names its sender once (owner, Android 16, 2026-11-11): where the platform titles
 * the post with the conversation shortcut, the lines do not repeat the name; a group keeps its
 * title and every speaker's name.
 */
class ConversationShapeTest {

    private val api36 = 36
    private val api29 = 29

    @Test
    fun `a direct message drawn as a conversation is one-to-one and untitled`() {
        assertEquals(
            Shape(title = null, groupConversation = false),
            ConversationShape.of(isGroup = false, groupName = "", namesEachSender = true, hasShortcut = true, sdkInt = api36),
        )
        assertEquals(
            Shape(title = null, groupConversation = false),
            ConversationShape.of(isGroup = false, groupName = "", namesEachSender = true, hasShortcut = true, sdkInt = ConversationShape.CONVERSATION_LAYOUT_API),
        )
    }

    @Test
    fun `a direct message without a conversation header keeps the untitled group shape`() {
        assertEquals(
            Shape(title = null, groupConversation = true),
            ConversationShape.of(isGroup = false, groupName = "", namesEachSender = true, hasShortcut = false, sdkInt = api36),
        )
        assertEquals(
            Shape(title = null, groupConversation = true),
            ConversationShape.of(isGroup = false, groupName = "", namesEachSender = true, hasShortcut = true, sdkInt = api29),
        )
    }

    @Test
    fun `a group is titled and names every speaker, shortcut or not`() {
        for (shortcut in listOf(false, true)) for (sdk in listOf(api29, api36)) for (names in listOf(false, true)) {
            assertEquals(
                Shape(title = "Groupe", groupConversation = true),
                ConversationShape.of(isGroup = true, groupName = "Groupe", namesEachSender = names, hasShortcut = shortcut, sdkInt = sdk),
            )
        }
    }

    @Test
    fun `the declared isGroup wins over the name - an unnamed group is a group`() {
        // A third of production groups carry no name; the name rule read them as a DM with their
        // first speaker (review of #3344, M1).
        assertTrue(ConversationShape.isGroup(groupName = "", senderName = "Alice", declared = true))
        // A group named like one of its members is still a group.
        assertTrue(ConversationShape.isGroup(groupName = "Alice", senderName = "Alice", declared = true))
        // A DM the server named is still a DM.
        assertFalse(ConversationShape.isGroup(groupName = "Alice", senderName = "Bob", declared = false))
    }

    @Test
    fun `not said falls back to the name rule`() {
        assertTrue(ConversationShape.isGroup(groupName = "Groupe", senderName = "Alice", declared = null))
        assertFalse(ConversationShape.isGroup(groupName = "", senderName = "Alice", declared = null))
        assertFalse(ConversationShape.isGroup(groupName = "Alice", senderName = "Alice", declared = null))
        assertFalse(ConversationShape.isGroup(groupName = "", senderName = "Alice"))
    }

    @Test
    fun `an unnamed group keeps the group shape, titled as a group, with a shortcut on API 36`() {
        val title = ConversationShape.groupTitle(groupName = "", unnamedGroup = "Conversation de groupe")
        assertEquals("Conversation de groupe", title)
        assertEquals(
            Shape(title = "Conversation de groupe", groupConversation = true),
            ConversationShape.of(
                isGroup = ConversationShape.isGroup(groupName = "", senderName = "Alice", declared = true),
                groupName = title, namesEachSender = true, hasShortcut = true, sdkInt = api36,
            ),
        )
        assertEquals("Les gourmands", ConversationShape.groupTitle(groupName = "Les gourmands", unnamedGroup = "x"))
    }

    @Test
    fun `a group named like a member keeps the group shape and its name`() {
        assertEquals(
            Shape(title = "Alice", groupConversation = true),
            ConversationShape.of(
                isGroup = ConversationShape.isGroup(groupName = "Alice", senderName = "Alice", declared = true),
                groupName = "Alice", namesEachSender = true, hasShortcut = true, sdkInt = api36,
            ),
        )
    }

    @Test
    fun `a reaction keeps the old untitled one-to-one shape`() {
        for (shortcut in listOf(false, true)) for (sdk in listOf(api29, api36)) {
            assertEquals(
                Shape(title = null, groupConversation = false),
                ConversationShape.of(isGroup = false, groupName = "", namesEachSender = false, hasShortcut = shortcut, sdkInt = sdk),
            )
        }
    }
}
