package fr.emse.canari

import fr.emse.canari.push.throwableSite
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A catch-all's log line says where a throwable came from, never what its message quotes. */
class ThrowableSiteTest {

    @Test
    fun aParseFailureIsNamedByItsClassAndFrameNotByTheInputItQuotes() {
        val thrown = runCatching { JSONObject("{\"text\": \"a secret message") }.exceptionOrNull()!!
        val site = throwableSite(thrown)
        assertTrue(site, site.startsWith("JSONException at "))
        assertFalse(site, site.contains("secret"))
    }

    @Test
    fun aCauseIsNamedByItsClassOnly() {
        val site = throwableSite(IllegalStateException("outer text", IllegalArgumentException("inner text")))
        assertTrue(site, site.endsWith("(cause IllegalArgumentException)"))
        assertFalse(site, site.contains("text"))
    }
}
