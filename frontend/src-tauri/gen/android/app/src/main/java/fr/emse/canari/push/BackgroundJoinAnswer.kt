package fr.emse.canari.push

/**
 * WHAT THE NATIVE BACKGROUND JOIN OF A WELCOME ANSWERED (`nativeProcessWelcomeBackground`).
 *
 * It used to answer a bare boolean, so the phone's log read `join failed` with no cause: a refused
 * write (the app is on screen and joins the group itself) and a Welcome that never installs from
 * this state were one line, at error level, and the Rust line that told them apart is lost in a
 * killed app. The answer is now a TOKEN classified where it is thrown (`BackgroundJoinError`):
 * `joined`, or `failed:<cause>:<prospect>`. A group the state already holds is `joined`
 * (`process_welcome` answers it with success).
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object BackgroundJoinAnswer {

    /** The classified answer. */
    sealed class Outcome {
        /** The group is installed (or was already held). */
        object Joined : Outcome()

        /**
         * The join did not install. [cause] is the native cause token (`write-refused`,
         * `welcome-refused`, `state-unreadable`, or `unclassified` for a token this build was not
         * taught); [prospect] says whether a later attempt can succeed.
         */
        data class Failed(val cause: String, val prospect: OutboxRetry.Prospect) : Outcome()
    }

    /** Reads the token the native join answered; anything unreadable is a failure said as such. */
    fun parse(token: String?): Outcome {
        if (token == "joined") return Outcome.Joined
        val parts = token?.split(':').orEmpty()
        if (parts.size == 3 && parts[0] == "failed" && parts[1].isNotEmpty()) {
            return Outcome.Failed(parts[1], OutboxRetry.Prospect.of(parts[2]))
        }
        return Outcome.Failed("unclassified", OutboxRetry.Prospect.NOT_YET)
    }
}
