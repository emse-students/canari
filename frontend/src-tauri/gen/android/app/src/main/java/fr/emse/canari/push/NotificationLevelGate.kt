package fr.emse.canari.push

/**
 * WHETHER A DECRYPTED MLS MESSAGE MAY ALERT, GIVEN THE MEMBER'S LEVEL FOR ITS CONVERSATION.
 *
 * A private conversation has the salon's three levels (all / mentions / none). `none` never reaches
 * this device as a visible frame - the server sends it silent - and `all` is what every frame did
 * before. `mentions` is the one the server CANNOT decide: it never sees who a ciphertext mentions,
 * so it marks the push `notifLevel=mentions` and the decision is taken HERE, once, after decryption.
 *
 * THE RULE FOR WHAT CANNOT BE DECIDED, STATED RATHER THAN DEFAULTED (docs/wiki/services/
 * chat-delivery.md, "A conversation's notification level"): at `mentions`, a message this device
 * could not read - no plaintext, or no own user id to compare - does NOT alert. The member asked to
 * be interrupted only by a mention, and an unread frame proves none; the message is still in the
 * conversation, counted unread, when the app opens.
 *
 * Mentions are read from the WHOLE plaintext, never the 200-character preview: a mention after the
 * cut is still a mention.
 *
 * Nothing Android may be imported here (see [PushRecoveryLadder]).
 */
object NotificationLevelGate {
    /** The inline mention token every client writes: `@[<64-hex user id>]`. */
    private val MENTION_TOKEN = Regex("@\\[([0-9a-fA-F]{64})\\]")

    /** What the handler does with one visible message. */
    sealed class Decision {
        /** Raise it; [mentionsMe] picks the mentions channel over the messages one. */
        data class Alert(val mentionsMe: Boolean) : Decision()

        /** Raise nothing, for the stated [reason] (logged by the caller). */
        data class Withhold(val reason: String) : Decision()
    }

    /** Every user id the plaintext mentions, lower-cased. */
    fun mentionedUserIds(text: String): Set<String> =
        MENTION_TOKEN.findAll(text).map { it.groupValues[1].lowercase() }.toSet()

    /**
     * @param level the push's `notifLevel` field: `"mentions"`, or absent for the ordinary `all`.
     * @param mentioned the ids the decrypted message mentions, or null when it could not be read.
     * @param myUserId this account's id, or null when the push context could not be loaded.
     */
    fun decide(level: String?, mentioned: Set<String>?, myUserId: String?): Decision {
        val me = myUserId?.lowercase()
        val mentionsMe = me != null && mentioned?.contains(me) == true
        if (level != "mentions") return Decision.Alert(mentionsMe)
        return when {
            mentioned == null -> Decision.Withhold("level=mentions and the message could not be read - a mention is not proven")
            me == null -> Decision.Withhold("level=mentions and this account's id is unknown - a mention is not proven")
            mentionsMe -> Decision.Alert(true)
            else -> Decision.Withhold("level=mentions and the message does not mention this account")
        }
    }
}
