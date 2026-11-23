package app.tauri.gallery

import java.io.File

/**
 * The remembered "this user has no photo" (`avatar_<id>.absent`) yielding to the fact that refutes
 * it - pure, so a JVM test can pin it (`AvatarAbsenceTest`; no Android import allowed here).
 *
 * THE MARKER ANSWERS ONE QUESTION: "did the server say 404 when I asked?". It is evidence of that
 * and of nothing later, yet it was honoured for 24 h even after `avatar-presence` said the photo
 * exists (Mi 9T, 1.8.0-alpha.1: three contacts with photos kept their initials discs). The fact
 * invalidates it; the clock stays only as the fallback for a page that knows nothing.
 *
 * The outcome is returned, never logged here: the caller logs a literal per outcome.
 */
object AvatarAbsence {
    enum class Outcome {
        /** The page claimed no photo: the marker is left to its own clock. */
        NOT_CLAIMED,

        /** A photo is known and there was no remembered absence to drop. */
        NO_MARKER,

        /** A photo is known and the remembered absence was deleted. */
        DROPPED,

        /** A photo is known but the marker could not be deleted. */
        STILL_THERE,
    }

    /** Drops [marker] when the page says the user HAS a photo ([hasPhoto]); see [Outcome]. */
    fun yieldToPresence(marker: File, hasPhoto: Boolean): Outcome {
        if (!hasPhoto) return Outcome.NOT_CLAIMED
        if (!marker.exists()) return Outcome.NO_MARKER
        val dropped = try {
            marker.delete()
        } catch (e: SecurityException) {
            false
        }
        return if (dropped) Outcome.DROPPED else Outcome.STILL_THERE
    }
}
