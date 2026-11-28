package fr.emse.canari

import fr.emse.canari.mail.NativeCursor
import fr.emse.canari.mail.NativeInboxItem
import fr.emse.canari.mail.NativeInboxPage
import fr.emse.canari.mail.NativeMailFault
import fr.emse.canari.mail.NativeMailUnreadable
import fr.emse.canari.mail.NativeNoticeTexts
import fr.emse.canari.mail.NativeVaultRecord
import fr.emse.canari.mail.authTokenOf
import fr.emse.canari.mail.faultCodeOf
import fr.emse.canari.mail.inboxPageOf
import fr.emse.canari.mail.nativeAuthRequest
import fr.emse.canari.mail.nativeBaselineOf
import fr.emse.canari.mail.nativeCreateWaitSetRequest
import fr.emse.canari.mail.nativeCursorOf
import fr.emse.canari.mail.nativeCursorText
import fr.emse.canari.mail.nativeDeltaStep
import fr.emse.canari.mail.nativeFaultOf
import fr.emse.canari.mail.nativeInboxPageRequest
import fr.emse.canari.mail.nativeItemNumber
import fr.emse.canari.mail.nativeNextHighest
import fr.emse.canari.mail.nativeNoticeOf
import fr.emse.canari.mail.nativeRetryDelayMs
import fr.emse.canari.mail.nativeVaultAad
import fr.emse.canari.mail.nativeVaultFileName
import fr.emse.canari.mail.nativeVaultPlaintext
import fr.emse.canari.mail.nativeVaultRecordOf
import fr.emse.canari.mail.nativeVaultUserOf
import fr.emse.canari.mail.nativeWaitSetRequest
import fr.emse.canari.mail.soapEnvelope
import fr.emse.canari.mail.waitAnswerOf
import fr.emse.canari.mail.waitSetOf
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * THE NATIVE WATCHER SPEAKS THE PAGE'S PROTOCOL (mail lot 4b): the same requests as
 * `zimbraRequests.ts`, the answers in the shapes MEASURED on Partage on 2026-11-28 (a string `seq`
 * of "0", a wake `{a: [{id, changeid}], waitSet, seq}`), the same cursor file byte for byte, the same
 * delta proof, and the same notice words. A drift between the two watchers fails here.
 */
class NativeMailWatchTest {
    private fun body(name: String, inner: String) = JSONObject("{\"Body\":{\"$name\":$inner}}")

    @Test
    fun `the requests are the page's`() {
        assertEquals(
            JSONObject("""{"AuthRequest":{"_jsns":"urn:zimbraAccount","account":{"by":"name","_content":"ada@etu.emse.fr"},"password":{"_content":"pw"}}}""").toString(),
            JSONObject(nativeAuthRequest("ada@etu.emse.fr", "pw").toString()).toString(),
        )
        val create = nativeCreateWaitSetRequest("ada@etu.emse.fr").getJSONObject("CreateWaitSetRequest")
        assertEquals("m", create.getString("defTypes"))
        assertEquals("ada@etu.emse.fr", create.getJSONObject("add").getJSONArray("a").getJSONObject(0).getString("name"))
        val wait = nativeWaitSetRequest("ws1", "0").getJSONObject("WaitSetRequest")
        // 300 s, not the page's 60: no relay idle close on the native path, the longest hold measured.
        assertEquals(listOf("ws1", "0", 1, 300), listOf(wait.get("waitSet"), wait.get("seq"), wait.get("block"), wait.get("timeout")))
        val first = nativeInboxPageRequest(null).getJSONObject("SearchRequest")
        assertEquals("inid:\"2\"", first.getString("query"))
        assertEquals(listOf("message", "idDesc", 0, 50), listOf(first.get("types"), first.get("sortBy"), first.get("offset"), first.get("limit")))
        assertFalse(first.has("cursor"))
        val next = nativeInboxPageRequest("120").getJSONObject("SearchRequest").getJSONObject("cursor")
        assertEquals(listOf("120", "120"), listOf(next.get("id"), next.get("sortVal")))
        assertEquals(0, nativeInboxPageRequest("120").getJSONObject("SearchRequest").getInt("offset"))
    }

