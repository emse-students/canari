package fr.emse.canari

import fr.emse.canari.push.CommitFetch
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The commit fetch's failure is classified WHERE IT IS THROWN ([CommitFetch.ofThrowable]): a server
 * that could not be reached is its own answer, which the catch-up turns into `PushDecrypt.Unreachable`
 * and the push into a frame held for a replay. Everything else stays a failure about the server's
 * answer, and the catch-up gives no outcome for it, as before.
 */
class CommitFetchTest {

    @Test
    fun `a name that does not resolve is unreachable`() {
        assertEquals(
            CommitFetch.Unreachable("UnknownHostException"),
            CommitFetch.ofThrowable(java.net.UnknownHostException("server")),
        )
    }

    @Test
    fun `a refused connection, a timeout, a TLS failure and a cut body are unreachable`() {
        listOf(
            java.net.ConnectException(),
            java.net.SocketTimeoutException(),
            javax.net.ssl.SSLHandshakeException("handshake"),
            java.io.EOFException(),
        ).forEach { e ->
            assertEquals(e.javaClass.simpleName, CommitFetch.Unreachable(e.javaClass.simpleName), CommitFetch.ofThrowable(e))
        }
    }

    @Test
    fun `a body the parser refused is unreadable, not unreachable`() {
        // `org.json.JSONException` is a RuntimeException: the server WAS reached.
        assertEquals(
            CommitFetch.Unreadable("IllegalStateException"),
            CommitFetch.ofThrowable(IllegalStateException("bad body")),
        )
    }
}
