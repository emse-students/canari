package fr.emse.canari

import app.tauri.gallery.UpgradeGeneration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A picture fetched late for a launcher shortcut is pushed only while the set it belongs to is still
 * the published one: a later publish or a sign-out clear makes it stale, and a stale one pushes
 * nothing (docs/wiki/frontend/sharing.md, "the picture of a shortcut").
 */
class UpgradeGenerationTest {

    @Test
    fun `an upgrade of the current generation runs`() {
        val g = UpgradeGeneration()
        val started = g.next()
        assertEquals("pushed", g.runIfCurrent(started) { "pushed" })
    }

    @Test
    fun `a later publish makes the earlier upgrade stale`() {
        val g = UpgradeGeneration()
        val first = g.next()
        val second = g.next()
        assertNotEquals(first, second)
        assertNull(g.runIfCurrent(first) { "pushed" })
        assertEquals("pushed", g.runIfCurrent(second) { "pushed" })
    }

    @Test
    fun `a clear makes the upgrade stale and never runs its block`() {
        val g = UpgradeGeneration()
        val started = g.next()
        g.invalidate()
        var ran = false
        assertNull(g.runIfCurrent(started) { ran = true })
        assertEquals(false, ran)
    }

    @Test
    fun `a publish after a clear starts a fresh generation that runs`() {
        val g = UpgradeGeneration()
        g.next()
        g.invalidate()
        val again = g.next()
        assertEquals(1, g.runIfCurrent(again) { 1 })
    }
}
