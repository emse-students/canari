package fr.emse.canari

import fr.emse.canari.push.QuickReplyRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * WHO SENDS A REPLY TYPED IN A NOTIFICATION. Read on the Mi 9T, #3912 (2026-11-20): a reply typed
 * with the app in front sat queued for about four minutes, the native encrypt refused by the
 * foreground guard and the retry worker standing down for a page that never heard of it. With the
 * app in front and a manager loaded, the page sends it - at once, with no background transition.
 */
class QuickReplyRouteTest {

    @Test
    fun `an inline reply with the app in front and the page holding the state goes to the page`() {
        assertEquals(QuickReplyRoute.PAGE, QuickReplyRoute.of(appInFront = true) { true })
    }

    @Test
    fun `in the background the native outbox sends it`() {
        assertEquals(QuickReplyRoute.NATIVE, QuickReplyRoute.of(appInFront = false) { true })
    }

    @Test
    fun `in front with no manager loaded (the PIN gate) the native outbox sends it`() {
        assertEquals(QuickReplyRoute.NATIVE, QuickReplyRoute.of(appInFront = true) { false })
    }

    @Test
    fun `the native fact is not asked while the app is in the background`() {
        var asked = false
        QuickReplyRoute.of(appInFront = false) { asked = true; true }
        assertFalse(asked)
    }
}
