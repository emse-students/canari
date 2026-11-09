package fr.emse.canari.push

/**
 * WHY `push_context.json` CANNOT BE USED, CLASSIFIED WHERE IT IS READ (2026-11-07).
 *
 * Every background reader logged ONE line - `push_context.json absent or invalid` - for two causes
 * that call for different fixes: no file at all (never signed in on this install, or a wiped one)
 * and a file missing a field. The second is what a sign-out leaves on purpose (`push_registration.rs`
 * `keep_device_context_only` keeps `userId`, `deviceId`, `locale` and drops `baseUrl`), and it is
 * what a phone that signed back in by biometrics kept for days, because the sign-in never rewrote
 * the file (`docs/wiki/protocols/content-free-push.md`, "Who writes push_context.json").
 * A line that cannot tell those apart sends its reader to the wrong one.
 *
 * Pure Kotlin, no Android import: the parse stays in `MlsContextLoader` (`org.json` is Android's
 * here), which hands this the fields it read, so `android-tests` compiles and tests this file as it is.
 */
sealed interface PushContextVerdict {
    /** Every required field is present - the context is usable. */
    object Usable : PushContextVerdict

    /** No file. A fresh or wiped install, or a session that never stored its context. */
    object Absent : PushContextVerdict

    /** A file that is not a JSON object, or could not be read: `why` is the exception's class. */
    data class Unreadable(val why: String) : PushContextVerdict

    /**
     * A JSON object missing `missing`, in [REQUIRED_PUSH_CONTEXT_FIELDS] order. `signedOut` is the
     * exact shape a sign-out strip leaves - the identity is there, only the session's half is gone.
     */
    data class Incomplete(val missing: List<String>, val signedOut: Boolean) : PushContextVerdict

    companion object {
        /** The fields every background reader needs: who, which device, and which server. */
        val REQUIRED_PUSH_CONTEXT_FIELDS = listOf("userId", "deviceId", "baseUrl")

        /** The identity keys a sign-out keeps (`DEVICE_CONTEXT_KEYS` in `push_registration.rs`). */
        private val KEPT_BY_SIGN_OUT = listOf("userId", "deviceId")

        /** Classifies a parsed JSON object through `field`, which answers "" for an absent key. */
        fun of(field: (String) -> String): PushContextVerdict {
            val missing = REQUIRED_PUSH_CONTEXT_FIELDS.filter { field(it).isEmpty() }
            if (missing.isEmpty()) return Usable
            val signedOut = KEPT_BY_SIGN_OUT.all { field(it).isNotEmpty() } && missing == listOf("baseUrl")
            return Incomplete(missing, signedOut)
        }
    }

    /** The words a log line carries for this verdict - never a field's VALUE, which names a person. */
    fun describe(): String = when (this) {
        Usable -> "usable"
        Absent -> "absent"
        is Unreadable -> "unreadable ($why)"
        is Incomplete ->
            "invalid: ${missing.joinToString(",")} missing" +
                if (signedOut) " (the shape a sign-out leaves - no sign-in rewrote it)" else ""
    }
}
