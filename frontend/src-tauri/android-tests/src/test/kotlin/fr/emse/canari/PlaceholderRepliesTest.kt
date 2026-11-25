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
}
