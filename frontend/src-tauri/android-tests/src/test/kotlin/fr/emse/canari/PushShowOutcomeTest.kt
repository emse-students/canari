package fr.emse.canari

import fr.emse.canari.push.ConversationRef
import fr.emse.canari.push.NativePushLogLine
import fr.emse.canari.push.PushShowOutcome
import fr.emse.canari.push.PushShowOutcome.OsState
import fr.emse.canari.push.PushShowOutcome.Outcome
import fr.emse.canari.push.ReadElsewhereMarks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** How one visible message push ended, and the OS state beside it, as the in-app log records it. */
class PushShowOutcomeTest {

    /** An ordinary phone: notifications on, not paused, a HIGH channel, no DND, active, no saver. */
    private val open = OsState(true, false, 4, 1, 10, false)

    @Test
    fun `a post is classified in the order the builder decides its alert`() {
        assertEquals(Outcome.POSTED, PushShowOutcome.posted(alreadyInShade = false, supersedes = false, callHoldsSound = false))
        assertEquals(Outcome.POSTED_SILENT_CALL, PushShowOutcome.posted(false, false, true))
        assertEquals(Outcome.REDRAWN, PushShowOutcome.posted(false, true, true))
        // Already in the shade wins: a refresh is not an announcement a call could silence.
        assertEquals(Outcome.ALREADY_IN_SHADE, PushShowOutcome.posted(true, true, true))
    }

    @Test
    fun `a second trigger of one message and a read that touched no banner stay in logcat`() {
        val logcatOnly = setOf(
            Outcome.ALREADY_IN_SHADE,
            Outcome.SUPPRESSED_ALREADY_ALERTED,
            Outcome.READ_NO_BANNER,
            Outcome.WITHDRAW_NONE,
            Outcome.DELIVERY_NONE,
        )
        assertEquals(logcatOnly, Outcome.entries.filter { !it.recorded }.toSet())
        assertTrue(Outcome.POSTED.recorded && Outcome.REDRAWN.recorded && Outcome.THREW.recorded)
    }

    @Test
    fun `the line carries the outcome, the conversation and every OS setting by name`() {
        val line = PushShowOutcome.line(Outcome.POSTED, "0123456789abcdef", "canari_messages_v2", OsState(true, false, 4, 2, 45, true))
        assertEquals(
            "[PUSH_SHOW] outcome=posted conv=g:01234567 channel=canari_messages_v2" +
                " os: enabled=true paused=false importance=high dnd=priority bucket=restricted powerSave=true",
            line,
        )
    }

    @Test
    fun `a salon is named by its own id, not by the prefix every salon shares`() {
        assertEquals("ch:9f8e7d6c", PushShowOutcome.conversationRef("channel_9f8e7d6c5b4a"))
        assertEquals("g:01234567", PushShowOutcome.conversationRef("0123456789"))
        assertEquals("?", PushShowOutcome.conversationRef(null))
        assertEquals("?", PushShowOutcome.conversationRef(""))
    }

    @Test
    fun `a reason is appended on one line, and an unread OS state is said as unread`() {
        val line = PushShowOutcome.line(Outcome.WITHHELD_LEVEL, "abc", null, OsState.UNREAD, "cached=true level=mentions\nforged")
        assertTrue(line.contains("channel=? os: enabled=? paused=? importance=? dnd=? bucket=? powerSave=?"))
        assertTrue(line.endsWith(" why: cached=true level=mentions forged"))
        assertEquals('I', PushShowOutcome.level(Outcome.POSTED, OsState.UNREAD))
    }

    @Test
    fun `a post the OS drops is a WARN that says so - switch off, paused, or channel blocked`() {
        val dropping = listOf(
            open.copy(notificationsEnabled = false),
            open.copy(paused = true),
            open.copy(channelImportance = 0),
        )
        for (os in dropping) {
            assertEquals('W', PushShowOutcome.level(Outcome.POSTED, os))
            assertTrue(PushShowOutcome.line(Outcome.POSTED, "g", "c", os).endsWith(" -> the OS drops it"))
        }
    }

    @Test
    fun `every end by design is a recorded INFO, even with the OS closed`() {
        assertEquals('I', PushShowOutcome.level(Outcome.POSTED, open))
        // A LOW channel still shows it, quietly: the member's choice, reported, not accused.
        assertEquals('I', PushShowOutcome.level(Outcome.POSTED, open.copy(channelImportance = 2)))
        val closed = open.copy(notificationsEnabled = false)
        for (o in Outcome.entries.filter { !it.posts && it != Outcome.THREW }) {
            assertEquals('I', PushShowOutcome.level(o, closed))
            assertFalse(PushShowOutcome.line(o, "g", "c", closed).contains("drops"))
        }
    }

