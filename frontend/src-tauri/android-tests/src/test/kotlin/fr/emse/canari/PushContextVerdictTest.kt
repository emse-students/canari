package fr.emse.canari

import fr.emse.canari.push.PushContextVerdict
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Why `push_context.json` cannot be used, as every background reader now logs it
 * (`PushContextVerdict`): "absent" and "invalid: <field> missing" are different defects.
 */
class PushContextVerdictTest {

    private fun verdictOf(vararg fields: Pair<String, String>): PushContextVerdict {
        val map = fields.toMap()
        return PushContextVerdict.of { map[it] ?: "" }
    }

    @Test
    fun `a context naming who, which device and which server is usable`() {
        val v = verdictOf("userId" to "u", "deviceId" to "d", "baseUrl" to "https://x", "locale" to "fr")
        assertEquals(PushContextVerdict.Usable, v)
    }

    @Test
    fun `the file a sign-out strip leaves is named as such - baseUrl missing, the identity kept`() {
        // `keep_device_context_only` (push_registration.rs) keeps userId, deviceId, locale.
        val v = verdictOf("userId" to "u", "deviceId" to "d", "locale" to "fr")
        assertEquals(PushContextVerdict.Incomplete(listOf("baseUrl"), signedOut = true), v)
        assertEquals(
            "invalid: baseUrl missing (the shape a sign-out leaves - no sign-in rewrote it)",
            v.describe(),
        )
    }

    @Test
    fun `any other missing field is named, and is not called a sign-out`() {
        val v = verdictOf("deviceId" to "d", "baseUrl" to "https://x")
        assertEquals(PushContextVerdict.Incomplete(listOf("userId"), signedOut = false), v)
        assertEquals("invalid: userId missing", v.describe())
        assertEquals(
            "invalid: userId,deviceId,baseUrl missing",
            verdictOf().describe(),
        )
    }

    @Test
    fun `absent and unreadable each say so, and differently`() {
        assertEquals("absent", PushContextVerdict.Absent.describe())
        assertEquals("unreadable (JSONException)", PushContextVerdict.Unreadable("JSONException").describe())
    }
}
