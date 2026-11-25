package fr.emse.canari

import fr.emse.canari.push.AlertedMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which message a banner announced: the sender is part of it, an unknown sender is not a different one. */
class AlertedMessageTest {

    private val group = "g1"
    private val instant = 1_758_499_191_859L

    @Test
    fun `two senders in one millisecond are two messages`() {
        val first = AlertedMessage.key(group, "alice", instant)
        val second = AlertedMessage.key(group, "bob", instant)
        assertFalse(AlertedMessage.matches(first, second))
        assertFalse(AlertedMessage.sameSender("alice", "bob"))
    }

    @Test
    fun `one sender, one instant is one message whatever the case of the id`() {
        assertTrue(AlertedMessage.matches(AlertedMessage.key(group, "ABC", instant), AlertedMessage.key(group, "abc", instant)))
    }

    @Test
    fun `a trigger that did not know the sender still matches the one that did`() {
        val blind = AlertedMessage.key(group, "", instant)
        val named = AlertedMessage.key(group, "alice", instant)
        assertTrue(AlertedMessage.matches(blind, named))
        assertTrue(AlertedMessage.matches(named, blind))
        assertTrue(AlertedMessage.sameSender("", "alice"))
    }

    @Test
    fun `another instant or another conversation is another message`() {
        val key = AlertedMessage.key(group, "alice", instant)
        assertFalse(AlertedMessage.matches(key, AlertedMessage.key(group, "alice", instant + 1)))
        assertFalse(AlertedMessage.matches(key, AlertedMessage.key("g2", "alice", instant)))
    }

    @Test
    fun `a key of the older format never matches - it ages out, at worst one message is announced again`() {
        assertFalse(AlertedMessage.matches("$group:$instant", AlertedMessage.key(group, "alice", instant)))
        assertFalse(AlertedMessage.matches(AlertedMessage.key(group, "alice", instant), "$group:$instant"))
    }

    @Test
    fun `the key carries the three parts in order`() {
        assertEquals("g1:alice:$instant", AlertedMessage.key(group, "Alice", instant))
    }
}
