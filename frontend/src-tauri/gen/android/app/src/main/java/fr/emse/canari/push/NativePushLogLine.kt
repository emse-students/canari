package fr.emse.canari.push

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * ONE LINE OF THE PUSH SERVICE'S OWN LOG, AS THE IN-APP LOG WILL CARRY IT (2026-11-04).
 *
 * The service's WARN and ERROR lines go to logcat, which no member can export, and to a bounded
 * file the page takes into the in-app log (`NativePushLog`, Rust `native_push_log.rs`). This is the
 * shape of a line in that file: the service's own instant (the page writes it later, so its capture
 * stamp is the TAKE's time, not the event's), the level, the tag and the message - one line, the
 * exception's CLASS and never its stack. The page redacts it like every other line it stores.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
object NativePushLogLine {

    /** The in-app log's own stamp shape (`appLog.ts`), so the two read alike side by side. */
    private val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS")

    /** The levels recorded: a debug or info line stays in logcat, as the in-app log keeps no debug. */
    fun records(level: Char): Boolean = level == 'W' || level == 'E'

    /**
     * @param atMs  the instant the service logged it
     * @param level `W` or `E`
     * @param error the throwable logged with it, named by its class only
     */
    fun format(atMs: Long, level: Char, tag: String, message: String, error: Throwable?, zone: ZoneId): String {
        val stamp = STAMP.format(Instant.ofEpochMilli(atMs).atZone(zone))
        val suffix = error?.let { " (${it.javaClass.simpleName})" } ?: ""
        return "$stamp $level $tag: $message$suffix".replace('\n', ' ').replace('\r', ' ')
    }
}
