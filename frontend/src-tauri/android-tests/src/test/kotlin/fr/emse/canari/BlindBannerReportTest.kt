package fr.emse.canari

import fr.emse.canari.push.BlindBannerReport
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What a blind salon banner reports (`BlindBannerReport`): the open that never ran says what it
 * lacked, the open that ran says why it refused, and an answer that is never news posts nothing.
 */
class BlindBannerReportTest {

    private val contract by lazy {
        JSONObject(File(System.getProperty("user.dir"), "../../../libs/contracts/blind-banner-terms.json").readText())
    }

    private fun list(key: String): Set<String> =
        contract.getJSONArray(key).let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }

    @Test
    fun `an open that never ran reports what it lacked, and whether the frame waits for its seed`() {
        val report = BlindBannerReport.of(seedHeld = false, openable = true, missing = listOf("seed"), refused = null)
        assertEquals(listOf("seed"), report.missing)
        assertTrue(report.held)
        assertNull(report.refused)
    }

    @Test
    fun `a frame the server did not inline is not held - nothing will redraw it`() {
        val report = BlindBannerReport.of(seedHeld = false, openable = false, missing = listOf("ciphertext"), refused = null)
        assertFalse(report.held)
    }

    @Test
    fun `a held seed with a ciphertext the server did not inline never opened - it says what it lacked`() {
        val report = BlindBannerReport.of(seedHeld = true, openable = false, missing = listOf("ciphertext"), refused = null)
        assertEquals(listOf("ciphertext"), report.missing)
        assertFalse(report.held)
        assertNull(report.refused)
    }

    @Test
    fun `an open that ran reports its refusal and nothing missing`() {
        val report = BlindBannerReport.of(seedHeld = true, openable = true, missing = listOf("seed"), refused = "below-floor")
        assertEquals(emptyList<String>(), report.missing)
        assertFalse(report.held)
        assertEquals("below-floor", report.refused)
    }

    @Test
    fun `an open that ran and named no reason says unstated, never nothing`() {
        assertEquals(BlindBannerReport.UNSTATED, BlindBannerReport.of(true, true, emptyList(), null).refused)
        assertEquals(BlindBannerReport.UNSTATED, BlindBannerReport.of(true, true, emptyList(), "").refused)
    }

    @Test
    fun `a withdrawn reaction and a silenced event post nothing, a refusal posts the generic line`() {
        assertTrue(BlindBannerReport.postsNothing("reaction-withdrawn"))
        assertTrue(BlindBannerReport.postsNothing("silent-event"))
        assertFalse(BlindBannerReport.postsNothing("plaintext-not-renderable"))
        assertFalse(BlindBannerReport.postsNothing(null))
    }

    @Test
    fun `every token this service names is one the server allows, and silence is the contract's`() {
        assertTrue(list("refused").containsAll(BlindBannerReport.OWN_REFUSALS))
        assertEquals(list("silent"), BlindBannerReport.SILENT)
        // A silent answer is never a banner, so it is never a refusal the report could carry.
        assertTrue(BlindBannerReport.SILENT.none { it in list("refused") })
    }
}
