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
     * Whether the push is withheld on this device.
     *
     * @param book the parsed file, null when there is none (absent, unreadable): nothing is withheld.
     * @param me the signed-in account (`push_context.json`); another account's record never withholds.
     */
    fun withholds(book: Book?, me: String?, contentKey: String?, postId: String?): Boolean {
        if (book == null) return false
        val owner = me?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return false
        if (book.owner != owner) return false
        if (contentKey == null || contentKey !in TREND_KEYS) return false
        val id = postId?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return false
        return id in book.posts
    }
}
