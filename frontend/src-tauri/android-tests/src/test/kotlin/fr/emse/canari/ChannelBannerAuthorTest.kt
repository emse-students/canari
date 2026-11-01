package fr.emse.canari

import fr.emse.canari.push.ChannelBannerAuthor
import fr.emse.canari.push.ChannelBannerAuthor.Author
import fr.emse.canari.push.ChannelBannerAuthor.NameBook
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * A salon banner names its SPEAKER from the phone's own copy once the open proved who it is, draws
 * THEIR initials, and keeps the salon's identity only when nothing proved an author (owner,
 * `v1.6.0`, 2026-11-01: a salon banner with no name, no photo and the salon's "G" as a face).
 */
class ChannelBannerAuthorTest {

    private val alice = "A".repeat(64)
    private val book = NameBook.Held { id -> if (id == alice.lowercase()) "Alice Martin" else null }

    @Test
    fun `a proven author the phone holds is named, case-insensitively`() {
        assertEquals(
            Author.Named(alice.lowercase(), "Alice Martin"),
            ChannelBannerAuthor.of(showsMessage = true, authorId = alice) { book },
        )
    }

    @Test
    fun `the disc carries the author's initials, never the salon's`() {
        val named = ChannelBannerAuthor.of(showsMessage = true, authorId = alice) { book }
        assertEquals("Alice Martin", ChannelBannerAuthor.initialsSource(named, "général"))
    }

    @Test
    fun `a proven author the phone cannot name is unnamed with the reason, and draws no salon letter`() {
        val unknown = ChannelBannerAuthor.of(showsMessage = true, authorId = "b".repeat(64)) { book }
        assertEquals(Author.Unnamed("b".repeat(64), "not-in-name-book"), unknown)
        assertEquals("", ChannelBannerAuthor.initialsSource(unknown, "général"))
    }

    @Test
    fun `an unusable name file is named as the reason`() {
        assertEquals(
            Author.Unnamed(alice.lowercase(), "other-account"),
            ChannelBannerAuthor.of(showsMessage = true, authorId = alice) { NameBook.Unusable("other-account") },
        )
    }

    @Test
    fun `an opened banner whose push named nobody is accused, not drawn as the salon`() {
        val nobody = ChannelBannerAuthor.of(showsMessage = true, authorId = null) { book }
        assertEquals(Author.Unnamed("", "no-sender-id"), nobody)
        assertEquals("", ChannelBannerAuthor.initialsSource(nobody, "général"))
    }

    @Test
    fun `a blind banner names no speaker, keeps the salon, and never reads the names`() {
        val blind = ChannelBannerAuthor.of(showsMessage = false, authorId = alice) {
            fail("a blind banner must not read the name file"); book
        }
        assertEquals(Author.Unproven, blind)
        assertEquals("général", ChannelBannerAuthor.initialsSource(blind, "général"))
    }

    @Test
    fun `a blank stored name is no name`() {
        val blank = NameBook.Held { "  " }
        assertEquals(
            Author.Unnamed(alice.lowercase(), "not-in-name-book"),
            ChannelBannerAuthor.of(showsMessage = true, authorId = alice) { blank },
        )
    }
}
