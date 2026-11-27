package fr.emse.canari

import fr.emse.canari.mail.MailNoticeError
import fr.emse.canari.mail.MailNoticeRefusal
import fr.emse.canari.mail.MailWatchCommand
import fr.emse.canari.mail.MailWatchEffect
import fr.emse.canari.mail.MailWatchSpec
import fr.emse.canari.mail.decideMailWatch
import fr.emse.canari.mail.mailNoticeOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mail watch service (mail lot 4): it never outlives the page that runs the watcher, and the
 * link a new-mail notice opens is an allowlist of the app's own Mail tab.
 */
class MailWatchTest {
    private val spec = MailWatchSpec("Réception des mails", "Canari attend tes nouveaux mails de l'école.")

    @Test
    fun `a start enters the foreground once and refreshes after`() {
        assertEquals(MailWatchEffect.EnterForeground(spec), decideMailWatch(false, MailWatchCommand.Start(spec)))
        assertEquals(MailWatchEffect.Refresh(spec), decideMailWatch(true, MailWatchCommand.Start(spec)))
    }

    @Test
    fun `the switch off, the page gone or the task removed all leave`() {
        assertTrue(decideMailWatch(true, MailWatchCommand.Stop("switch off")) is MailWatchEffect.Leave)
        assertTrue(decideMailWatch(true, MailWatchCommand.PageGone) is MailWatchEffect.Leave)
        assertTrue(decideMailWatch(true, MailWatchCommand.TaskRemoved) is MailWatchEffect.Leave)
    }

    @Test
    fun `with no watch held every end is ignored`() {
        assertTrue(decideMailWatch(false, MailWatchCommand.Stop("switch off")) is MailWatchEffect.Ignore)
        assertTrue(decideMailWatch(false, MailWatchCommand.PageGone) is MailWatchEffect.Ignore)
        assertTrue(decideMailWatch(false, MailWatchCommand.TaskRemoved) is MailWatchEffect.Ignore)
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

    private fun refusal(result: Result<*>): MailNoticeRefusal? = (result.exceptionOrNull() as? MailNoticeError)?.refusal
}
