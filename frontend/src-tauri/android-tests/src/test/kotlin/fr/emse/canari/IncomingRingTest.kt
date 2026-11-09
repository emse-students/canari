package fr.emse.canari

import fr.emse.canari.call.IncomingRing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Canari's own incoming ring (owner, 2026-11-01): a new channel id, because a channel's sound is
 * immutable, the old one deleted, and an in-app ring that honours the ringer mode.
 */
class IncomingRingTest {

    @Test
    fun `the calls channel is a new id, and the old one is deleted`() {
        assertEquals("canari_calls_v2", IncomingRing.CHANNEL_ID)
        assertEquals(listOf("canari_calls"), IncomingRing.SUPERSEDED_CHANNEL_IDS)
        assertFalse(IncomingRing.SUPERSEDED_CHANNEL_IDS.contains(IncomingRing.CHANNEL_ID))
    }

    @Test
    fun `the vibration is a valid repeating waveform`() {
        val pattern = IncomingRing.VIBRATION_PATTERN
        assertTrue(pattern.isNotEmpty())
        assertTrue(pattern.all { it >= 0 })
        assertTrue(IncomingRing.VIBRATION_REPEAT_FROM in pattern.indices)
    }

    @Test
    fun `silent mode rings nothing`() {
        assertEquals(IncomingRing.Plan(sound = false, vibrate = false), IncomingRing.plan(IncomingRing.RINGER_MODE_SILENT, appSounds = true, inAnotherCall = false))
    }

    @Test
    fun `vibrate mode only vibrates`() {
        assertEquals(IncomingRing.Plan(sound = false, vibrate = true), IncomingRing.plan(IncomingRing.RINGER_MODE_VIBRATE, appSounds = true, inAnotherCall = false))
    }

    @Test
    fun `normal mode sounds and vibrates`() {
        assertEquals(IncomingRing.Plan(sound = true, vibrate = true), IncomingRing.plan(IncomingRing.RINGER_MODE_NORMAL, appSounds = true, inAnotherCall = false))
    }

    @Test
    fun `the app's sounds off - normal mode only vibrates`() {
        assertEquals(IncomingRing.Plan(sound = false, vibrate = true), IncomingRing.plan(IncomingRing.RINGER_MODE_NORMAL, appSounds = false, inAnotherCall = false))
    }

    @Test
    fun `an unknown ringer mode rings normally - a call is never missed for a new value`() {
        assertEquals(IncomingRing.Plan(sound = true, vibrate = true), IncomingRing.plan(7, appSounds = true, inAnotherCall = false))
    }

    @Test
    fun `another call in progress - the ring only vibrates`() {
        assertEquals(IncomingRing.Plan(sound = false, vibrate = true), IncomingRing.plan(IncomingRing.RINGER_MODE_NORMAL, appSounds = true, inAnotherCall = true))
    }

    @Test
    fun `the new channel keeps the importance the user left on the old one`() {
        assertEquals(0, IncomingRing.inheritedImportance(0)) // NONE stays NONE
        assertEquals(2, IncomingRing.inheritedImportance(2))
        assertEquals(IncomingRing.IMPORTANCE_HIGH, IncomingRing.inheritedImportance(4))
    }

    @Test
    fun `the Do Not Disturb ask - once per launch, dropped once the user granted it by hand`() {
        assertEquals(IncomingRing.DndAsk.NONE, IncomingRing.dndAsk(owed = false, granted = false, askedThisLaunch = false))
        assertEquals(IncomingRing.DndAsk.ASK, IncomingRing.dndAsk(owed = true, granted = false, askedThisLaunch = false))
        // Every later page load of the same launch: nothing.
        assertEquals(IncomingRing.DndAsk.NONE, IncomingRing.dndAsk(owed = true, granted = false, askedThisLaunch = true))
        // The user granted canari_calls_v2 by hand: the debt is paid, whatever this launch did.
        assertEquals(IncomingRing.DndAsk.CLEAR, IncomingRing.dndAsk(owed = true, granted = true, askedThisLaunch = false))
        assertEquals(IncomingRing.DndAsk.CLEAR, IncomingRing.dndAsk(owed = true, granted = true, askedThisLaunch = true))
    }

    @Test
    fun `no old channel, or an unspecified one - HIGH`() {
        assertEquals(IncomingRing.IMPORTANCE_HIGH, IncomingRing.inheritedImportance(null))
        assertEquals(IncomingRing.IMPORTANCE_HIGH, IncomingRing.inheritedImportance(IncomingRing.IMPORTANCE_UNSPECIFIED))
    }
}
