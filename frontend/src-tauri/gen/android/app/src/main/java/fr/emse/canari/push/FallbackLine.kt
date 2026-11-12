package fr.emse.canari.push

/**
 * WHICH SENTENCE STANDS IN FOR A MESSAGE THIS DEVICE COULD NOT OPEN, as a pure function (2026-11-11).
 *
 * A direct message's notification is already titled with its sender (the title, or on API 30+ the
 * conversation shortcut's header - see [ConversationShape]), so "Nouveau message de X" under X
 * named them twice: the same repeat the owner reported for a readable message. A direct message
 * therefore reads "Nouveau message", without the name. A group keeps "Nouveau message de X": its
 * title is the group, and the sentence is what says who wrote. With no sender name at all, the
 * generic "encrypted message" sentence is unchanged.
 *
 * The iOS twin is `NotificationService.fallbackText` (NSE) and `CanariBuildFallbackText` (`canari_push.mm`).
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object FallbackLine {

    enum class Kind {
        /** "Nouveau message de %s": a group, whose title is not the sender. */
        FROM_SENDER,
        /** "Nouveau message": a direct message, whose title already names the sender. */
        NEW_MESSAGE,
        /** "Vous avez reçu un message chiffré": nobody to name. */
        ENCRYPTED,
    }

    /** @param declared the push payload's `isGroup`, null when it did not say - see [ConversationShape.isGroup]. */
    fun of(senderName: String, groupName: String, declared: Boolean? = null): Kind = when {
        senderName.isEmpty() -> Kind.ENCRYPTED
        ConversationShape.isGroup(groupName, senderName, declared) -> Kind.FROM_SENDER
        else -> Kind.NEW_MESSAGE
    }
}
