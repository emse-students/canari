package fr.emse.canari

import fr.emse.canari.mail.MailNoticeError
import fr.emse.canari.mail.MailNoticeRefusal
import fr.emse.canari.mail.MailWatchCommand
import fr.emse.canari.mail.MailWatchEffect
import fr.emse.canari.mail.MailWatchMode
import fr.emse.canari.mail.MailWatchSpec
import fr.emse.canari.mail.decideMailWatch
import fr.emse.canari.mail.MailBridgeOp
import fr.emse.canari.mail.mailBridgeMessageAccepted
import fr.emse.canari.mail.mailBridgeOrigins
import fr.emse.canari.mail.mailNoticeOf
import fr.emse.canari.mail.mailSummaryOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mail watch service (mail lots 4 and 4b): the page wins while it watches, a page that goes leaves
 * the watch to the native watcher only when a sealed copy is armed, and the link a new-mail notice
 * opens is an allowlist of the app's own Mail tab.
 */
class MailWatchTest {
    private val spec = MailWatchSpec("Réception des mails", "Canari attend tes nouveaux mails de l'école.")

    private val off = MailWatchMode.OFF
    private val page = MailWatchMode.PAGE
    private val native = MailWatchMode.NATIVE

    @Test
    fun `a page start enters the foreground once, refreshes after, and takes the watch back from native`() {
        for (armed in listOf(false, true)) {
            assertEquals(MailWatchEffect.EnterForeground(spec, page), decideMailWatch(off, MailWatchCommand.Start(spec), armed))
            assertEquals(MailWatchEffect.Refresh(spec), decideMailWatch(page, MailWatchCommand.Start(spec), armed))
            assertEquals(MailWatchEffect.HandToPage(spec), decideMailWatch(native, MailWatchCommand.Start(spec), armed))
        }
    }

    @Test
    fun `a stop ends the whole watch, page or native`() {
        assertTrue(decideMailWatch(page, MailWatchCommand.Stop("switch off"), true) is MailWatchEffect.Leave)
        assertTrue(decideMailWatch(native, MailWatchCommand.Stop("switch off"), true) is MailWatchEffect.Leave)
        assertTrue(decideMailWatch(off, MailWatchCommand.Stop("switch off"), true) is MailWatchEffect.Ignore)
    }

    @Test
    fun `a page that goes hands the watch to native when armed, else leaves`() {
        for (gone in listOf(MailWatchCommand.PageGone, MailWatchCommand.TaskRemoved)) {
            assertEquals(MailWatchEffect.HandToNative, decideMailWatch(page, gone, armed = true))
            assertTrue(decideMailWatch(page, gone, armed = false) is MailWatchEffect.Leave)
            assertTrue(decideMailWatch(native, gone, armed = true) is MailWatchEffect.Ignore)
            assertTrue(decideMailWatch(off, gone, armed = true) is MailWatchEffect.Ignore)
        }
    }

    @Test
    fun `boot, an update or a restart resumes native only when armed and idle`() {
        val resume = MailWatchCommand.Resume(spec)
        assertEquals(MailWatchEffect.EnterForeground(spec, native), decideMailWatch(off, resume, armed = true))
        assertTrue(decideMailWatch(off, resume, armed = false) is MailWatchEffect.Ignore)
        assertTrue(decideMailWatch(page, resume, armed = true) is MailWatchEffect.Ignore)
        assertTrue(decideMailWatch(native, resume, armed = true) is MailWatchEffect.Ignore)
    }

    @Test
    fun `a native run that ends by itself ends the native watch only`() {
        val ended = MailWatchCommand.NativeEnded("the password was refused", run = 3)
        assertTrue(decideMailWatch(native, ended, armed = false, currentRun = 3) is MailWatchEffect.Leave)
        assertTrue(decideMailWatch(page, ended, armed = false, currentRun = 3) is MailWatchEffect.Ignore)
        assertTrue(decideMailWatch(off, ended, armed = false, currentRun = 3) is MailWatchEffect.Ignore)
    }

    @Test
    fun `the end of an earlier native run does not end the run started after it`() {
        // Review minor 2: run 3 ended, run 4 started before the end reached the service.
        val late = MailWatchCommand.NativeEnded("the sealed copy was erased", run = 3)
        assertTrue(decideMailWatch(native, late, armed = true, currentRun = 4) is MailWatchEffect.Ignore)
    }

    @Test
    fun `a page gone in NATIVE with no run left starts one, or leaves when nothing is sealed`() {
        // Second round, 3: a reload handed the watch to native, a new page claimed it (the run is
        // joined), its start was refused off screen, then the activity went - NATIVE with no run.
        val gone = MailWatchCommand.PageGone
        assertEquals(MailWatchEffect.HandToNative, decideMailWatch(native, gone, armed = true, nativeAlive = false))
        assertTrue(decideMailWatch(native, gone, armed = false, nativeAlive = false) is MailWatchEffect.Leave)
        assertTrue(decideMailWatch(native, gone, armed = true, nativeAlive = true) is MailWatchEffect.Ignore)
        assertEquals(MailWatchEffect.HandToNative, decideMailWatch(native, MailWatchCommand.TaskRemoved, armed = true, nativeAlive = false))
    }