    @Test
    fun `the envelope carries the token only when there is one`() {
        val bare = soapEnvelope(JSONObject().put("NoOpRequest", JSONObject()), null)
        assertFalse(bare.has("Header"))
        val signed = soapEnvelope(JSONObject().put("NoOpRequest", JSONObject()), "tok")
        assertEquals("tok", signed.getJSONObject("Header").getJSONObject("context").getJSONObject("authToken").getString("_content"))
    }

    @Test
    fun `the measured answers are read`() {
        assertEquals("tok", authTokenOf(body("AuthResponse", """{"authToken":[{"_content":"tok"}]}""")))
        val ws = waitSetOf(body("CreateWaitSetResponse", """{"waitSet":"ws1","defTypes":"m","seq":"0"}"""))
        assertEquals(listOf("ws1", "0"), listOf(ws.id, ws.seq))
        val wake = waitAnswerOf(body("WaitSetResponse", """{"a":[{"id":"acc","changeid":"101"}],"waitSet":"ws1","seq":"7"}"""))
        assertEquals("7", wake.seq)
        assertTrue(wake.changed)
        assertFalse(wake.canceled)
        val idle = waitAnswerOf(body("WaitSetResponse", """{"waitSet":"ws1","seq":"7"}"""))
        assertFalse(idle.changed)
        assertTrue(waitAnswerOf(body("WaitSetResponse", """{"waitSet":"ws1","seq":"0","canceled":true}""")).canceled)
        try {
            waitAnswerOf(body("SearchResponse", "{}"))
            fail("a wait answered with something else is unreadable")
        } catch (_: NativeMailUnreadable) {
        }
    }

    @Test
    fun `a fault is classified as the page classifies it`() {
        val fault = JSONObject("""{"Body":{"Fault":{"Code":{"Value":"soap:Sender"},"Detail":{"Error":{"Code":"admin.NO_SUCH_WAITSET"}}}}}""")
        assertEquals("admin.NO_SUCH_WAITSET", faultCodeOf(fault))
        assertNull(faultCodeOf(body("AuthResponse", "{}")))
        assertEquals(NativeMailFault.WAIT_LOST, nativeFaultOf("admin.NO_SUCH_WAITSET"))
        assertEquals(NativeMailFault.BAD_CREDENTIALS, nativeFaultOf("account.AUTH_FAILED"))
        assertEquals(NativeMailFault.BAD_CREDENTIALS, nativeFaultOf("account.CHANGE_PASSWORD"))
        assertEquals(NativeMailFault.SESSION_EXPIRED, nativeFaultOf("service.AUTH_EXPIRED"))
        assertEquals(NativeMailFault.SESSION_EXPIRED, nativeFaultOf("service.AUTH_REQUIRED"))
        assertEquals(NativeMailFault.OTHER, nativeFaultOf("service.FAILURE"))
    }

    @Test
    fun `the cursor file is the page's, byte for byte, and another mailbox's is not this one's`() {
        // What the page's JSON.stringify({v, account, highest}) writes.
        val pageText = """{"v":1,"account":"ada@etu.emse.fr","highest":11}"""
        assertEquals(NativeCursor("ada@etu.emse.fr", 11), nativeCursorOf(pageText, "Ada@etu.emse.fr"))
        assertEquals(pageText, nativeCursorText(NativeCursor("Ada@etu.emse.fr", 11)))
        assertNull(nativeCursorOf(pageText, "bob@etu.emse.fr"))
        assertNull(nativeCursorOf(null, "ada@etu.emse.fr"))
        assertNull(nativeCursorOf("not json", "ada@etu.emse.fr"))
        assertNull(nativeCursorOf("""{"v":2,"account":"ada@etu.emse.fr","highest":11}""", "ada@etu.emse.fr"))
        assertNull(nativeCursorOf("""{"v":1,"account":"ada@etu.emse.fr","highest":-1}""", "ada@etu.emse.fr"))
    }

    private fun item(id: String, unread: Boolean = true) = NativeInboxItem(id, "-$id", "Sender $id", "s$id@emse.fr", "Subject $id", unread)

