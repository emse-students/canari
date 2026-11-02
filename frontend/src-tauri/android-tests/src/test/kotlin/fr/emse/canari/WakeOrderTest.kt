package fr.emse.canari

import fr.emse.canari.push.WakeOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** The wake-up reorder buffer: fetches complete in any order, frames are released in delivery order. */
class WakeOrderTest {

    @Test
    fun `a later fetch that returns first waits for the earlier one`() {
        val order = WakeOrder()
        val released = mutableListOf<String>()
        val a = order.take()
        val b = order.take()
        val c = order.take()
        assertEquals(0, order.complete(c, { released += "c" }) { it() })
        assertEquals(0, order.complete(b, { released += "b" }) { it() })
        assertEquals(emptyList<String>(), released)
        assertEquals(3, order.complete(a, { released += "a" }) { it() })
        assertEquals(listOf("a", "b", "c"), released)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `an in-order completion is released at once`() {
        val order = WakeOrder()
        val released = mutableListOf<Int>()
        repeat(3) { i ->
            val t = order.take()
            assertEquals(1, order.complete(t, { released += i }) { it() })
        }
        assertEquals(listOf(0, 1, 2), released)
    }

    @Test
    fun `a ticket cannot complete twice or before it is handed out`() {
        val order = WakeOrder()
        val t = order.take()
        order.take()
        order.complete(t + 1, {}) { it() }
        assertThrows(IllegalArgumentException::class.java) { order.complete(t + 1, {}) { it() } }
        assertThrows(IllegalArgumentException::class.java) { order.complete(t + 5, {}) { it() } }
    }
}
