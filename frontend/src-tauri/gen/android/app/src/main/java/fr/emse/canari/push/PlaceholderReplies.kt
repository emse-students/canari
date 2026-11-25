package fr.emse.canari.push

/**
 * WHETHER THE SYSTEM MAY SUGGEST ANSWERS TO A CONVERSATION NOTIFICATION, as a pure function (2026-11-25).
 *
 * The reply action allowed generated replies unconditionally, so Android read the newest line and
 * offered its smart-reply chips ("Si", "OK") - against a generic "Nouveau message" line too, which
 * is not the message: the chips answered a sentence this device wrote, not anything the sender said.
 * When the newest line somebody else wrote is such a placeholder, neither the generated replies nor
 * the system's contextual actions are offered. "Répondre" and "Marquer comme lu" stay: the reader
 * knows a message is there and may still answer it or mark it read.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object PlaceholderReplies {

    /**
     * @param generatedReplies `Action.Builder.setAllowGeneratedReplies` on the reply action
     * @param systemContextualActions `Builder.setAllowSystemGeneratedContextualActions` on the post
     */
    data class Flags(val generatedReplies: Boolean, val systemContextualActions: Boolean)

    /**
     * What a line of the notification says about itself: whether it is a placeholder, and whether
     * this account wrote it (an answer drawn after a quick reply, or a reply still pending).
     */
    data class Line(val placeholder: Boolean, val own: Boolean)

    /**
     * Whether the newest line SOMEBODY ELSE wrote is a placeholder. This account's own lines are
     * skipped: the suggestions answer the other side, and a pending reply drawn under a placeholder
     * does not make the placeholder an answerable message.
     */
    fun newestIsPlaceholder(lines: List<Line>): Boolean =
        lines.lastOrNull { !it.own }?.placeholder == true

    /** The flags for a notification whose newest line is (or is not) a placeholder. */
    fun of(newestIsPlaceholder: Boolean): Flags =
        if (newestIsPlaceholder) Flags(generatedReplies = false, systemContextualActions = false)
        else Flags(generatedReplies = true, systemContextualActions = true)
}
