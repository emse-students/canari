package fr.emse.canari

import fr.emse.canari.mail.NativeCheckEnd
import fr.emse.canari.mail.NativeEraseReason
import fr.emse.canari.mail.NativeInboxItem
import fr.emse.canari.mail.NativeMailPorts
import fr.emse.canari.mail.NativeMailRun
import fr.emse.canari.mail.NativeRunEnd
import fr.emse.canari.mail.NativeStopped
import fr.emse.canari.mail.NativeVaultRecord
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE NATIVE RUN AGAINST A FAKE SERVER (lot 4b, the review of #4213): the real loop of
 * `mail/NativeMailRun.kt`, its ports faked - every answer the server could give, and what the run
 * does about it, with no Android and no network.
 */
class NativeMailRunTest {
    private class Fake : NativeMailPorts {
        var armed = true
        var stopped = false
        var cursor: String? = """{"v":1,"account":"ada@etu.emse.fr","highest":100}"""
        val requests = mutableListOf<String>()
        val erased = mutableListOf<NativeEraseReason>()
        val notified = mutableListOf<List<NativeInboxItem>>()
        val pauses = mutableListOf<Long>()
        var vaultOpens = 0

        /** The sign-in's answer, by the sign-in's number (1-based). */
        var auth: (Int) -> JSONObject = { ok("AuthResponse", """{"authToken":[{"_content":"t"}]}""") }
        var createWaitSet: () -> JSONObject = { ok("CreateWaitSetResponse", """{"waitSet":"w1","seq":"0"}""") }

        /** The wait's answer, by the wait's number (1-based). */
        var wait: (Int) -> JSONObject = { stopped = true; throw NativeStopped() }
        var search: (String?) -> JSONObject = { ok("SearchResponse", """{"m":[],"more":false}""") }

        /** Stops the run at its Nth pause (the ladder would otherwise loop for ever). */
        var stopAtPause = 1

        /** The monotonic clock, and how long each wait holds on it (a normal wait: the full 300 s). */
        var clock = 0L
        var waitHoldsMs = 300_000L

        /** Whether a stopped run may release its wait set (a forget: not). */
        var releaseAllowed = true

        /** What the release after a stop does. */
        var release: () -> JSONObject = { ok("DestroyWaitSetResponse", "{}") }

        private fun count(name: String) = requests.count { it == name }

        override fun call(body: JSONObject, token: String?): JSONObject {
            checkStopped()
            val name = body.keys().next()
            requests += name
            return when (name) {
                "AuthRequest" -> auth(count(name))
                "CreateWaitSetRequest" -> createWaitSet()
                "WaitSetRequest" -> {
                    clock += waitHoldsMs
                    wait(count(name))
                }
                "SearchRequest" -> search(body.getJSONObject(name).optJSONObject("cursor")?.getString("id"))
                else -> error("unexpected $name")
            }
        }

        override fun callAfterStop(body: JSONObject, token: String): JSONObject {
            requests += body.keys().next()
            return release()
        }

        override fun releaseAllowed() = releaseAllowed

        override fun elapsedMs() = clock

        override fun openVault(): NativeVaultRecord? {
            vaultOpens++
            return if (armed) NativeVaultRecord("ada@etu.emse.fr", "pw") else null
        }

        override fun stillArmed() = armed

        override fun eraseVault(reason: NativeEraseReason) {
            erased += reason
            armed = false
        }

        override fun readCursor() = cursor

        override fun writeCursor(text: String): Boolean {
            cursor = text
            return true
        }

        override fun notify(fresh: List<NativeInboxItem>) {
            notified += fresh
        }

        override fun pause(ms: Long) {
            pauses += ms
            if (pauses.size >= stopAtPause) {
                stopped = true
                throw NativeStopped()
            }
        }

        override fun checkStopped() {
            if (stopped) throw NativeStopped()
        }

        override fun log(line: String) = Unit
    }

    companion object {
        fun ok(name: String, inner: String) = JSONObject("""{"Body":{"$name":$inner}}""")
        fun fault(code: String) = JSONObject("""{"Body":{"Fault":{"Detail":{"Error":{"Code":"$code"}}}}}""")
        fun page(vararg ids: Int, more: Boolean) = ok(
            "SearchResponse",
            """{"m":[${ids.joinToString(",") { """{"id":"$it","f":"u","su":"s","e":[{"t":"f","a":"b@c.fr"}]}""" }}],"more":$more}""",
        )
    }

    @Test
    fun `a copy erased while the run waits ends the run after that wait, with nothing more asked`() {
        // Review B1: the erase lands during the blocking wait; the run answers it at the wait's end.
        val fake = Fake()
        fake.wait = { fake.armed = false; ok("WaitSetResponse", """{"seq":"1","a":[{"id":"x"}]}""") }
        assertEquals(NativeRunEnd.DISARMED, NativeMailRun(fake).watch())
        assertEquals(listOf("AuthRequest", "CreateWaitSetRequest", "SearchRequest", "WaitSetRequest"), fake.requests)
        assertTrue(fake.notified.isEmpty())
    }

    @Test
    fun `a refused password at sign-in erases the copy and ends the run`() {
        val fake = Fake()
        fake.auth = { fault("account.AUTH_FAILED") }
        assertEquals(NativeRunEnd.REFUSED, NativeMailRun(fake).watch())
        assertEquals(listOf(NativeEraseReason.REFUSED), fake.erased)
    }

    @Test
    fun `a closed account at sign-in erases the copy and the cursor, as the page's D8`() {
        // Review I1.
        val fake = Fake()
        fake.auth = { fault("account.NO_SUCH_ACCOUNT") }
        assertEquals(NativeRunEnd.ACCOUNT_CLOSED, NativeMailRun(fake).watch())
        assertEquals(listOf(NativeEraseReason.ACCOUNT_CLOSED), fake.erased)
    }

    @Test
    fun `an inactive account ends the run and erases nothing`() {
        val fake = Fake()
        fake.auth = { fault("account.ACCOUNT_INACTIVE") }
        assertEquals(NativeRunEnd.UNAVAILABLE, NativeMailRun(fake).watch())
        assertTrue(fake.erased.isEmpty())
    }

    @Test
    fun `a session refused before any wait is a failure that pauses, never a sign-in loop`() {
        // Review I2: signing in again and again on a session that lapses at once locks an account.
        val fake = Fake()
        fake.createWaitSet = { fault("service.AUTH_EXPIRED") }
        assertEquals(NativeRunEnd.STOPPED, NativeMailRun(fake).watch())
        assertEquals(1, fake.pauses.size)
        assertEquals(1, fake.requests.count { it == "AuthRequest" })
    }

    @Test
    fun `a session that lapses after a normal wait signs in again at once, from a freshly opened copy`() {
        // Review I2 and minor 9: the copy is opened at EACH sign-in, never held for the run.
        val fake = Fake()
        fake.wait = { n ->
            if (n == 1) ok("WaitSetResponse", """{"seq":"1"}""") else fault("service.AUTH_EXPIRED")
        }
        fake.auth = { n ->
            if (n == 2) {
                fake.stopped = true
                throw NativeStopped()
            }
            ok("AuthResponse", """{"authToken":[{"_content":"t"}]}""")
        }
        assertEquals(NativeRunEnd.STOPPED, NativeMailRun(fake).watch())
        assertTrue(fake.pauses.isEmpty())
        assertEquals(2, fake.vaultOpens)
    }

    @Test
    fun `a delta page that does not advance ends the read instead of asking for ever`() {
        // Review minor 10: the server hands back the same page after its own last id.
        val fake = Fake()
        fake.search = { page(105, 104, more = true) }
        assertEquals(NativeCheckEnd.DONE, NativeMailRun(fake).checkOnce())
        assertEquals(2, fake.requests.count { it == "SearchRequest" })
        assertEquals("""{"v":1,"account":"ada@etu.emse.fr","highest":105}""", fake.cursor)
        assertEquals(1, fake.notified.size)
    }

    @Test
    fun `a check with nothing sealed reads nothing`() {
        val fake = Fake()
        fake.armed = false
        assertEquals(NativeCheckEnd.NOTHING_SEALED, NativeMailRun(fake).checkOnce())
        assertTrue(fake.requests.isEmpty())
    }

    @Test
    fun `a stopped run releases its wait set on a connection the stop does not refuse`() {
        val fake = Fake()
        fake.wait = { n ->
            if (n == 1) ok("WaitSetResponse", """{"seq":"1"}""") else { fake.stopped = true; throw NativeStopped() }
        }
        assertEquals(NativeRunEnd.STOPPED, NativeMailRun(fake).watch())
        assertEquals("DestroyWaitSetRequest", fake.requests.last())
    }

    @Test
    fun `a forgotten run leaves without releasing its wait set`() {
        // Second round, 1: the release must never hold a forget up.
        val fake = Fake()
        fake.releaseAllowed = false
        fake.wait = { n ->
            if (n == 1) ok("WaitSetResponse", """{"seq":"1"}""") else { fake.stopped = true; throw NativeStopped() }
        }
        assertEquals(NativeRunEnd.STOPPED, NativeMailRun(fake).watch())
        assertTrue("DestroyWaitSetRequest" !in fake.requests)
    }

    @Test
    fun `after a transport failure the stale wait set is not released`() {
        val fake = Fake()
        fake.wait = { throw java.io.IOException("reset") }
        assertEquals(NativeRunEnd.STOPPED, NativeMailRun(fake).watch())
        assertTrue("DestroyWaitSetRequest" !in fake.requests)
    }

    @Test
    fun `a wait answered empty without blocking is a failure on the ladder, never a tight loop`() {
        // Second round, minor 8: the server answers at once, again and again.
        val fake = Fake()
        fake.waitHoldsMs = 10
        fake.stopAtPause = 3
        fake.wait = { ok("WaitSetResponse", """{"seq":"1"}""") }
        assertEquals(NativeRunEnd.STOPPED, NativeMailRun(fake).watch())
        assertEquals(listOf(2_000L, 4_000L, 8_000L), fake.pauses)
        assertEquals(3, fake.requests.count { it == "WaitSetRequest" })
    }

    @Test
    fun `a change answered at once is read at once - the floor bounds empty answers only`() {
        val fake = Fake()
        fake.waitHoldsMs = 10
        fake.wait = { n ->
            if (n == 1) ok("WaitSetResponse", """{"seq":"1","a":[{"id":"x"}]}""") else { fake.stopped = true; throw NativeStopped() }
        }
        fake.search = { page(101, 100, more = false) }
        assertEquals(NativeRunEnd.STOPPED, NativeMailRun(fake).watch())
        assertTrue(fake.pauses.isEmpty())
        assertEquals(1, fake.notified.size)
    }

    @Test
    fun `a delta read that cycles between page cursors ends`() {
        // Second round, minor 8: not only an immediate repeat - A, B, A.
        val fake = Fake()
        fake.search = { after ->
            when (after) {
                null, "104" -> page(106, 105, more = true)
                else -> page(105, 104, more = true)
            }
        }
        assertEquals(NativeCheckEnd.DONE, NativeMailRun(fake).checkOnce())
        assertEquals(3, fake.requests.count { it == "SearchRequest" })
    }
}