    @Test
    fun `a forget ends a native watch and leaves the page's to the page`() {
        // Review B1: erase while NATIVE, with no page running - the service leaves.
        assertTrue(decideMailWatch(native, MailWatchCommand.Forgotten, armed = false) is MailWatchEffect.Leave)
        assertTrue(decideMailWatch(page, MailWatchCommand.Forgotten, armed = false) is MailWatchEffect.Ignore)
        assertTrue(decideMailWatch(off, MailWatchCommand.Forgotten, armed = false) is MailWatchEffect.Ignore)
    }

    @Test
    fun `a notice opens the Mail tab and nothing else`() {
        val ok = mailNoticeOf(11515, "Ada", "Hello", "Nouveau mail", "fr.emse.canari://mail/-11515")
        assertEquals(11515, ok.getOrThrow().itemId)
        assertTrue(mailNoticeOf(1, "Ada", "", "Nouveau mail", "fr.emse.canari://mail").isSuccess)
        for (link in listOf(
            "https://evil.example/mail",
            "fr.emse.canari://chat/abc",
            "fr.emse.canari://mail/a/b",
            "fr.emse.canari://mail/a?x=1",
            "fr.emse.canari://mail/",
            "fr.emse.canari://mailbox",
            "",
        )) {
            assertEquals(link, MailNoticeRefusal.LINK, refusal(mailNoticeOf(1, "Ada", "s", "Nouveau mail", link)))
        }
    }

    @Test
    fun `a notice needs an item id and its texts`() {
        assertEquals(MailNoticeRefusal.ITEM_ID, refusal(mailNoticeOf(-1, "Ada", "s", "Nouveau mail", "fr.emse.canari://mail")))
        assertEquals(MailNoticeRefusal.ITEM_ID, refusal(mailNoticeOf(1L shl 40, "Ada", "s", "Nouveau mail", "fr.emse.canari://mail")))
        assertEquals(MailNoticeRefusal.TEXT, refusal(mailNoticeOf(1, " ", "s", "Nouveau mail", "fr.emse.canari://mail")))
        assertEquals(MailNoticeRefusal.TEXT, refusal(mailNoticeOf(1, "Ada", "s", "", "fr.emse.canari://mail")))
    }

    @Test
    fun `a summary counts at least one mail and opens the Mail tab only`() {
        assertEquals(12, mailSummaryOf(12, "12 nouveaux mails", "Dans ta boîte", "Nouveau mail", "fr.emse.canari://mail").getOrThrow().count)
        assertEquals(MailNoticeRefusal.ITEM_ID, refusal(mailSummaryOf(0, "t", "b", "p", "fr.emse.canari://mail")))
        assertEquals(MailNoticeRefusal.LINK, refusal(mailSummaryOf(3, "t", "b", "p", "https://evil.example")))
        assertEquals(MailNoticeRefusal.TEXT, refusal(mailSummaryOf(3, "", "b", "p", "fr.emse.canari://mail")))
    }

    @Test
    fun `the bridge acts only on the app's top frame`() {
        val app = setOf("http://tauri.localhost")
        assertTrue(mailBridgeMessageAccepted(true, "http://tauri.localhost", app))
        assertTrue(!mailBridgeMessageAccepted(false, "http://tauri.localhost", app))
        assertTrue(!mailBridgeMessageAccepted(true, "null", app))
        assertTrue(!mailBridgeMessageAccepted(true, null, app))
        // No wildcard any more (review minor 8): `*` is a string like any other.
        assertTrue(!mailBridgeMessageAccepted(true, "http://10.0.0.2:5173", setOf("*")))
    }

    @Test
    fun `the bridge listens to the app's origin, and to the dev server's in debug only`() {
        assertEquals(setOf("http://tauri.localhost"), mailBridgeOrigins(debug = false, devHost = "192.168.1.20"))
        assertEquals(
            setOf("http://tauri.localhost", "http://127.0.0.1:1420", "http://localhost:1420"),
            mailBridgeOrigins(debug = true, devHost = ""),
        )
        assertTrue("http://192.168.1.20:1420" in mailBridgeOrigins(debug = true, devHost = "192.168.1.20"))
        // A host that would smuggle a path or a port is not added.
        assertEquals(3, mailBridgeOrigins(debug = true, devHost = "evil.example/x").size)
        assertEquals(3, mailBridgeOrigins(debug = true, devHost = "a:1").size)
    }

    @Test
    fun `the bridge knows its nine ops and nothing else`() {
        assertEquals(
            listOf("start", "stop", "notify", "summary", "page", "claim", "arm", "forget", "release"),
            MailBridgeOp.entries.map { it.wire },
        )
        assertEquals(MailBridgeOp.STOP, MailBridgeOp.of("stop"))
        assertEquals(MailBridgeOp.SUMMARY, MailBridgeOp.of("summary"))
        assertEquals(null, MailBridgeOp.of("eval"))
    }

    private fun refusal(result: Result<*>): MailNoticeRefusal? = (result.exceptionOrNull() as? MailNoticeError)?.refusal
}
