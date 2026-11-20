package fr.emse.canari

import fr.emse.canari.push.PushShowOutcome
import fr.emse.canari.push.PushShowOutcome.Outcome
import fr.emse.canari.push.PushShowOutcome.OsState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What one show decision did, and the OS state beside it, as the in-app log records it. */
class PushShowOutcomeTest {

    /** An ordinary phone: notifications on, a HIGH channel, no DND, active, no battery saver. */
    private val open = OsState(true, 4, 1, 10, false)

    @Test
    fun `a post is classified in the order the builder decides its alert`() {
        assertEquals(Outcome.POSTED, PushShowOutcome.posted(alreadyInShade = false, supersedes = false, callHoldsSound = false))
        assertEquals(Outcome.POSTED_SILENT_CALL, PushShowOutcome.posted(false, false, true))
        assertEquals(Outcome.REDRAWN, PushShowOutcome.posted(false, true, true))
        // Already in the shade wins: a refresh is not an announcement a call could silence.
        assertEquals(Outcome.ALREADY_IN_SHADE, PushShowOutcome.posted(true, true, true))
    }

    @Test
    fun `the line carries the outcome, an 8-character id and every OS setting by name`() {
        val line = PushShowOutcome.line(Outcome.POSTED, "0123456789abcdef", "canari_messages_v2", OsState(true, 4, 2, 45, true))
        assertEquals(
            "[PUSH_SHOW] outcome=posted groupId=01234567 channel=canari_messages_v2" +
                " os: enabled=true importance=high dnd=priority bucket=restricted powerSave=true",
            line,
        )
    }

    @Test
    fun `an unread OS state is said as unread, never guessed`() {
        val line = PushShowOutcome.line(Outcome.SUPPRESSED_FOREGROUND, "abc", "c", OsState(null, null, null, null, null))
        assertTrue(line.endsWith("os: enabled=? importance=? dnd=? bucket=? powerSave=?"))
        assertEquals('I', PushShowOutcome.level(Outcome.POSTED, OsState(null, null, null, null, null)))
    }

    @Test
    fun `a post the OS drops is a WARN that says so`() {
        val disabled = open.copy(notificationsEnabled = false)
        val blocked = open.copy(channelImportance = 0)
        for (os in listOf(disabled, blocked)) {
            assertEquals('W', PushShowOutcome.level(Outcome.POSTED, os))
            assertTrue(PushShowOutcome.line(Outcome.POSTED, "g", "c", os).endsWith(" -> the OS drops it"))
        }
    }

    @Test
    fun `every decision by design is a recorded INFO, even with the OS closed`() {
        assertEquals('I', PushShowOutcome.level(Outcome.POSTED, open))
        // A LOW channel still shows it, quietly: the member's choice, reported, not accused.
        assertEquals('I', PushShowOutcome.level(Outcome.POSTED, open.copy(channelImportance = 2)))
        val closed = open.copy(notificationsEnabled = false)
        for (o in listOf(Outcome.SUPPRESSED_FOREGROUND, Outcome.SUPPRESSED_SHADE_MARK, Outcome.SUPPRESSED_ALREADY_ALERTED)) {
            assertFalse(o.posts)
            assertEquals('I', PushShowOutcome.level(o, closed))
            assertFalse(PushShowOutcome.line(o, "g", "c", closed).contains("drops"))
        }
    }

    @Test
    fun `every outcome has its own token`() {
        val tokens = Outcome.entries.map { it.token }
        assertEquals(tokens.size, tokens.toSet().size)
        assertEquals(
            listOf(
                "posted", "posted-silent-call", "already-in-shade", "redrawn",
                "suppressed-foreground", "suppressed-shade-mark", "suppressed-already-alerted",
            ),
            tokens,
        )
    }

    @Test
    fun `the recorded INFO level is formatted like the others, but never passes the plain gate`() {
        assertFalse(fr.emse.canari.push.NativePushLogLine.records('I'))
        val line = fr.emse.canari.push.NativePushLogLine.format(0L, 'I', "CanariFCM", "[PUSH_SHOW] outcome=posted", null, java.time.ZoneId.of("UTC"))
        assertEquals("1970-01-01 00:00:00.000 I CanariFCM: [PUSH_SHOW] outcome=posted", line)
    }
}
