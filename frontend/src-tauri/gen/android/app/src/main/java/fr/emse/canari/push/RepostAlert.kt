package fr.emse.canari.push

/**
 * HOW A MESSAGE POST MAY ALERT, as a pure function (2026-10-22).
 *
 * One message is announced once. A post that re-draws a message already announced - the second
 * trigger for a line already in the shade, or the decrypted redraw of a blind banner - must not
 * sound again. `setOnlyAlertOnce` says that, but only for an UPDATE of a post in place: when the
 * conversation's channel changes, the old post is cancelled and the new one is a NEW post, which
 * `setOnlyAlertOnce` does not silence. That is the case a held salon mention reaches: its blind
 * banner goes up on the ordinary channel (nothing proved the mention, see [ChannelBannerAttribution])
 * and its redraw, once the seed lands, moves to the mention channel - cancel, repost, second sound.
 * So a re-draw that also switches channel is posted SILENT.
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
        /** A re-draw that cancels and reposts on another channel: `setSilent(true)`. */
        SILENT,
    }

    /**
     * @param redraw        the post re-draws a message already announced (already in the shade, or
     *                      superseding the line it replaces).
     * @param switchesChannel the conversation's post in the shade is on another channel, so it is
     *                      cancelled and this one is a new post.
     */
    fun of(redraw: Boolean, switchesChannel: Boolean): Mode = when {
        !redraw -> Mode.ALERT
        switchesChannel -> Mode.SILENT
        else -> Mode.ONLY_ONCE
    }
}
