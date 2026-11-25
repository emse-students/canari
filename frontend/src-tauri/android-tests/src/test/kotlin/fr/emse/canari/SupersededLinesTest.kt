package fr.emse.canari

import fr.emse.canari.push.SupersededLines
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A replay's real line REPLACES the generic placeholder(s) its push left, matched by the instant the
 * placeholder's post handed back - an identity, never the text ([SupersededLines]).
 */
class SupersededLinesTest {

    private val shade = listOf(100L, 200L, 300L, 400L)

    private fun keptUnder(supersedes: Long, also: Set<Long> = emptySet()) =
        shade.filter { SupersededLines.kept(it, supersedes, also) }

    @Test
    fun `a post replacing nothing keeps every line`() {
        assertEquals(shade, keptUnder(0L))
    }

    @Test
    fun `the placeholder a replay names is dropped and nothing else`() {
        assertEquals(listOf(100L, 300L, 400L), keptUnder(200L))
    }

    @Test
    fun `a replay standing for several placeholders drops each of them`() {
        assertEquals(listOf(100L, 400L), keptUnder(200L, setOf(300L)))
    }

    @Test
    fun `naming an instant no line carries drops nothing`() {
        assertEquals(shade, keptUnder(999L, setOf(998L)))
    }

    /**
     * THE REPLAYED LINE TAKES THE PLACEHOLDER'S PLACE. Appended, a message that arrived before two
     * later ones read as the newest of the conversation.
     */
    @Test
    fun `a replacing line goes where the line it replaces was`() {
        assertEquals(1, SupersededLines.insertionIndex(shade, 200L, emptySet(), bound = 10))
        assertEquals(0, SupersededLines.insertionIndex(shade, 100L, emptySet(), bound = 10))
        assertEquals("the first of several replaced lines decides", 1, SupersededLines.insertionIndex(shade, 300L, setOf(200L), bound = 10))
    }

    @Test
    fun `a line that replaces nothing is appended`() {
        assertEquals(null, SupersededLines.insertionIndex(shade, 0L, emptySet(), bound = 10))
        assertEquals(null, SupersededLines.insertionIndex(shade, 999L, emptySet(), bound = 10))
    }

    @Test
    fun `the place counts in the bounded history`() {
        // Kept: 100, 300, 400; the bound keeps the newest two (300, 400) - the replaced 200 sat
        // after 100, which the bound dropped, so the line goes first.
        assertEquals(0, SupersededLines.insertionIndex(shade, 200L, emptySet(), bound = 2))
        // Kept: 100, 200, 300; bound 2 keeps 200, 300; the replaced 400 sat after both.
        assertEquals(2, SupersededLines.insertionIndex(shade, 400L, emptySet(), bound = 2))
    }

    /**
     * A LINE REPLAYED AT ITS PLACE IS NOT THE NEWEST: "Marquer comme lu" carried its older instants
     * and left every line below it unread. The actions carry the newest line's instants then.
     */
    @Test
    fun `a line inserted at its place hands the actions the newest line's instants`() {
        assertEquals(
            900L to 950L,
            SupersededLines.actionInstants(posted = 100L to 150L, newest = 900L to 950L, insertedInPlace = true),
        )
    }

    @Test
    fun `an appended line, or a newest line with no instant, keeps the posted instants`() {
        assertEquals(
            100L to 150L,
            SupersededLines.actionInstants(posted = 100L to 150L, newest = 900L to 950L, insertedInPlace = false),
        )
        assertEquals(
            100L to 150L,
            SupersededLines.actionInstants(posted = 100L to 150L, newest = 0L to 0L, insertedInPlace = true),
        )
        assertEquals(
            100L to 150L,
            SupersededLines.actionInstants(posted = 100L to 150L, newest = null, insertedInPlace = true),
        )
    }
}
