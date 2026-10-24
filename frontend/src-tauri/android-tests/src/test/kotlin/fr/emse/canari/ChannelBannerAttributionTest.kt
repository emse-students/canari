package fr.emse.canari

import fr.emse.canari.push.ChannelBannerAttribution
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A salon banner draws an author and a mention only once the open proved them: the push's
 * `senderId` and `mentioned` are the server's words, and a blind banner (no seed, no ciphertext, a
 * refused open) shows the generic line with neither.
 */
class ChannelBannerAttributionTest {

    @Test
    fun `a blind banner names no author and no mention, whatever the server said`() {
        assertEquals(
            ChannelBannerAttribution.Attribution(authorId = null, mentionsMe = false),
            ChannelBannerAttribution.of(showsMessage = false, senderId = "alice", serverSaysMentioned = true),
        )
    }

    @Test
    fun `an opened banner draws the author it proved and the mention`() {
        assertEquals(
            ChannelBannerAttribution.Attribution(authorId = "alice", mentionsMe = true),
            ChannelBannerAttribution.of(showsMessage = true, senderId = "alice", serverSaysMentioned = true),
        )
        assertEquals(
            ChannelBannerAttribution.Attribution(authorId = "alice", mentionsMe = false),
            ChannelBannerAttribution.of(showsMessage = true, senderId = "alice", serverSaysMentioned = false),
        )
    }

    @Test
    fun `an opened banner without a sender draws the salon's initials`() {
        assertEquals(
            ChannelBannerAttribution.Attribution(authorId = null, mentionsMe = false),
            ChannelBannerAttribution.of(showsMessage = true, senderId = "", serverSaysMentioned = false),
        )
    }
}
