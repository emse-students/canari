package fr.emse.canari

import fr.emse.canari.push.RepostAlert
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * One message is announced once, including when its re-draw is a new post: the held salon mention,
 * blind on the ordinary channel and redrawn on the mention one, or a blind banner swiped away before
 * its seed landed.
 */
class RepostAlertTest {

    @Test
    fun `a first announcement alerts, whatever is in the shade`() {
        for (switches in listOf(false, true)) for (existing in listOf(false, true)) {
            assertEquals(RepostAlert.Mode.ALERT, RepostAlert.of(redraw = false, switchesChannel = switches, hasExistingPost = existing))
        }
    }

    @Test
    fun `a re-draw in place alerts only once`() {
        assertEquals(RepostAlert.Mode.ONLY_ONCE, RepostAlert.of(redraw = true, switchesChannel = false, hasExistingPost = true))
    }

    @Test
    fun `a re-draw that cancels and reposts on another channel is silent`() {
        assertEquals(RepostAlert.Mode.SILENT, RepostAlert.of(redraw = true, switchesChannel = true, hasExistingPost = true))
    }

    @Test
    fun `a re-draw of a banner the reader swiped away is silent`() {
        assertEquals(RepostAlert.Mode.SILENT, RepostAlert.of(redraw = true, switchesChannel = false, hasExistingPost = false))
    }
}