    @Test
    fun `only a visible message, salon or reaction records at the foreground guard`() {
        assertTrue(PushShowOutcome.guardedAnnouncement("message", false, silent = false, isWelcome = false))
        assertTrue(PushShowOutcome.guardedAnnouncement("channel", false, false, false))
        assertTrue(PushShowOutcome.guardedAnnouncement("social", true, false, false))
        // Silent frames (a level-`none` conversation is sent silent) and a welcome announce nothing.
        assertFalse(PushShowOutcome.guardedAnnouncement("message", false, silent = true, isWelcome = false))
        assertFalse(PushShowOutcome.guardedAnnouncement("message", false, false, isWelcome = true))
        assertFalse(PushShowOutcome.guardedAnnouncement("welcome_request_pending", false, false, false))
        assertFalse(PushShowOutcome.guardedAnnouncement(null, false, false, false))
    }

    @Test
    fun `every read-elsewhere decision has its own recorded outcome`() {
        val reads = ReadElsewhereMarks.ReadOutcome.entries.map { PushShowOutcome.of(it) }
        val withdrawals = ReadElsewhereMarks.Withdrawal.entries.map { PushShowOutcome.of(it) }
        val deliveries = ReadElsewhereMarks.Delivery.entries.map { PushShowOutcome.of(it) }
        val all = reads + withdrawals + deliveries
        assertEquals("one outcome per decision", all.size, all.toSet().size)
        assertTrue(all.none { it.posts })
        assertEquals(setOf(Outcome.READ_NO_BANNER, Outcome.WITHDRAW_NONE, Outcome.DELIVERY_NONE), all.filter { !it.recorded }.toSet())
        assertEquals(Outcome.READ_PENDING_ONLY, PushShowOutcome.of(ReadElsewhereMarks.ReadOutcome.PENDING_ONLY))
        assertEquals(Outcome.WITHDRAW_KEPT_PENDING_REPLY, PushShowOutcome.of(ReadElsewhereMarks.Withdrawal.KEPT_PENDING_REPLY))
        assertEquals(Outcome.DELIVERY_KEPT_UNTIL_READ, PushShowOutcome.of(ReadElsewhereMarks.Delivery.KEPT_UNTIL_READ))
        assertEquals("suppressed-read-elsewhere", Outcome.SUPPRESSED_READ_ELSEWHERE.token)
        assertEquals("suppressed-seen-trend", Outcome.SUPPRESSED_SEEN_TREND.token)
        assertTrue(Outcome.SUPPRESSED_SEEN_TREND.recorded && !Outcome.SUPPRESSED_SEEN_TREND.posts)
    }

    @Test
    fun `the line names a conversation the way every other log line does`() {
        for (id in listOf(null, "", "channel_9f8e7d6c5b4a", "0123456789")) {
            assertEquals(ConversationRef.of(id), PushShowOutcome.conversationRef(id))
        }
    }

    @Test
    fun `the OS is read only for a recorded post, the one line whose verdict it decides`() {
        assertEquals(
            setOf(Outcome.POSTED, Outcome.POSTED_SILENT_CALL, Outcome.REDRAWN),
            Outcome.entries.filter { PushShowOutcome.readsOs(it) }.toSet(),
        )
        assertEquals(
            "[PUSH_SHOW] outcome=suppressed-read-elsewhere conv=g:01234567 channel=? os: not read why: early",
            PushShowOutcome.line(Outcome.SUPPRESSED_READ_ELSEWHERE, "0123456789", null, null, "early"),
        )
        assertEquals('I', PushShowOutcome.level(Outcome.POSTED, null))
    }

    @Test
    fun `an exception that escaped the post section is an ERROR line`() {
        assertEquals('E', PushShowOutcome.level(Outcome.THREW, null))
        assertEquals('E', PushShowOutcome.level(Outcome.THREW, open))
        assertFalse(Outcome.THREW.posts)
    }

    @Test
    fun `a salon named by its bare id reads as the same reference as its key`() {
        assertEquals(ConversationRef.of("channel_9f8e7d6c5b4a"), ConversationRef.ofSalon("9f8e7d6c5b4a"))
        assertEquals("ch:9f8e7d6c", ConversationRef.ofSalon("channel_9f8e7d6c5b4a"))
        assertEquals("?", ConversationRef.ofSalon(null))
    }

    @Test
    fun `every outcome has its own token`() {
        val tokens = Outcome.entries.map { it.token }
        assertEquals(tokens.size, tokens.toSet().size)
    }

    @Test
    fun `the recorded INFO level is formatted like the others, but never passes the plain gate`() {
        assertFalse(NativePushLogLine.records('I'))
        val line = NativePushLogLine.format(0L, 'I', "CanariFCM", "[PUSH_SHOW] outcome=posted", null, ZoneId.of("UTC"))
        assertEquals("1970-01-01 00:00:00.000 I CanariFCM: [PUSH_SHOW] outcome=posted", line)
    }
}
