package fr.emse.canari

import app.tauri.gallery.CameraPermissionAnswer
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * THE CAMERA PERMISSION THE PAGE IS TOLD (Mi 9T, `1.7.0-alpha.2`): the WebView reports a refused
 * permission as the error of a busy camera, so the page asks the plugin, which answers one of
 * three states - or `unknown`, never a guess.
 */
class CameraPermissionAnswerTest {
    @Test
    fun `the three states the OS reports map to themselves`() {
        assertEquals("granted", CameraPermissionAnswer.of("granted"))
        assertEquals("denied", CameraPermissionAnswer.of("denied"))
        assertEquals("prompt", CameraPermissionAnswer.of("prompt"))
    }

    @Test
    fun `a refused-once permission that may be asked again is a prompt`() {
        assertEquals("prompt", CameraPermissionAnswer.of("prompt-with-rationale"))
    }

    @Test
    fun `no state, or one this build does not know, is unknown and never a refusal`() {
        assertEquals("unknown", CameraPermissionAnswer.of(null))
        assertEquals("unknown", CameraPermissionAnswer.of("revoked"))
    }
}
