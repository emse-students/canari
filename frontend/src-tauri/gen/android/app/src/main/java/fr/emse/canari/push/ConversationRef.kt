package fr.emse.canari.push

/**
 * A conversation as a log line names it: `ch:` and 8 characters of a salon's own id (its
 * `channel_<id>` key's prefix stripped first - otherwise every salon reads `channel_`), `g:` and 8
 * of an MLS conversation, `?` when there is none. An id, never a name: safe in any log.
 *
 * The scheme of the push-outcome line (#3914): the two must stay one, so a line about a post and a
 * line about its cancel name the same conversation the same way.
 *
 * No Android import: the JVM test project compiles it.
 */
object ConversationRef {
    private const val SALON_PREFIX = "channel_"

    /** The log reference of [conversationId] (a group id, or `channel_<id>` for a salon). */
    fun of(conversationId: String?): String = when {
        conversationId.isNullOrEmpty() -> "?"
        conversationId.startsWith(SALON_PREFIX) -> "ch:" + conversationId.removePrefix(SALON_PREFIX).take(8)
        else -> "g:" + conversationId.take(8)
    }
}