    @Test
    fun `the delta stops at the first id at or below the cursor, and pages by the last id`() {
        val cursor = NativeCursor("ada@etu.emse.fr", 10)
        val proven = nativeDeltaStep(NativeInboxPage(listOf(item("12"), item("11"), item("10"), item("9")), more = true), cursor)
        assertEquals(listOf("12", "11"), proven.above.map { it.id })
        assertTrue(proven.proven)
        assertNull(proven.nextAfter)
        val full = nativeDeltaStep(NativeInboxPage(listOf(item("30"), item("acc:99"), item("29")), more = true), cursor)
        assertEquals(listOf("30", "29"), full.above.map { it.id })
        assertEquals("29", full.nextAfter)
        assertNull(nativeDeltaStep(NativeInboxPage(listOf(item("30")), more = false), cursor).nextAfter)
        assertEquals(30L, nativeNextHighest(cursor, full.above))
        assertEquals(10L, nativeNextHighest(cursor, emptyList()))
    }

    @Test
    fun `the baseline is the first numeric id, 0 for an empty inbox`() {
        assertEquals(7L, nativeBaselineOf(NativeInboxPage(listOf(item("acc2:99"), item("7")), more = false)))
        assertEquals(0L, nativeBaselineOf(NativeInboxPage(emptyList(), more = false)))
        assertNull(nativeItemNumber("acc:1"))
        assertNull(nativeItemNumber(""))
        assertEquals(42L, nativeItemNumber("42"))
    }

    @Test
    fun `a search page is read in the measured message shape`() {
        val page = inboxPageOf(body("SearchResponse", """{"more":true,"m":[
            {"cid":"-12","cm":true,"d":12000,"e":[{"t":"f","a":"prof@emse.fr","p":"La Prof"}],"f":"u","fr":"…","id":"12","l":"2","rev":5,"s":100,"sf":"12","su":"Examen"},
            {"cid":"-11","d":11000,"e":[{"t":"t","a":"me@emse.fr"}],"f":"","id":"11","l":"2","su":""}]}"""))
        assertTrue(page.more)
        assertEquals(NativeInboxItem("12", "-12", "La Prof", "prof@emse.fr", "Examen", unread = true), page.items[0])
        assertEquals(NativeInboxItem("11", "-11", null, null, null, unread = false), page.items[1])
    }

    @Test
    fun `a notice says the sender and the subject, never the body, and opens the conversation`() {
        val texts = NativeNoticeTexts("Expéditeur inconnu", "(sans objet)", "Nouveau mail")
        val n = nativeNoticeOf(item("12"), texts)!!.getOrThrow()
        assertEquals(listOf("Sender 12", "Subject 12", "Nouveau mail", "fr.emse.canari://mail/-12"), listOf(n.title, n.body, n.publicTitle, n.link))
        assertEquals(12, n.itemId)
        val bare = nativeNoticeOf(NativeInboxItem("13", null, null, null, null, true), texts)!!.getOrThrow()
        assertEquals(listOf("Expéditeur inconnu", "(sans objet)", "fr.emse.canari://mail"), listOf(bare.title, bare.body, bare.link))
        assertEquals("a@emse.fr", nativeNoticeOf(NativeInboxItem("14", null, null, "a@emse.fr", "s", true), texts)!!.getOrThrow().title)
        assertNull(nativeNoticeOf(item("acc:1"), texts))
        assertTrue(nativeNoticeOf(NativeInboxItem("15", "a/b", null, null, null, true), texts)!!.isFailure)
    }

    @Test
    fun `the retry ladder is the page's`() {
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 256_000L, 300_000L, 300_000L), listOf(1, 2, 3, 8, 9, 50).map(::nativeRetryDelayMs))
    }

    @Test
    fun `the sealed copy is named as Rust erases it, and opens only as its account`() {
        assertEquals("vault_u1.bin", nativeVaultFileName("u1"))
        assertNull(nativeVaultFileName("../u1"))
        assertNull(nativeVaultFileName(""))
        assertEquals("u1", nativeVaultUserOf("vault_u1.bin"))
        assertNull(nativeVaultUserOf("cursor_u1.json"))
        assertNull(nativeVaultUserOf("vault_u1.bin.tmp"))
        assertNull(nativeVaultUserOf("vault_a/b.bin"))
        assertFalse(nativeVaultAad("u1").contentEquals(nativeVaultAad("u2")))
        val record = NativeVaultRecord("Ada@etu.emse.fr", "p\"w")
        assertEquals(NativeVaultRecord("ada@etu.emse.fr", "p\"w"), nativeVaultRecordOf(nativeVaultPlaintext(record)))
        assertNull(nativeVaultRecordOf("{}".toByteArray()))
        assertNull(nativeVaultRecordOf("x".toByteArray()))
    }
}
