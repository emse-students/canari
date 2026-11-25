package fr.emse.canari.push

/**
 * WHETHER THE SYSTEM MAY SUGGEST ANSWERS TO A CONVERSATION NOTIFICATION, as a pure function (2026-11-25).
 *
 * The reply action allowed generated replies unconditionally, so Android read the newest line and
 * offered its smart-reply chips ("Si", "OK") - against a generic "Nouveau message" line too, which
 * is not the message: the chips answered a sentence this device wrote, not anything the sender said.
 * When the newest line is such a placeholder, neither the generated replies nor the system's
 * contextual actions are offered. "Répondre" and "Marquer comme lu" stay: the reader knows a
 * message is there and may still answer it or mark it read.
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

    /** The flags for a notification whose newest line is (or is not) a placeholder. */
    fun of(newestIsPlaceholder: Boolean): Flags =
        if (newestIsPlaceholder) Flags(generatedReplies = false, systemContextualActions = false)
        else Flags(generatedReplies = true, systemContextualActions = true)
}
