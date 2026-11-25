package fr.emse.canari.push

/**
 * WHAT ASKING THE SERVER FOR A GROUP'S COMMITS ANSWERED, CLASSIFIED WHERE IT IS THROWN (2026-11-25).
 *
 * The commit catch-up (`tryDecryptWithCommitCatchup`) used to receive `null` for every failure of
 * `fetchCommitsFromBackend` - an HTTP refusal, a malformed body, and a phone that could not resolve
 * the server's name all alike - and turned each into `Refused`. A refused visible push then enqueued
 * `MlsBackgroundWorker` and logged `Decryption failed`, which accused the decryption when the network
 * had failed, and posted a generic line nothing ever upgraded: the worker sweeps the pending DB and
 * never fetches, decrypts or re-posts. Measured on an Android reading of 2026-11-25: a DM peer's
 * commit left the stored state one epoch behind, every later push hit `UnknownHostException` in the
 * catch-up, and the shade kept "Nouveau message" lines until the app was opened hours later and its
 * drain read them all.
 *
 * So the transport failure is its own answer, carried from the `catch` to where the decision is made
 * - the caller holds the frame for a replay once a network is back ([HeldFrames]) instead of
 * learning, by failing, what the exception's type already said.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
sealed interface CommitFetch {
    /** The server answered with the commits since the asked epoch: a JSON array, `[]` for none. */
    data class Commits(val json: String) : CommitFetch

    /** The server answered, and not with commits: an HTTP status other than 200/201. */
    data class Answered(val httpCode: Int) : CommitFetch

    /**
     * The server could not be reached: DNS, connect, TLS, a timeout, a cut mid-body. Nothing about
     * the frame or the state is wrong, and the same fetch on a working network answers.
     */
    data class Unreachable(val cause: String) : CommitFetch

    /** The server was reached and what it sent could not be read (a malformed body). */
    data class Unreadable(val cause: String) : CommitFetch

    companion object {
        /**
         * The classification of a throw, made ONCE, here. Every transport failure of
         * `HttpURLConnection` - `UnknownHostException`, `ConnectException`, `SocketTimeoutException`,
         * `SSLException`, an `EOFException` mid-body - is an `IOException`; a body the server sent and
         * the parser refused is not (`JSONException` is a `RuntimeException`).
         */
        fun ofThrowable(e: Throwable): CommitFetch =
            if (e is java.io.IOException) Unreachable(e.javaClass.simpleName) else Unreadable(e.javaClass.simpleName)
    }
}
