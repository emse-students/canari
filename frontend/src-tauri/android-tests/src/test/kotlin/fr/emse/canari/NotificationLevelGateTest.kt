package fr.emse.canari

import fr.emse.canari.push.NotificationLevelGate
import fr.emse.canari.push.NotificationLevelGate.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The one place the Android push path decides whether a `mentions` conversation may alert. */
class NotificationLevelGateTest {
    private val me = "a".repeat(64)
    private val other = "b".repeat(64)

    @Test
    fun `an ordinary frame alerts, on the mentions channel only when it names me`() {
        assertEquals(Decision.Alert(false), NotificationLevelGate.decide(null, setOf(other), me))
        assertEquals(Decision.Alert(true), NotificationLevelGate.decide(null, setOf(me), me))
    }

    @Test
    fun `an ordinary frame that could not be read still alerts - the generic banner is owed`() {
        assertEquals(Decision.Alert(false), NotificationLevelGate.decide(null, null, me))
    }

    @Test
    fun `at mentions, a message naming me alerts on the mentions channel`() {
        assertEquals(Decision.Alert(true), NotificationLevelGate.decide("mentions", setOf(other, me), me))
    }

    @Test
    fun `at mentions, a message naming somebody else is withheld`() {
        assertTrue(NotificationLevelGate.decide("mentions", setOf(other), me) is Decision.Withhold)
        assertTrue(NotificationLevelGate.decide("mentions", emptySet(), me) is Decision.Withhold)
    }

    @Test
    fun `at mentions, what cannot be decided is withheld - the stated rule, not a default`() {
        assertTrue(NotificationLevelGate.decide("mentions", null, me) is Decision.Withhold)
        assertTrue(NotificationLevelGate.decide("mentions", setOf(me), null) is Decision.Withhold)
    }

    @Test
    fun `mentions are read case-insensitively from the whole text, past any preview cut`() {
        val text = "x".repeat(300) + " @[${me.uppercase()}]"
        val ids = NotificationLevelGate.mentionedUserIds(text)
        assertEquals(setOf(me), ids)
        assertEquals(Decision.Alert(true), NotificationLevelGate.decide("mentions", ids, me))
    }
}
