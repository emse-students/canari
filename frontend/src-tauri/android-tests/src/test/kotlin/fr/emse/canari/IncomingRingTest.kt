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
        assertEquals(IncomingRing.Plan(sound = false, vibrate = false), IncomingRing.plan(IncomingRing.RINGER_MODE_SILENT, appSounds = true))
    }

    @Test
    fun `vibrate mode only vibrates`() {
        assertEquals(IncomingRing.Plan(sound = false, vibrate = true), IncomingRing.plan(IncomingRing.RINGER_MODE_VIBRATE, appSounds = true))
    }

    @Test
    fun `normal mode sounds and vibrates`() {
        assertEquals(IncomingRing.Plan(sound = true, vibrate = true), IncomingRing.plan(IncomingRing.RINGER_MODE_NORMAL, appSounds = true))
    }

    @Test
    fun `the app's sounds off - normal mode only vibrates`() {
        assertEquals(IncomingRing.Plan(sound = false, vibrate = true), IncomingRing.plan(IncomingRing.RINGER_MODE_NORMAL, appSounds = false))
    }

    @Test
    fun `an unknown ringer mode rings normally - a call is never missed for a new value`() {
        assertEquals(IncomingRing.Plan(sound = true, vibrate = true), IncomingRing.plan(7, appSounds = true))
    }
}
