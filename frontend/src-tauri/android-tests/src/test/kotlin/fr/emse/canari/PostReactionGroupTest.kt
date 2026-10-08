package fr.emse.canari

import fr.emse.canari.push.PostReactionGroup
import fr.emse.canari.push.PostReactionGroup.Actor
import fr.emse.canari.push.PostReactionGroup.Shape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Six reactions to one post were six faceless notifications (user, 2026-10-08). One notification per
 * post now says "A, B and N others" with up to three faces; these pin the pure half of that.
 */
class PostReactionGroupTest {

    private fun actor(n: Int) = Actor("id$n", "Name$n")
    private fun ledger(n: Int) =
        (1..n).fold(emptyList<Actor>()) { l, i -> PostReactionGroup.add(l, actor(i)) }

    @Test
    fun `the sentence names the newest first and counts the rest`() {
        assertNull(PostReactionGroup.shape(emptyList()))
        assertEquals(Shape.One(actor(1)), PostReactionGroup.shape(ledger(1)))
        assertEquals(Shape.Two(actor(2), actor(1)), PostReactionGroup.shape(ledger(2)))
        assertEquals(Shape.Three(actor(3), actor(2), actor(1)), PostReactionGroup.shape(ledger(3)))
        assertEquals(Shape.Many(actor(6), actor(5), 4), PostReactionGroup.shape(ledger(6)))
    }

    @Test
    fun `four people read as two names and two others, never one other`() {
        assertEquals(Shape.Many(actor(4), actor(3), 2), PostReactionGroup.shape(ledger(4)))
    }

    @Test
    fun `a person who reacts again is moved to the end, not listed twice`() {
        val again = PostReactionGroup.add(ledger(3), actor(1))
        assertEquals(listOf(actor(2), actor(3), actor(1)), again)
    }

    @Test
    fun `an actor with no id is told apart by name`() {
        val a = Actor("", "Ana")
        val b = Actor("", "Ben")
        assertEquals(listOf(a, b), PostReactionGroup.add(PostReactionGroup.add(emptyList(), a), b))
        assertEquals(listOf(b, a), PostReactionGroup.add(listOf(a, b), a))
    }

    @Test
    fun `at most three faces are drawn, newest first`() {
        assertEquals(listOf(actor(6), actor(5), actor(4)), PostReactionGroup.faces(ledger(6)))
        assertEquals(listOf(actor(1)), PostReactionGroup.faces(ledger(1)))
    }

    @Test
    fun `the ledger is bounded`() {
        val big = ledger(PostReactionGroup.MAX_ACTORS + 5)
        assertEquals(PostReactionGroup.MAX_ACTORS, big.size)
        assertEquals(actor(PostReactionGroup.MAX_ACTORS + 5), big.last())
    }

    @Test
    fun `it survives its own encoding, and a damaged line is dropped`() {
        val l = listOf(Actor("a", "Zoe\tTab"), Actor("", "NoId"))
        assertEquals(
            listOf(Actor("a", "Zoe Tab"), Actor("", "NoId")),
            PostReactionGroup.decode(PostReactionGroup.encode(l))
        )
        assertEquals(listOf(Actor("x", "Y")), PostReactionGroup.decode("garbage\nx\tY"))
        assertEquals(emptyList<Actor>(), PostReactionGroup.decode(null))
    }
}
