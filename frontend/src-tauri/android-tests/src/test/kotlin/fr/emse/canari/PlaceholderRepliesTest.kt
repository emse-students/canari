package fr.emse.canari

import fr.emse.canari.push.PlaceholderReplies
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * No smart reply to "Nouveau message": when the newest line is a placeholder, the system may neither
 * generate replies nor contextual actions from it ([PlaceholderReplies]). The reply and mark-read
 * actions themselves are added either way; these flags only gate what the system suggests.
 */
class PlaceholderRepliesTest {

    @Test
    fun `a placeholder as the newest line allows no generated reply and no contextual action`() {
        assertEquals(
            PlaceholderReplies.Flags(generatedReplies = false, systemContextualActions = false),
            PlaceholderReplies.of(newestIsPlaceholder = true),
        )
    }

    @Test
    fun `a real message as the newest line keeps the suggestions`() {
        assertEquals(
            PlaceholderReplies.Flags(generatedReplies = true, systemContextualActions = true),
            PlaceholderReplies.of(newestIsPlaceholder = false),
        )
    }

    private fun line(placeholder: Boolean = false, own: Boolean = false) = PlaceholderReplies.Line(placeholder, own)

    @Test
    fun `the newest line decides`() {
        assertEquals(true, PlaceholderReplies.newestIsPlaceholder(listOf(line(), line(placeholder = true))))
        assertEquals(false, PlaceholderReplies.newestIsPlaceholder(listOf(line(placeholder = true), line())))
        assertEquals(false, PlaceholderReplies.newestIsPlaceholder(emptyList()))
    }

    /**
     * THIS ACCOUNT'S OWN LINES ARE SKIPPED. A pending reply drawn under a placeholder is the newest
     * line, but the suggestions answer the other side - whose newest line is still the placeholder.
     */
    @Test
    fun `own and pending lines are skipped when looking for the newest line`() {
        assertEquals(true, PlaceholderReplies.newestIsPlaceholder(listOf(line(placeholder = true), line(own = true))))
        assertEquals(false, PlaceholderReplies.newestIsPlaceholder(listOf(line(), line(own = true))))
        assertEquals(false, PlaceholderReplies.newestIsPlaceholder(listOf(line(own = true))))
    }
}
