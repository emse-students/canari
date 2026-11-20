package fr.emse.canari

import fr.emse.canari.push.ReadElsewhereMarks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The read-elsewhere record a post is checked against ([ReadElsewhereMarks]).
 *
 * The race it closes (review of #3912, 2026-11-20): the WebView's post of a message is
 * asynchronous before it reaches Kotlin, so the read covering it can be handed over FIRST. A bare
 * cancel then removed nothing, and the post that followed put up a banner for a message already
 * read, for good. With the record, the dismissal leaves the mark behind and the late post is
 * refused - whichever arrived first.
 */
class ReadElsewhereMarksTest {

    @Test
    fun `a post that resolves after the dismissal is covered and is not posted`() {
        val marks = ReadElsewhereMarks()
        // The dismissal lands first...
        marks.record("g1", at = 2_000L, serverClock = true)
        // ...then the post of the message it read arrives.
        assertTrue(marks.covers("g1", sentAt = 1_990L, serverAt = 2_000L))
        assertTrue(marks.covers("g1", sentAt = 1_000L, serverAt = 1_500L))
    }

    @Test
    fun `a message newer than the mark is still posted`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", at = 2_000L, serverClock = true)
        assertFalse(marks.covers("g1", sentAt = 2_100L, serverAt = 2_001L))
    }

    @Test
    fun `another conversation is untouched`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", at = 2_000L, serverClock = true)
        assertFalse(marks.covers("g2", sentAt = 1L, serverAt = 1L))
        assertNull(marks.of("g2"))
    }

    @Test
    fun `the server clock decides when both sides carry it, the stamped one otherwise`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", at = 5_000L, serverClock = false)
        marks.record("g1", at = 2_000L, serverClock = true)
        // Server clocks compared: 3_000 is above the server mark, whatever the sender stamped.
        assertFalse(marks.covers("g1", sentAt = 1_000L, serverAt = 3_000L))
        // No server instant on the message: the stamped clock answers.
        assertTrue(marks.covers("g1", sentAt = 4_000L, serverAt = 0L))
        // A salon mark is stamped only: a message with both clocks is read on the stamped one.
        marks.record("channel_c1", at = 300L, serverClock = false)
        assertTrue(marks.covers("channel_c1", sentAt = 300L, serverAt = 900L))
        assertFalse(marks.covers("channel_c1", sentAt = 301L, serverAt = 100L))
    }

    @Test
    fun `a message comparable on neither clock is posted - a lost banner is a lost message`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", at = 2_000L, serverClock = true)
        assertFalse(marks.covers("g1", sentAt = 1_000L, serverAt = 0L))
    }

    @Test
    fun `a mark only rises, and an empty id or a non-positive instant records nothing`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", at = 2_000L, serverClock = true)
        marks.record("g1", at = 1_000L, serverClock = true)
        marks.record("g1", at = 0L, serverClock = false)
        marks.record("", at = 9_000L, serverClock = true)
        assertEquals(ReadElsewhereMarks.Mark(stamped = 0L, server = 2_000L), marks.of("g1"))
        assertNull(marks.of(""))
    }
}
