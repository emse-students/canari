package fr.emse.canari.push

/**
 * What `CanariApplication.checkKeystoreHealth` concludes when the push context exists, with no
 * Android in it so the JVM suite (`android-tests`) runs it.
 *
 * **A SECRET THE SIGN-OUT ERASED IS NOT A LOST KEYSTORE** (S17, 2026-11-20). An ordinary sign-out
 * erases the push secret on purpose (`PushRegistrationEnd.endForSignOut`), and the check used to
 * read its own erasure as a loss, at ERROR. The erasure is now carried to the check as POSITIVE
 * evidence: a durable mark the sign-out writes after the erasure succeeded, and that the next stored
 * secret removes (`PushSecretKeystore.store`). Nothing else silences the accusation - a secret that
 * is unreadable with no such mark is still [LOST].
 */
enum class KeystoreHealth {
    /** The secret reads back: background push works. */
    OPERATIONAL,

    /** No secret, and the sign-out erased it on purpose with none stored since: nothing is lost. */
    ERASED_BY_SIGN_OUT,

    /** No secret, and nothing explains its absence: the Keystore lost it. */
    LOST;

    companion object {
        /**
         * The verdict, [secretReadable] being whether the stored secret decrypted and
         * [erasedBySignOut] whether the sign-out's erasure mark is on disk.
         */
        fun of(secretReadable: Boolean, erasedBySignOut: Boolean): KeystoreHealth = when {
            secretReadable -> OPERATIONAL
            erasedBySignOut -> ERASED_BY_SIGN_OUT
            else -> LOST
        }
    }
}
