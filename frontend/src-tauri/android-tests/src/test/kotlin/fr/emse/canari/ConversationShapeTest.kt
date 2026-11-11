package fr.emse.canari

import fr.emse.canari.push.ConversationShape
import fr.emse.canari.push.ConversationShape.Shape
import org.junit.Assert.assertEquals
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
    fun `a reaction or a blind salon banner keeps the old untitled one-to-one shape`() {
        for (shortcut in listOf(false, true)) for (sdk in listOf(api29, api36)) {
            assertEquals(
                Shape(title = null, groupConversation = false),
                ConversationShape.of(isGroup = false, groupName = "", namesEachSender = false, hasShortcut = shortcut, sdkInt = sdk),
            )
        }
    }
}
