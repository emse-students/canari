package fr.emse.canari

import fr.emse.canari.share.SharedFileName
import org.junit.Assert.assertEquals
import org.junit.Test

/** A shared file's name comes from another app; these are the ways it could escape or vanish. */
class SharedFileNameTest {
    @Test
    fun keepsAnOrdinaryName() {
        assertEquals("IMG_0001.jpg", SharedFileName.sanitise("IMG_0001.jpg", "image/jpeg"))
    }

    @Test
    fun keepsOnlyTheLastPathSegment() {
        assertEquals("mls.bin", SharedFileName.sanitise("../../files/mls.bin", "application/octet-stream"))
        assertEquals("x.pdf", SharedFileName.sanitise("C:\\Users\\a\\x.pdf", "application/pdf"))
    }

    @Test
    fun replacesCharactersOutsideTheSafeSet() {
        assertEquals("r_sum_ _1_.pdf", SharedFileName.sanitise("résumé (1).pdf", "application/pdf"))
    }

    @Test
    fun dropsLeadingDotsSoNoHiddenNameRemains() {
        assertEquals("profile", SharedFileName.sanitise("..profile", "text/plain"))
    }

    @Test
    fun capsTheLength() {
        assertEquals(100, SharedFileName.sanitise("a".repeat(300), "text/plain").length)
    }

    @Test
    fun makesAGenericNameFromTheMimeWhenNothingIsLeft() {
        assertEquals("shared.png", SharedFileName.sanitise(null, "image/png"))
        assertEquals("shared.vnd", SharedFileName.sanitise("..", "application/vnd.ms-excel"))
        assertEquals("shared.bin", SharedFileName.sanitise("", "application"))
    }
}
