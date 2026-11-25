package fr.emse.canari

import fr.emse.canari.push.ServerFetch
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Both server fetches of a background decrypt - the proto and the commits - classify their failure
 * WHERE IT IS THROWN ([ServerFetch.ofThrowable]): a server
 * that could not be reached is its own answer, which `tryDecrypt` and the catch-up turn into `PushDecrypt.Unreachable`
 * and the push into a frame held for a replay. Everything else stays a failure about the server's
 * answer, and the catch-up gives no outcome for it, as before.
 */
class ServerFetchTest {

    @Test
    fun `a name that does not resolve is unreachable`() {
        assertEquals(
            ServerFetch.Unreachable("UnknownHostException"),
            ServerFetch.ofThrowable(java.net.UnknownHostException("server")),
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
            assertEquals(e.javaClass.simpleName, ServerFetch.Unreachable(e.javaClass.simpleName), ServerFetch.ofThrowable(e))
        }
    }

    @Test
    fun `a body the parser refused is unreadable, not unreachable`() {
        // `org.json.JSONException` is a RuntimeException: the server WAS reached.
        assertEquals(
            ServerFetch.Unreadable("IllegalStateException"),
            ServerFetch.ofThrowable(IllegalStateException("bad body")),
        )
    }
}
