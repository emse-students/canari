package fr.emse.canari.push

/**
 * A CAMPUS-TREND PUSH FOR A POST THIS DEVICE ALREADY DISPLAYED SHOWS NOTHING (owner, 2026-11-24,
 * "Verif sur l'appareil"), as a pure rule.
 *
 * The server records no "seen" and must not (charter, principles 1 and 3 of docs/principes.md), so a
 * trend can announce a post the member already saw in the feed. The DEVICE keeps the record - the
 * WebView notes each post card it displayed and hands the list to Rust (`seenPosts.svelte.ts`,
 * `store_seen_posts`), which writes `seen_posts.json` - and this decides, with nothing sent to the
 * server. The accepted limit: a post seen on another device is not recognised.
 *
 * A push is a trend by its `contentKey` - the FIELD, never the wording - and names its post in
 * `postId`. The rule is `libs/contracts/notification-seen-trend.cases.json`, asserted by
 * `SeenTrendsTest`, and by the client, the iOS extension, `canari_push.mm` and Rust on the same cases.
 * No age rule here: the writer prunes by the post's age, and an entry that outlived its window names a
 * post no trend can name again.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
object SeenTrends {

    /** The `contentKey`s of a campus trend. */
    val TREND_KEYS: Set<String> = setOf(
        "social_campus_trend",
        "social_campus_trend_photo",
        "social_campus_trend_video",
    )

    /**
     * One account's record, as parsed from the file.
     *
     * @property owner the account the file names (lower-cased).
     * @property posts the lower-cased ids of the posts the device displayed.
     */
    class Book(val owner: String, val posts: Set<String>)

    /**
     * EVERY END OF THE DECISION, NAMED (1.8.3-alpha.1, Mi 9T: a trend reached the device with no
     * `postId`, the rule answered a bare `false`, and nothing said why - the banner looked like a
     * post never displayed). The service logs each one; [reason] is the word the log carries.
     *
     * @property withheld whether the push shows nothing.
     * @property reason the logged word, the contract's `reason` (`notification-seen-trend.cases.json`).
     */
    enum class Verdict(val withheld: Boolean, val reason: String) {
        /** The post was displayed on this device: nothing is shown. */
        WITHHELD(true, "withheld"),
        /** The ordinary trend: a post this device never displayed. */
        NOT_DISPLAYED(false, "not-displayed"),
        /** A trend that names no post: the SERVER's defect (its push lost `postId`), so it accuses. */
        NO_POST_ID(false, "no-post-id"),
        /** The record is another account's: it never withholds for this one. */
        OTHER_ACCOUNT(false, "other-account"),
        /** No signed-in account in `push_context.json`. */
        SIGNED_OUT(false, "signed-out"),
        /** No `seen_posts.json` (nothing displayed yet) or an unreadable one (said where it is read). */
        NO_RECORD(false, "no-record"),
        /** Not a campus trend: the rule does not apply. */
        NOT_A_TREND(false, "not-a-trend"),
    }

    /**
     * Which end of the decision this push reaches.
     *
     * @param book the parsed file, null when there is none (absent, unreadable): nothing is withheld.
     * @param me the signed-in account (`push_context.json`); another account's record never withholds.
     */
    fun decide(book: Book?, me: String?, contentKey: String?, postId: String?): Verdict {
        if (contentKey == null || contentKey !in TREND_KEYS) return Verdict.NOT_A_TREND
        val id = postId?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return Verdict.NO_POST_ID
        if (book == null) return Verdict.NO_RECORD
        val owner = me?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return Verdict.SIGNED_OUT
        if (book.owner != owner) return Verdict.OTHER_ACCOUNT
        return if (id in book.posts) Verdict.WITHHELD else Verdict.NOT_DISPLAYED
    }

    /** Whether the push is withheld on this device ([decide] reached [Verdict.WITHHELD]). */
    fun withholds(book: Book?, me: String?, contentKey: String?, postId: String?): Boolean =
        decide(book, me, contentKey, postId).withheld
}
