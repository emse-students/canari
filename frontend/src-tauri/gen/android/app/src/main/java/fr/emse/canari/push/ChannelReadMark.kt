package fr.emse.canari.push

/**
 * WHEN A NOTIFICATION MAY OFFER "MARK AS READ" FOR A SALON, AND WHICH SALON IT NAMES - as pure
 * functions (user request, 2026-10-05).
 *
 * A DM's read state is an MLS watermark frame the phone sends itself; a salon's is a row held by
 * social-service, so a salon notification's action is one HTTP call (`POST /api/mls/push/channel-read`,
 * PushSecret) rather than an outbox entry. Reply stays absent on a salon: the send is
 * server-authoritative AND end-to-end encrypted under a Graine session, which the broadcast receiver
 * cannot seal (see the wiki, `channel-encryption`).
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object ChannelReadMark {

    /** The prefix a salon's conversation id carries (`channel_<channelId>`), on every notification. */
    const val CONVERSATION_PREFIX = "channel_"

    /** The salon id behind a conversation id, or null when it is not a salon (a DM or a group). */
    fun channelIdOf(conversationId: String): String? =
        conversationId
            .takeIf { it.startsWith(CONVERSATION_PREFIX) }
            ?.removePrefix(CONVERSATION_PREFIX)
            ?.takeIf { it.isNotEmpty() }

    /**
     * Whether the action is offered. It needs the instant the notification stands for: `at` is the
     * server's message time and is NEVER this phone's clock, because a read mark only rises and a
     * fast clock would mark future messages read for good. No instant, no action - rather than one
     * that would say something invented.
     */
    fun offered(conversationId: String, sentAt: Long): Boolean =
        sentAt > 0L && channelIdOf(conversationId) != null
}
