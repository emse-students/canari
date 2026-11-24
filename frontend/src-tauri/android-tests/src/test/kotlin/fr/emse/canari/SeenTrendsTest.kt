package fr.emse.canari

import fr.emse.canari.push.SeenTrends
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A campus-trend push for a post this device already displayed shows nothing (owner, 2026-11-24).
 * The rule is held to the shared contract, which the client, the iOS readers and Rust's writer follow
 * too; classification is on the `contentKey`, never on text.
 */
class SeenTrendsTest {

    private val contract = JSONObject(
        File(System.getProperty("user.dir"), "../../../libs/contracts/notification-seen-trend.cases.json").readText(),
    )

    /** The contract's book, parsed the way the service parses the file. */
    private fun bookOf(root: JSONObject): SeenTrends.Book {
        val posts = root.getJSONObject("posts")
        return SeenTrends.Book(root.getString("userId").lowercase(), posts.keys().asSequence().map { it.lowercase() }.toSet())
    }

    @Test
    fun `follows the shared notification-seen-trend contract`() {
        val book = bookOf(contract.getJSONObject("book"))
        val cases = contract.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val me = if (c.isNull("me")) null else c.getString("me")
            val key = if (c.isNull("contentKey")) null else c.getString("contentKey")
            assertEquals(c.getString("name"), c.getBoolean("expected"), SeenTrends.withholds(book, me, key, c.getString("postId")))
        }
        assertTrue("the contract lost its cases", cases.length() > 10)
    }

    @Test
    fun `the trend keys are the contract's`() {
        val keys = contract.getJSONArray("trendKeys")
        val expected = (0 until keys.length()).map { keys.getString(it) }.toSet()
        assertEquals(expected, SeenTrends.TREND_KEYS)
    }

    @Test
    fun `no book withholds nothing`() {
        assertFalse(SeenTrends.withholds(null, "a", "social_campus_trend", "p"))
    }
}
