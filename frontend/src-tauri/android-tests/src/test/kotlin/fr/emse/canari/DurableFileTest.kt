package fr.emse.canari

import fr.emse.canari.push.DurableFile
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE OUTBOX MIRROR IS REPLACED, NEVER TRUNCATED IN PLACE (review of #3929): a power loss between a
 * truncate and its write emptied the queue. The text goes to a temp file, synced, renamed over.
 */
class DurableFileTest {
    private fun dir(): File = Files.createTempDirectory("durable").toFile()

    @Test
    fun `replaces the file whole and leaves no temp file behind`() {
        val d = dir()
        val mirror = File(d, "outbox_pending.ndjson").apply { writeText("old\n") }
        DurableFile.replace(mirror, "new\n")
        assertEquals("new\n", mirror.readText())
        assertEquals(listOf("outbox_pending.ndjson"), d.list()!!.toList())
    }

    @Test
    fun `a null text deletes the file`() {
        val d = dir()
        val mirror = File(d, "outbox_pending.ndjson").apply { writeText("old\n") }
        DurableFile.replace(mirror, null)
        assertFalse(mirror.exists())
        // Deleting what is not there is no failure.
        DurableFile.replace(mirror, null)
    }

    @Test
    fun `a replacement that cannot land leaves the file as it was`() {
        val d = dir()
        val mirror = File(d, "outbox_pending.ndjson").apply { writeText("old\n") }
        // The temp name is taken by a directory: the write fails before anything is renamed.
        assertTrue(File(d, "outbox_pending.ndjson.tmp").mkdir())
        val failed = runCatching { DurableFile.replace(mirror, "new\n") }.isFailure
        assertTrue(failed)
        assertEquals("old\n", mirror.readText())
    }
}
