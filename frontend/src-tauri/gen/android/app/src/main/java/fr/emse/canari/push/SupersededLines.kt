package fr.emse.canari.push

/**
 * WHICH LINES OF A CONVERSATION NOTIFICATION A NEW POST REPLACES, AND WHERE IT GOES, as pure functions.
 *
 * A generic "Nouveau message" line is not a message the reader should keep beside the real one: it
 * is the same message written twice. A post that knows which line it stands for names that line's
 * instant - the one `showMessageNotification` handed back when it posted it - and the line is
 * dropped from the history re-injected under the new one. The match is an IDENTITY, never a guess
 * about the text. Three callers name such instants: the WebView's real post for a push refused for
 * good ([GenericBannerLedger]), the salon banner redrawn once its seed landed, and the replay of a
 * frame held for the network ([HeldFrames]). Only the replay takes the replaced line's PLACE
 * ([insertionIndex]): it runs once the network is back, behind every line that arrived meanwhile.
 * The other two are live posts, made as their message arrives, and keep appending as they always
 * did - their caller does not ask for the place.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object SupersededLines {

    /**
     * Whether a line of instant [timestamp] stays under a post replacing [supersedes] (0: nothing)
     * and every instant of [alsoSupersedes].
     */
    fun kept(timestamp: Long, supersedes: Long, alsoSupersedes: Set<Long>): Boolean =
        (supersedes == 0L || timestamp != supersedes) && timestamp !in alsoSupersedes

    /**
     * WHERE A REPLAYED LINE GOES (2026-11-25), for the replay only: at the place of the first line it replaces, so a
     * replayed message keeps its order among the lines that arrived after its generic stand-in -
     * appended, it read as the newest message of the conversation. Null when it replaces nothing,
     * and the line is appended as every other post is.
     *
     * @param stamps the instants of the history, oldest first, BEFORE the filter
     * @param bound how many kept lines are re-injected: the newest [bound] of them
     * @return the index in the re-injected (kept, then bounded) list
     */
    fun insertionIndex(stamps: List<Long>, supersedes: Long, alsoSupersedes: Set<Long>, bound: Int): Int? {
        val first = stamps.indexOfFirst { !kept(it, supersedes, alsoSupersedes) }
        if (first < 0) return null
        val keptBefore = stamps.take(first).count { kept(it, supersedes, alsoSupersedes) }
        val keptTotal = stamps.count { kept(it, supersedes, alsoSupersedes) }
        val droppedByBound = maxOf(keptTotal - bound, 0)
        return maxOf(keptBefore - droppedByBound, 0)
    }

    /**
     * THE INSTANTS A POST'S QUICK ACTIONS CARRY (2026-11-25): "Marquer comme lu" marks the
     * conversation read up to them, and the reply answers them. A line inserted at its place is not
     * the newest - lines that arrived after its generic stand-in are below it - so its own instants
     * would leave those newer messages unread. The actions then carry the NEWEST line's instants, as
     * the silent re-post does; an appended line is the newest and carries its own.
     *
     * @param posted the posted line's (sentAt, serverAt)
     * @param newest the newest line's (sentAt, serverAt), null when it carries none
     * @param insertedInPlace whether the posted line went in above the newest one
     */
    fun actionInstants(posted: Pair<Long, Long>, newest: Pair<Long, Long>?, insertedInPlace: Boolean): Pair<Long, Long> =
        if (insertedInPlace && newest != null && newest.first > 0L) newest else posted
}
