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
            // Every end is NAMED, and the name is the contract's: the log says which one was reached.
            assertEquals(c.getString("name"), c.getString("reason"), SeenTrends.decide(book, me, key, c.getString("postId")).reason)
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
    fun `no book withholds nothing, and says so`() {
        assertFalse(SeenTrends.withholds(null, "a", "social_campus_trend", "p"))
        assertEquals(SeenTrends.Verdict.NO_RECORD, SeenTrends.decide(null, "a", "social_campus_trend", "p"))
    }

    @Test
    fun `a trend that names no post is named as such, whatever the record`() {
        // 1.8.3-alpha.1 on the Mi 9T: the server's trend push carried no postId and the rule answered a
        // bare false. The verdict that accuses the payload must win over a missing record.
        for (postId in listOf(null, "", "  ")) {
            assertEquals(SeenTrends.Verdict.NO_POST_ID, SeenTrends.decide(null, "a", "social_campus_trend", postId))
        }
    }

    @Test
    fun `only a withheld verdict withholds`() {
        assertEquals(listOf(SeenTrends.Verdict.WITHHELD), SeenTrends.Verdict.entries.filter { it.withheld })
    }
}
