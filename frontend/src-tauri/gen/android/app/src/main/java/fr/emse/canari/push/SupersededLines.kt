package fr.emse.canari.push

/**
 * WHICH LINES OF A CONVERSATION NOTIFICATION A NEW POST REPLACES, as a pure function.
 *
 * A generic "Nouveau message" line is not a message the reader should keep beside the real one: it
 * is the same message written twice. A post that knows which line it stands for names that line's
 * instant - the one `showMessageNotification` handed back when it posted it - and the line is
 * dropped from the history re-injected under the new one. The match is an IDENTITY, never a guess
 * about the text. Three callers name such instants: the WebView's real post for a push refused for
 * good ([GenericBannerLedger]), the salon banner redrawn once its seed landed, and the replay of a
 * frame the network refused ([HeldFrames]).
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
}
