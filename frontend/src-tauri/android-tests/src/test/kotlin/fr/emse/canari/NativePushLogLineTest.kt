package fr.emse.canari

import fr.emse.canari.push.NativePushLogLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** One line of the push service's own log, as the in-app log takes it (`NativePushLogLine`). */
class NativePushLogLineTest {

    private val utc = ZoneId.of("UTC")

    @Test
    fun `only warnings and errors are recorded - the in-app log keeps no debug`() {
        assertTrue(NativePushLogLine.records('W'))
        assertTrue(NativePushLogLine.records('E'))
        assertFalse(NativePushLogLine.records('I'))
        assertFalse(NativePushLogLine.records('D'))
    }

    @Test
    fun `a line carries the service's own instant, its level and its tag, in the in-app log's stamp shape`() {
        val line = NativePushLogLine.format(0L, 'W', "CanariFCM", "seed absent", null, utc)
        assertEquals("1970-01-01 00:00:00.000 W CanariFCM: seed absent", line)
    }

    @Test
    fun `an exception is named by its class, never by its stack or its message`() {
        val line = NativePushLogLine.format(0L, 'E', "CanariFCM", "decrypt failed", IllegalStateException("secret detail"), utc)
        assertTrue(line.endsWith("decrypt failed (IllegalStateException)"))
        assertFalse(line.contains("secret detail"))
    }

    @Test
    fun `a line break in a message cannot forge a second line`() {
        val line = NativePushLogLine.format(0L, 'W', "CanariFCM", "a\nE CanariFCM: forged", null, utc)
        assertFalse(line.contains('\n'))
    }
}
