package fr.emse.canari.push

/**
 * WHO A SALON BANNER NAMES AS ITS SPEAKER, as a pure function (2026-11-01).
 *
 * The owner read a salon banner on `v1.6.0` titled `<Communaute> - #<salon>` with the message, no
 * author name, no author photo, and a "G" disc - the first letter of `#général`, the SALON. The
 * banner was built that way on purpose: the salon's title was handed in as the "sender", so the
 * only Person Android had to draw was the salon itself, and its initials were the salon's. A DM or
 * a group names its speaker; a salon did not, and nothing said so.
 *
 * The name comes from the PHONE'S OWN copy (`display_names.json`, written by the WebView for every
 * name it resolved - WP-MENTION-NAME), never from the push: a salon push carries `senderId` alone,
 * and no name may ride a payload Google or Apple carries (`push-payloads-carry-nothing`).
 *
 * THREE ANSWERS, AND ONLY ONE OF THEM IS THE SALON:
 *  - [Author.Unproven]: the banner shows the generic line, so nothing proved who wrote it
 *    ([ChannelBannerAttribution]). The banner keeps the salon's identity - its title as the Person,
 *    its initials - because there is no speaker it may name.
 *  - [Author.Named]: the open proved the author and the phone holds their name. The salon becomes the
 *    conversation title, the author the Person on the line, and the disc carries THEIR initials.
 *  - [Author.Unnamed]: the open proved an author the phone cannot name. The line says "Someone" with a
 *    "?" disc - never the salon's letter dressed as a person - and [Author.Unnamed.reason] is what the
 *    caller logs at a level that accuses, because an author proven and unnamed is a hole in the name
 *    mirror (or a push without its `senderId`), not an ordinary case.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
object ChannelBannerAuthor {

    /** The phone's names as this banner could read them. */
    sealed interface NameBook {
        /** The file is the signed-in account's; [nameOf] answers a lower-cased id, null when absent. */
        class Held(val nameOf: (String) -> String?) : NameBook

        /**
         * The file cannot name anybody for this account.
         *
         * @property reason a token for the log: `no-account`, `no-name-file`, `other-account`,
         *   `no-names`, `unreadable`.
         */
        data class Unusable(val reason: String) : NameBook
    }

    /** The speaker a salon banner draws. */
    sealed interface Author {
        /** Nothing proved an author: the salon stands as the banner's only Person. */
        data object Unproven : Author

        /** The proven author, named from the phone's copy. */
        data class Named(val id: String, val name: String) : Author

        /**
         * A proven author the phone cannot name.
         *
         * @property reason why, for the accusing log line: `no-sender-id`, `not-in-name-book`, or the
         *   [NameBook.Unusable.reason].
         */
        data class Unnamed(val id: String, val reason: String) : Author
    }

    /**
     * @param showsMessage whether the banner's body IS the decrypted text.
     * @param authorId     [ChannelBannerAttribution.Attribution.authorId] - the push's `senderId`
     *   once the open proved it, null on a blind banner or a push that named nobody.
     * @param book         the phone's names, read only when an author must be named.
     */
    fun of(showsMessage: Boolean, authorId: String?, book: () -> NameBook): Author {
        if (!showsMessage) return Author.Unproven
        val id = authorId?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
            ?: return Author.Unnamed(id = "", reason = "no-sender-id")
        return when (val read = book()) {
            is NameBook.Unusable -> Author.Unnamed(id, read.reason)
            is NameBook.Held -> read.nameOf(id)?.trim()?.takeIf { it.isNotEmpty() }
                ?.let { Author.Named(id, it) }
                ?: Author.Unnamed(id, "not-in-name-book")
        }
    }

    /**
     * The text the initials disc is drawn from: the author's name, the salon's only when nothing
     * proved an author, and nothing (the "?" disc) for an author the phone cannot name.
     */
    fun initialsSource(author: Author, channelName: String): String = when (author) {
        is Author.Named -> author.name
        is Author.Unnamed -> ""
        Author.Unproven -> channelName
    }
}
