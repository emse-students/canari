package fr.emse.canari

import fr.emse.canari.push.FixedNotifIds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** A conversation's notification id never lands on a fixed one, however many conversations came first. */
class FixedNotifIdsTest {

    @Test
    fun `an ordinary id is kept as it is`() {
        assertEquals(1000, FixedNotifIds.skipReserved(1000))
        assertEquals(9994, FixedNotifIds.skipReserved(9994))
    }

    @Test
    fun `the counter steps over the whole fixed block`() {
        assertEquals(10_000, FixedNotifIds.skipReserved(9995))
        assertEquals(10_000, FixedNotifIds.skipReserved(9999))
        assertEquals(FixedNotifIds.CALL_FOREGROUND + 1, FixedNotifIds.skipReserved(FixedNotifIds.CALL_FOREGROUND))
    }

    @Test
    fun `walking the counter from its start never hands out a fixed id`() {
        var counter = 1000
        repeat(60_000) {
            val id = FixedNotifIds.skipReserved(counter)
            assertFalse("handed out $id", id in FixedNotifIds.ALL)
            counter = id + 1
        }
    }
}
