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
}
