package fr.emse.canari.push

/**
 * THE SHAPE A MESSAGE NOTIFICATION'S `MessagingStyle` TAKES, as a pure function (2026-11-11).
 *
 * Two platform behaviours decide it, and both are read from AOSP rather than guessed:
 *
 * - **A conversation post is titled by its SHORTCUT.** From API 30, a `MessagingStyle` post carrying
 *   a long-lived shortcut is drawn by SystemUI's `ConversationLayout`, and before inflating it
 *   `ConversationNotificationProcessor.processNotification` OVERWRITES the style's
 *   `conversationTitle` with the shortcut's label. A direct message publishes its shortcut labelled
 *   with the other person, so its header names them whatever this code leaves the title as.
 * - **A group conversation names every line; a one-to-one one hides the repeated name.** In the
 *   group shape every message group shows its sender. In the one-to-one shape
 *   (`isGroupConversation = false`) `PeopleHelper.maybeHideFirstSenderName` hides the first
 *   group's sender when it equals the header, while our own reply and any later change of speaker
 *   stay named.
 *
 * A direct message posted in the group shape WITH its shortcut therefore read the name twice: in the
 * header, then above the line (owner, Android 16, `1.6.10`, 2026-11-11). So a direct message drawn
 * as a conversation takes the one-to-one shape: the name once, in the header, and the reader's own
 * inline reply still named. A direct message the platform does NOT draw as a conversation (no
 * shortcut, or below API 30) keeps the untitled group shape of 2026-10-01: there the legacy layout
 * puts no shortcut label on top, and the one-to-one shape would name nobody above the other person's
 * lines while naming the reader above theirs.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object ConversationShape {

    /**
     * @param title            the `conversationTitle` to set, or null to leave it unset.
     * @param groupConversation the value for `isGroupConversation`; false leaves the platform's
     *                         one-to-one default.
     */
    data class Shape(val title: String?, val groupConversation: Boolean)

    /**
     * Whether a message post is a GROUP conversation, titled with the group rather than with its
     * sender - the ONE predicate both the shape below and [FallbackLine] read.
     *
     * [declared] is the push payload's `isGroup` (or the WebView's conversation type) and WINS when
     * present: a third of production groups carry no name (`push-payload.ts`), and a group may be
     * named like one of its members, so the name alone cannot answer. Null - the server could not
     * read the row, or a caller that has no such fact (a reaction) - falls back to the name rule:
     * a named group distinct from the sender.
     */
    fun isGroup(groupName: String, senderName: String, declared: Boolean? = null): Boolean =
        declared ?: (groupName.isNotEmpty() && groupName != senderName)

    /**
     * The title a group post carries: its name, else [unnamedGroup] ("Conversation de groupe").
     * Never the sender's name: a group titled with its first speaker reads as a direct message with
     * them, which is what the payload's `isGroup` was introduced to stop (2026-09-21).
     */
    fun groupTitle(groupName: String, unnamedGroup: String): String = groupName.ifEmpty { unnamedGroup }

    /** The first API level whose SystemUI draws a shortcut-backed post as a conversation. */
    const val CONVERSATION_LAYOUT_API = 30

    /**
     * @param isGroup           the conversation is a group - [isGroup].
     * @param groupName         the group's title ([groupTitle]), read only when [isGroup].
     * @param namesEachSender   the post is a message between people (see `showMessageNotification`).
     * @param hasShortcut       a conversation shortcut was published for this post.
     * @param sdkInt            `Build.VERSION.SDK_INT`, passed in so this stays Android-free.
     */
    fun of(
        isGroup: Boolean,
        groupName: String,
        namesEachSender: Boolean,
        hasShortcut: Boolean,
        sdkInt: Int,
    ): Shape = when {
        isGroup -> Shape(title = groupName, groupConversation = true)
        // The header is the shortcut's label (the other person): naming them above the line too
        // is the duplicate.
        namesEachSender && hasShortcut && sdkInt >= CONVERSATION_LAYOUT_API ->
            Shape(title = null, groupConversation = false)
        // No shortcut label on top: the group shape is the only place the name appears.
        namesEachSender -> Shape(title = null, groupConversation = true)
        // A reaction (a sentence about its actor, not a message by them): the old one-to-one shape.
        else -> Shape(title = null, groupConversation = false)
    }
}
