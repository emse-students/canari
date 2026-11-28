package fr.emse.canari

import fr.emse.canari.mail.MAIL_FORGET_TYPE
import fr.emse.canari.mail.MAIL_PUSH_TYPE
import fr.emse.canari.mail.MailPushRoute
import fr.emse.canari.mail.mailPushRouteOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mail lot 5: which push the mail half of the app answers, and how. */
class MailPushTest {
    @Test
    fun theEmptyMailPushAsksForACheck() {
        assertEquals(MailPushRoute.Check, mailPushRouteOf(mapOf("type" to MAIL_PUSH_TYPE)))
    }

    @Test
    fun theRemoteForgetNamesItsAccountOrErasesNothing() {
        assertEquals(
            MailPushRoute.Forget("u1"),
            mailPushRouteOf(mapOf("type" to MAIL_FORGET_TYPE, "userId" to "u1")),
        )
        assertEquals(MailPushRoute.ForgetWithoutAccount, mailPushRouteOf(mapOf("type" to MAIL_FORGET_TYPE)))
        assertEquals(
            MailPushRoute.ForgetWithoutAccount,
            mailPushRouteOf(mapOf("type" to MAIL_FORGET_TYPE, "userId" to " ")),
        )
    }

    @Test
    fun anyOtherPushIsNotAMailPush() {
        assertNull(mailPushRouteOf(mapOf("type" to "social")))
        assertNull(mailPushRouteOf(emptyMap()))
    }
}
