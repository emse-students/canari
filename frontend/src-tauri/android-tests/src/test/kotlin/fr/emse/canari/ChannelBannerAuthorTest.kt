package fr.emse.canari

import fr.emse.canari.push.ChannelBannerAuthor
import fr.emse.canari.push.ChannelBannerAuthor.Author
import fr.emse.canari.push.ChannelBannerAuthor.NameBook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.json.JSONObject
import org.junit.Test

/**
 * A salon banner names its SPEAKER from the phone's own copy once the open PROVED who it is (a v2
 * session), draws THEIR face or initials, and keeps one group shape whatever each line could prove
 * (owner, `v1.6.0`, 2026-11-01: a salon banner with no name, no photo and the salon's "G" as a face).
 */
class ChannelBannerAuthorTest {

    private val alice = "A".repeat(64)
    private val bob = "b".repeat(64)
    private val carol = "c".repeat(64)
    private val book = NameBook.Held { id -> if (id == alice.lowercase()) "Alice Martin" else null }
    private val title = "Mines - #général"
    private val someone = "Quelqu'un"

    private fun opened(id: String?, proven: Boolean = true) =
        ChannelBannerAuthor.of(showsMessage = true, authorProven = proven, authorId = id) { book }

    private val blind = ChannelBannerAuthor.of(showsMessage = false, authorProven = false, authorId = alice) {
        fail("a blind banner must not read the name file"); book
    }

    @Test
    fun `a proven author the phone holds is named, with their initials and face`() {
        val named = opened(alice)
        assertEquals(Author.Named(alice.lowercase(), "Alice Martin"), named)
        assertEquals("Alice Martin", ChannelBannerAuthor.initialsSource(named))
        assertTrue(ChannelBannerAuthor.drawsFace(named))
    }

    @Test
    fun `a v1 session proves no author, so even a known name is not shown`() {
        val v1 = opened(alice, proven = false)
        assertEquals(Author.Unnamed(alice.lowercase(), "v1-session"), v1)
        assertFalse(ChannelBannerAuthor.drawsFace(v1))
        assertFalse(ChannelBannerAuthor.accuses("v1-session"))
    }

    @Test
    fun `a proven author the phone cannot name is unnamed, faceless, and draws a question mark`() {
        val unknown = opened(bob)
        assertEquals(Author.Unnamed(bob, "not-in-name-book"), unknown)
        assertEquals("", ChannelBannerAuthor.initialsSource(unknown))
        assertFalse(ChannelBannerAuthor.drawsFace(unknown))
    }

    @Test
    fun `an unusable name file is named as the reason`() {
        assertEquals(
            Author.Unnamed(alice.lowercase(), "other-account"),
            ChannelBannerAuthor.of(true, true, alice) { NameBook.Unusable("other-account") },
        )
    }

    @Test
    fun `an opened push that named nobody is a fault`() {
        assertEquals(Author.Unnamed("", "no-sender-id"), opened(null))
        assertTrue(ChannelBannerAuthor.accuses("no-sender-id"))
    }

    @Test
    fun `only a fault is logged at warn, an ordinary state at debug`() {
        listOf("unreadable", "no-names", "no-sender-id", "no-account").forEach { assertTrue(it, ChannelBannerAuthor.accuses(it)) }
        listOf("v1-session", "not-in-name-book", "no-name-file", "other-account")
            .forEach { assertFalse(it, ChannelBannerAuthor.accuses(it)) }
    }

    @Test
    fun `a blind banner names no speaker and never reads the names`() {
        assertEquals(Author.Unproven, blind)
        assertEquals("", ChannelBannerAuthor.initialsSource(blind))
        assertFalse(ChannelBannerAuthor.drawsFace(blind))
    }

    @Test
    fun `a blank stored name is no name`() {
        assertEquals(
            Author.Unnamed(alice.lowercase(), "not-in-name-book"),
            ChannelBannerAuthor.of(true, true, alice) { NameBook.Held { "  " } },
        )
    }

