package fr.emse.canari

import fr.emse.canari.mail.MAIL_FORGET_TYPE
import fr.emse.canari.mail.MAIL_PUSH_TYPE
import fr.emse.canari.mail.MailPushRoute
import fr.emse.canari.mail.forgetApplies
import fr.emse.canari.mail.mailPushRouteOf
import fr.emse.canari.mail.registrationFingerprintOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    fun anEndedSessionNamesItsRegistration() {
        assertEquals(
            MailPushRoute.Forget("u1", "ab"),
            mailPushRouteOf(mapOf("type" to MAIL_FORGET_TYPE, "userId" to "u1", "scope" to "session", "registration" to "ab")),
        )
        assertEquals(
            MailPushRoute.Forget("u1", ""),
            mailPushRouteOf(mapOf("type" to MAIL_FORGET_TYPE, "userId" to "u1", "scope" to "session")),
        )
        assertEquals(
            MailPushRoute.Forget("u1", null),
            mailPushRouteOf(mapOf("type" to MAIL_FORGET_TYPE, "userId" to "u1", "scope" to "device")),
        )
    }

    @Test
    fun theFingerprintIsTheSharedVector() {
        // The vector of mailPushSecret.test.ts and mail_push_secret.rs.
        assertEquals("57cad23f03e18d65f03c862440581f69", registrationFingerprintOf("0123456789abcdef0123456789abcdef"))
    }

    @Test
    fun aDeviceThatSignedInAgainKeepsItsMailbox() {
        val raw = "0123456789abcdef0123456789abcdef"
        val mine = MailPushRoute.Forget("u1", registrationFingerprintOf(raw))
        val other = MailPushRoute.Forget("u1", registrationFingerprintOf("f".repeat(32)))
        assertTrue(forgetApplies(mine, raw, signedOut = false))
        assertFalse(forgetApplies(other, raw, signedOut = false))
        assertTrue(forgetApplies(other, null, signedOut = true))
        assertFalse(forgetApplies(mine, null, signedOut = false))
        assertFalse(forgetApplies(MailPushRoute.Forget("u1", ""), raw, signedOut = false))
        assertTrue(forgetApplies(MailPushRoute.Forget("u1", null), raw, signedOut = false))
    }

    @Test
    fun anyOtherPushIsNotAMailPush() {
        assertNull(mailPushRouteOf(mapOf("type" to "social")))
        assertNull(mailPushRouteOf(emptyMap()))
    }
}
