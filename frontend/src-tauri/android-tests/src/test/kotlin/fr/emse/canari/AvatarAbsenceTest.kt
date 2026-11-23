package fr.emse.canari

import app.tauri.gallery.AvatarAbsence
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE REMEMBERED "NO PHOTO" YIELDS TO THE FACT (Mi 9T, `1.8.0-alpha.1`): three contacts had photos
 * and `avatar-presence` said so, yet their launcher shortcuts kept initials for 24 h because a 404
 * learned before the upload was still honoured.
 */
class AvatarAbsenceTest {
    private fun marker(): File = File.createTempFile("avatar_x", ".absent").also { it.deleteOnExit() }

    @Test
    fun `a marker is dropped when presence says a photo exists`() {
        val m = marker()

        assertEquals(AvatarAbsence.Outcome.DROPPED, AvatarAbsence.yieldToPresence(m, true))

        assertFalse("the marker is gone, so the cache reads a miss and the picture is fetched", m.exists())
    }

    @Test
    fun `a marker stays when the page does not claim a photo`() {
        val m = marker()

        assertEquals(AvatarAbsence.Outcome.NOT_CLAIMED, AvatarAbsence.yieldToPresence(m, false))

        assertTrue("not knowing is not a refutation", m.exists())
    }

    @Test
    fun `no marker and a known photo is a quiet no-op the caller names`() {
        val m = marker().also { it.delete() }

        assertEquals(AvatarAbsence.Outcome.NO_MARKER, AvatarAbsence.yieldToPresence(m, true))
    }
}