    @Test
    fun `the conversation is the salon's title, never the speaker's - even a speaker named like the salon`() {
        // Fails if the title were taken from the speaker: every speaker below is named differently
        // from the salon except the last, whose STORED name is the salon's title on purpose.
        val impostor = "d".repeat(64)
        val names = NameBook.Held { id ->
            mapOf(alice.lowercase() to "Alice Martin", impostor to title)[id]
        }
        val speakers = listOf(
            ChannelBannerAuthor.of(true, true, alice) { names },
            blind,
            ChannelBannerAuthor.of(true, true, bob) { names },
            ChannelBannerAuthor.of(true, false, alice) { names },
            ChannelBannerAuthor.of(true, true, impostor) { names },
        )
        val lines = speakers.map { ChannelBannerAuthor.line(it, title, someone) }
        assertEquals(listOf("Alice Martin", someone, someone, someone, title), lines.map { it.personName })
        lines.forEach { assertEquals(title, it.conversationTitle) }
        // And with another salon's title the same speakers move with the TITLE, not their names.
        speakers.map { ChannelBannerAuthor.line(it, "Autre - #salon", someone) }
            .forEach { assertEquals("Autre - #salon", it.conversationTitle) }
    }

    @Test
    fun `only a JSON true proves the author - absent, null and the string true do not`() {
        assertTrue(ChannelBannerAuthor.authorProvenOf(JSONObject("""{"authorProven":true}""").opt("authorProven")))
        assertFalse(ChannelBannerAuthor.authorProvenOf(JSONObject("""{"ok":true}""").opt("authorProven")))
        assertFalse(ChannelBannerAuthor.authorProvenOf(JSONObject("""{"authorProven":null}""").opt("authorProven")))
        assertFalse(ChannelBannerAuthor.authorProvenOf(JSONObject("""{"authorProven":"true"}""").opt("authorProven")))
        assertFalse(ChannelBannerAuthor.authorProvenOf(JSONObject("""{"authorProven":false}""").opt("authorProven")))
        assertFalse(ChannelBannerAuthor.authorProvenOf(null))
    }

    @Test
    fun `both triggers of one message name the same speaker, whichever arrives first`() {
        // The push hands the rule its native open's proof; the WebSocket trigger the WebView's open's
        // (`notifyMessageFromWebSocket`), with the same author and the same name file. One message,
        // one answer: a v2 author is NAMED by both, a v1 author by neither (review of #2881, HIGH-1).
        val names = NameBook.Held { id -> mapOf(alice.lowercase() to "Alice Martin")[id] }
        fun push(proven: Boolean) = ChannelBannerAuthor.of(true, ChannelBannerAuthor.authorProvenOf(proven), alice) { names }
        fun socket(proven: Boolean) = ChannelBannerAuthor.of(showsMessage = true, authorProven = proven, authorId = alice) { names }

        val v2 = listOf(push(true), socket(true))
        val v1 = listOf(push(false), socket(false))
        assertEquals(Author.Named(alice.lowercase(), "Alice Martin"), v2[0])
        assertEquals(v2[0], v2[1])
        assertEquals(Author.Unnamed(alice.lowercase(), "v1-session"), v1[0])
        assertEquals(v1[0], v1[1])
        // In either order the line, its key and its face rule are the same.
        for (pair in listOf(v2, v1)) {
            val (first, second) = pair
            assertEquals(ChannelBannerAuthor.line(first, title, someone), ChannelBannerAuthor.line(second, title, someone))
            assertEquals(ChannelBannerAuthor.drawsFace(first), ChannelBannerAuthor.drawsFace(second))
        }
        assertTrue(ChannelBannerAuthor.drawsFace(v2[0]))
        assertFalse(ChannelBannerAuthor.drawsFace(v1[0]))
    }

    @Test
    fun `speakers that share a name never share a key`() {
        // "Quelqu'un" for a blind line, for an unknown author and for another unknown author: three
        // Persons, never one. And the named Alice is not her own v1 line.
        val keys = listOf(blind, opened(bob), opened(carol), opened(alice), opened(alice, proven = false))
            .map { ChannelBannerAuthor.line(it, title, someone).personKey }
        assertEquals(keys.size, keys.toSet().size)
        // The same author keeps the same key from one post to the next, so their lines stack.
        assertEquals(
            ChannelBannerAuthor.line(opened(bob), title, someone).personKey,
            ChannelBannerAuthor.line(opened(bob.uppercase()), title, someone).personKey,
        )
        assertNotEquals(Author.Unproven.personKey, opened(alice).personKey)
    }
}
