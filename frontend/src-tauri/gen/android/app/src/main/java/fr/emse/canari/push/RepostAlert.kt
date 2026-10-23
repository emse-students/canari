package fr.emse.canari.push

/**
 * HOW A MESSAGE POST MAY ALERT, as a pure function (2026-10-22).
 *
 * One message is announced once. A post that re-draws a message already announced - the second
 * trigger for a line already in the shade, or the decrypted redraw of a blind banner - must not
 * sound again. `setOnlyAlertOnce` says that, but only for an UPDATE of a post in place. Two re-draws
 * are NEW posts, which it does not silence:
 *
 * - the conversation's channel changes, so the old post is cancelled first. A held salon mention
 *   does exactly that: its blind banner goes up on the ordinary channel (nothing proved the mention,
 *   see [ChannelBannerAttribution]) and its redraw, once the seed lands, moves to the mention one;
 * - the reader swiped the blind banner away before the seed landed, so there is no post to update.
 *
 * Either is posted SILENT.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object RepostAlert {

    enum class Mode {
        /** A first announcement: sounds as its channel says. */
        ALERT,
        /** A re-draw updating the post in place: `setOnlyAlertOnce(true)`. */
        ONLY_ONCE,
        /** A re-draw that is a new post: `setSilent(true)`. */
        SILENT,
    }

    /**
     * @param redraw          the post re-draws a message already announced (already in the shade,
     *                        or superseding the line it replaces).
     * @param switchesChannel the conversation's post in the shade is on another channel, so it is
     *                        cancelled and this one is a new post.
     * @param hasExistingPost the conversation has a post in the shade for this one to update.
     */
    fun of(redraw: Boolean, switchesChannel: Boolean, hasExistingPost: Boolean): Mode = when {
        !redraw -> Mode.ALERT
        switchesChannel || !hasExistingPost -> Mode.SILENT
        else -> Mode.ONLY_ONCE
    }
}
