package fr.emse.canari.push

/**
 * WHAT THE NATIVE BACKGROUND JOIN OF A WELCOME ANSWERED (`nativeProcessWelcomeBackground`).
 *
 * It used to answer a bare boolean, so the phone's log read `join failed` with no cause: a refused
 * write (the app is on screen and joins the group itself) and a Welcome that never installs from
 * this state were one line, at error level, and the Rust line that told them apart is lost in a
 * killed app. The answer is now a TOKEN classified where it is thrown, from the typed `MlsError`
 * (`BackgroundJoinError`): `joined`, or `failed:<cause>:<prospect>`. A group the state already holds
 * is `joined` (`process_welcome` answers it with success).
 *
 * THE CONTRACT IS CLOSED AND SHARED: `libs/contracts/background-join-answer.cases.json`, read by the
 * Rust and the Kotlin tests. The cause is one of [CAUSES], the prospect exactly `not-yet` or
 * `never`; anything else - a token from a newer build, a null, a malformed answer - is
 * [Outcome.Unreadable], which the caller says at ERROR with the raw text.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object BackgroundJoinAnswer {

    /** EVERY cause the native side can write: the closed set of the contract. */
    val CAUSES: Set<String> = setOf(
        "state-unreadable",
        "welcome-malformed",
        "welcome-refused",
        "write-refused",
        "jni",
    )

    /** The classified answer. */
    sealed class Outcome {
        /** The group is installed (or was already held). */
        object Joined : Outcome()

        /** The join did not install; [cause] is one of [CAUSES], [prospect] says if a retry can. */
        data class Failed(val cause: String, val prospect: OutboxRetry.Prospect) : Outcome()

        /** An answer outside the contract: said at error with [raw], never guessed at. */
        data class Unreadable(val raw: String?) : Outcome()
    }

    /** Reads the token the native join answered. */
    fun parse(token: String?): Outcome {
        if (token == "joined") return Outcome.Joined
        val parts = token?.split(':').orEmpty()
        if (parts.size == 3 && parts[0] == "failed" && parts[1] in CAUSES) {
            val prospect = when (parts[2]) {
                "not-yet" -> OutboxRetry.Prospect.NOT_YET
                "never" -> OutboxRetry.Prospect.NEVER
                else -> return Outcome.Unreadable(token)
            }
            return Outcome.Failed(parts[1], prospect)
        }
        return Outcome.Unreadable(token)
    }
}
