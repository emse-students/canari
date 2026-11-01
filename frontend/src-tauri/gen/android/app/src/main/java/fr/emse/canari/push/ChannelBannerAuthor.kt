package fr.emse.canari.push

/**
 * WHO A SALON BANNER NAMES AS ITS SPEAKER, as a pure function (2026-11-01).
 *
 * The owner read a salon banner on `v1.6.0` titled `<Communaute> - #<salon>` with the message, no
 * author name, no author photo, and a "G" disc - the first letter of `#général`, the SALON. The
 * banner was built that way on purpose: the salon's title was handed in as the "sender", so the
 * only Person Android had to draw was the salon itself, and its initials were the salon's.
 *
 * THE SHAPE IS ALWAYS THE GROUP ONE: the salon is the conversation title and every line has a
 * speaker. A notification re-injects its earlier lines with THEIR Persons, so a salon that switched
 * shape between two posts (a named line, then a blind one) would rename or unname the lines already
 * there. Only the speaker of the NEW line varies, and each kind of speaker carries its own
 * [Author.personKey], so MessagingStyle never merges two of them under one name.
 *
 * The name comes from the PHONE'S OWN copy (`display_names.json`, written by the WebView for every
 * name it resolved - WP-MENTION-NAME), never from the push: a salon push carries `senderId` alone,
 * and no name may ride a payload Google or Apple carries (`push-payloads-carry-nothing`).
 *
 * THREE ANSWERS:
 *  - [Author.Unproven]: a blind banner (the generic line): nothing was opened, so the speaker is
 *    "Someone" with a "?" disc ([ChannelBannerAttribution]).
 *  - [Author.Named]: the open PROVED the author - a v2 session, whose reader checks the minter and the
 *    signature (`authorProven` in the native answer) - and the phone holds their name. Their name,
 *    their face, their initials.
 *  - [Author.Unnamed]: the message was opened but its author cannot be named: a v1 session, which
 *    proves no author at all (the push's `senderId` is the server's claim), or a proven author the
 *    phone has no name for. "Someone" with a "?" disc and NO face - a photo beside "Someone" would
 *    name the person by the back door, and for v1 on the server's word. [Author.Unnamed.reason] is
 *    logged; [accuses] decides its level.
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
         * @property reason `no-account`, `no-name-file`, `other-account`, `no-names`, `unreadable`.
         */
        data class Unusable(val reason: String) : NameBook
    }

    /** The speaker a salon line draws. */
    sealed interface Author {
        /**
         * The MessagingStyle Person key: one per kind of speaker and per author, so a named line, an
         * unnamed one and a blind one never merge, and two unnamed authors never merge either.
         */
        val personKey: String

        /** Nothing was opened: the line is the generic one, its speaker nobody in particular. */
        data object Unproven : Author {
            override val personKey = "salon-unproven"
        }

        /** The proven author, named from the phone's copy. */
        data class Named(val id: String, val name: String) : Author {
            override val personKey get() = "user:$id"
        }

        /**
         * An opened line whose author cannot be named.
         *
         * @property reason `v1-session`, `no-sender-id`, `not-in-name-book`, or a [NameBook.Unusable.reason].
         */
        data class Unnamed(val id: String, val reason: String) : Author {
            override val personKey get() = "unnamed:$id"
        }
    }

    /**
     * @param showsMessage  whether the banner's body IS the decrypted text.
     * @param authorProven  the native open's `authorProven`: true only under a v2 session.
     * @param authorId      [ChannelBannerAttribution.Attribution.authorId] - the push's `senderId`
     *   once opened, null on a blind banner or a push that named nobody.
     * @param book          the phone's names, read only when an author must be named.
     */
    fun of(showsMessage: Boolean, authorProven: Boolean, authorId: String?, book: () -> NameBook): Author {
        if (!showsMessage) return Author.Unproven
        val id = authorId?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
            ?: return Author.Unnamed(id = "", reason = "no-sender-id")
        if (!authorProven) return Author.Unnamed(id, "v1-session")
        return when (val read = book()) {
            is NameBook.Unusable -> Author.Unnamed(id, read.reason)
            is NameBook.Held -> read.nameOf(id)?.trim()?.takeIf { it.isNotEmpty() }
                ?.let { Author.Named(id, it) }
                ?: Author.Unnamed(id, "not-in-name-book")
        }
    }

    /**
     * Whether an [Author.Unnamed.reason] is a FAULT, logged at WARN: a name file a writer left
     * unreadable, an opened push that named nobody, a push context that could not be read. The rest -
     * a v1 session, a name the app has not resolved yet, no file yet, another account's file - are
     * states a banner ordinarily meets, logged at DEBUG.
     */
    fun accuses(reason: String): Boolean = reason in setOf("unreadable", "no-sender-id", "no-account")

    /** The text the initials disc is drawn from: the speaker's name, else nothing (the "?" disc). */
    fun initialsSource(author: Author): String = (author as? Author.Named)?.name ?: ""

    /** Whether the line may draw the speaker's photo: only a NAMED speaker has a face. */
    fun drawsFace(author: Author): Boolean = author is Author.Named

    /** One salon line as MessagingStyle draws it. */
    data class Line(val conversationTitle: String, val personName: String, val personKey: String)

    /**
     * The line [author] posts in the salon titled [title]: ALWAYS the salon as the conversation title,
     * the speaker's name or [someone] as the Person, and the speaker's own key.
     */
    fun line(author: Author, title: String, someone: String): Line =
        Line(title, (author as? Author.Named)?.name ?: someone, author.personKey)
}
