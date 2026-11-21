package fr.emse.canari.push

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/**
 * A WRITE THAT SURVIVES A POWER LOSS - the ONE way Kotlin replaces a file whose loss is a message
 * lost (the outbox mirror, `outbox_pending.ndjson`).
 *
 * `File.writeText` truncates the file and then writes it: a power loss between the two leaves an
 * empty or half mirror, and every queued send in it gone (principle 2, the essential is never
 * lost). So the text goes to `<name>.tmp`, is synced to the disk, is RENAMED over the file - a
 * rename is atomic, so a reader sees the old file or the new one, never a mix - and the directory
 * is synced so the rename itself is on the disk. Rust's `outbox_mirror::write_durably` is the twin.
 *
 * Compiled by the JVM test project too, so nothing here may import Android.
 */
object DurableFile {
    /**
     * Replaces [file] with [text] durably, or deletes it when [text] is null. Throws [IOException]
     * when the replacement did not happen, leaving the file as it was. Answers whether the
     * directory could be synced too (false on a platform that cannot open a directory - the file
     * itself is then replaced, but its rename may not survive a power loss); the caller logs it.
     */
    @Throws(IOException::class)
    fun replace(file: File, text: String?): Boolean {
        val dir = file.absoluteFile.parentFile ?: throw IOException("${file.name} has no directory")
        if (text == null) {
            if (file.exists() && !file.delete()) throw IOException("${file.name} not deleted")
            return syncDirectory(dir)
        }
        val tmp = File(dir, "${file.name}.tmp")
        FileOutputStream(tmp).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        try {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: IOException) {
            tmp.delete()
            throw IOException("${tmp.name} not renamed over ${file.name}: ${e.javaClass.simpleName}")
        }
        return syncDirectory(dir)
    }

    /** Syncs [dir]'s entries to the disk; false where a directory cannot be opened (not Linux). */
    fun syncDirectory(dir: File): Boolean = try {
        FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
        true
    } catch (e: IOException) {
        false
    } catch (e: SecurityException) {
        false
    }
}
