package fr.emse.canari

import fr.emse.canari.push.ChannelBannerAuthor
import fr.emse.canari.push.ChannelBannerAuthor.Author
import fr.emse.canari.push.ChannelBannerAuthor.NameBook
import fr.emse.canari.push.ConversationNicknames
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A notification names a member by the nickname set in THAT conversation, composed by the device
 * (owner, 2026-11-14: "comme sur Messenger, tous les pseudos"). The lookup is held to the shared
 * contract, which the client, the iOS readers and Rust's writer follow too; and a salon's speaker
 * takes the nickname only for a proven author.
 */
class ConversationNicknamesTest {

    /** The contract's book, parsed the way the service parses the file. */
    private fun bookOf(root: JSONObject): ConversationNicknames.Book {
        val scopes = HashMap<String, Map<String, String>>()
        val all = root.getJSONObject("scopes")
        for (scope in all.keys()) {
            val members = all.getJSONObject(scope)
            scopes[scope] = members.keys().asSequence()
                .mapNotNull { id -> members.optString(id).takeIf { it.isNotBlank() }?.let { id to it } }
                .toMap()
        }
        val channels = HashMap<String, String>()
        val placed = root.getJSONObject("channels")
        for (id in placed.keys()) channels[id] = placed.getString(id)
        return ConversationNicknames.Book(root.getString("userId").lowercase(), scopes, channels)
    }

    @Test
    fun `follows the shared notification-nickname contract`() {
        val file = File(System.getProperty("user.dir"), "../../../libs/contracts/notification-nickname.cases.json")
        val contract = JSONObject(file.readText())
        val book = bookOf(contract.getJSONObject("book"))
        val cases = contract.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val me = if (c.isNull("me")) null else c.getString("me")
            val expected = if (c.isNull("expected")) null else c.getString("expected")
            val got = ConversationNicknames.of(
                book, me, c.getString("kind") == "salon", c.getString("conversation"), c.getString("member"),
            )
            assertEquals(c.getString("name"), expected, got)
        }
        assertTrue("the contract lost its cases", cases.length() > 10)
    }

    @Test
    fun `no book names nobody`() {
        assertEquals(null, ConversationNicknames.of(null, "a", false, "g", "b"))
    }

    private val alice = "a".repeat(64)
    private val names = NameBook.Held { id -> if (id == alice) "Alice Martin" else null }

    @Test
    fun `a proven salon author is named by their nickname before their profile name`() {
        val author = ChannelBannerAuthor.of(true, true, alice.uppercase(), nickname = { if (it == alice) "La Prez" else null }) { names }
        assertEquals(Author.Named(alice, "La Prez"), author)
        // No nickname: the profile name, as before.
        assertEquals(Author.Named(alice, "Alice Martin"), ChannelBannerAuthor.of(true, true, alice, nickname = { null }) { names })
    }

    @Test
    fun `an unproven author gets no nickname either - it is still a name`() {
        val author = ChannelBannerAuthor.of(true, false, alice, nickname = { "La Prez" }) { names }
        assertEquals(Author.Unnamed(alice, "v1-session"), author)
        assertEquals(Author.Unproven, ChannelBannerAuthor.of(false, true, alice, nickname = { "La Prez" }) { names })
    }

    @Test
    fun `a nickname names a proven author even when the profile names are unusable`() {
        val author = ChannelBannerAuthor.of(true, true, alice, nickname = { "La Prez" }) { NameBook.Unusable("no-name-file") }
        assertEquals(Author.Named(alice, "La Prez"), author)
    }
}
