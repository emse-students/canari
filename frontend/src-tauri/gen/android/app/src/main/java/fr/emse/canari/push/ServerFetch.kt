package fr.emse.canari.push

/**
 * WHAT A PUSH-SECRET REQUEST TO THE SERVER ANSWERED, CLASSIFIED WHERE IT IS THROWN (2026-11-25).
 *
 * The two fetches a background decrypt makes - the frame's ciphertext (`fetchProtoFromBackend`) and
 * the commits that close an epoch gap (`fetchCommitsFromBackend`) - used to answer `null` for every
 * failure: an HTTP refusal, a malformed body, and a phone that could not resolve the server's name
 * all alike, and each became `Refused`. A refused visible push then enqueued `MlsBackgroundWorker`
 * and logged `Decryption failed`, which accused the decryption when the network had failed, and
 * posted a generic line nothing ever upgraded: the worker sweeps the pending DB and never fetches,
 * decrypts or re-posts. Measured on an Android reading of 2026-11-25: a DM peer's commit left the
 * stored state one epoch behind, every later push hit `UnknownHostException` in the catch-up, and the
 * shade kept "Nouveau message" lines until the app was opened hours later and its drain read them all.
 *
 * So the transport failure is its own answer, carried from the `catch` to where the decision is made
 * - the caller holds the frame for a replay once a network is back ([HeldFrames]) instead of
 * learning, by failing, what the exception's type already said.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
sealed interface ServerFetch {
    /** The server answered with what was asked: the commits (a JSON array, `[]` for none), or a proto. */
    data class Got(val body: String) : ServerFetch

    /** The server answered, and not with it: an HTTP status other than success, or an empty answer. */
    data class Answered(val httpCode: Int) : ServerFetch

    /**
     * The server could not be reached: DNS, connect, TLS, a timeout, a cut mid-body. Nothing about
     * the frame or the state is wrong, and the same fetch on a working network answers.
     */
    data class Unreachable(val cause: String) : ServerFetch

    /** The server was reached and what it sent could not be read (a malformed body). */
    data class Unreadable(val cause: String) : ServerFetch

    companion object {
        /**
         * The classification of a throw, made ONCE, here. Every transport failure of
         * `HttpURLConnection` - `UnknownHostException`, `ConnectException`, `SocketTimeoutException`,
         * `SSLException`, an `EOFException` mid-body - is an `IOException`; a body the server sent and
         * the parser refused is not (`JSONException` is a `RuntimeException`).
         */
        fun ofThrowable(e: Throwable): ServerFetch =
            if (e is java.io.IOException) Unreachable(e.javaClass.simpleName) else Unreadable(e.javaClass.simpleName)
    }
}
