package fr.emse.canari

import fr.emse.canari.share.ShareRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A share is untrusted input from another app: what it may make us copy, and how much of it the
 * page will later read into memory.
 */
class ShareRulesTest {
    private val pkg = "fr.emse.canari"

    @Test
    fun aFileMayTakeTheFullCeilingWhenNothingIsKeptYet() {
        assertEquals(ShareRules.MAX_FILE_BYTES, ShareRules.nextFileCeiling(0))
    }

    @Test
    fun theTotalBoundsTheNextFileOnceTheShareIsLarge() {
        val kept = ShareRules.MAX_TOTAL_BYTES - 10
        assertEquals(10L, ShareRules.nextFileCeiling(kept))
    }

    @Test
    fun aFullShareRefusesTheNextFileUnread() {
        assertTrue(ShareRules.nextFileCeiling(ShareRules.MAX_TOTAL_BYTES) <= 0)
    }

    @Test
    fun theCeilingsKeepWhatThePageReadsBounded() {
        assertTrue(ShareRules.MAX_FILE_BYTES <= ShareRules.MAX_TOTAL_BYTES)
        assertTrue(ShareRules.MAX_TOTAL_BYTES <= 300L * 1024 * 1024)
    }

    @Test
    fun ourOwnFileProviderIsRefused() {
        assertTrue(ShareRules.isOwnAuthority("fr.emse.canari.fileprovider", pkg))
        assertTrue(ShareRules.isOwnAuthority("fr.emse.canari", pkg))
        assertTrue(ShareRules.isOwnAuthority("com.other;fr.emse.canari.fileprovider", pkg))
    }

    @Test
    fun aMissingAuthorityIsRefused() {
        assertTrue(ShareRules.isOwnAuthority(null, pkg))
        assertTrue(ShareRules.isOwnAuthority("", pkg))
    }

    @Test
    fun anotherAppsProviderIsAccepted() {
        assertFalse(ShareRules.isOwnAuthority("com.google.android.apps.photos.contentprovider", pkg))
        // A prefix that is not a dot-separated child is someone else's package.
        assertFalse(ShareRules.isOwnAuthority("fr.emse.canarifake.provider", pkg))
    }

    @Test
    fun aUriUnderAGrantWeHoldIsRefused() {
        val grants = listOf("content://com.android.externalstorage.documents/tree/primary%3ADocuments")
        assertTrue(
            ShareRules.coveredByHeldGrant(
                "content://com.android.externalstorage.documents/tree/primary%3ADocuments%2Fsecret.pdf",
                grants
            )
        )
        assertTrue(ShareRules.coveredByHeldGrant(grants[0], grants))
    }

    @Test
    fun aUriOutsideEveryHeldGrantIsAccepted() {
        val grants = listOf("content://com.android.externalstorage.documents/tree/primary%3ADocuments")
        assertFalse(ShareRules.coveredByHeldGrant("content://media/external/images/media/42", grants))
        assertFalse(ShareRules.coveredByHeldGrant("content://media/external/images/media/42", emptyList()))
    }
}
