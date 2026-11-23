package fr.emse.canari.push

/**
 * What `CanariApplication.checkKeystoreHealth` concludes when the push context exists, with no
 * Android in it so the JVM suite (`android-tests`) runs it.
 *
 * **A SECRET THE SIGN-OUT ERASED IS NOT A LOST KEYSTORE** (S17, 2026-11-20). An ordinary sign-out
 * erases the push secret on purpose (`PushRegistrationEnd.endForSignOut`), and the check used to
 * read its own erasure as a loss, at ERROR. The erasure is now carried to the check as POSITIVE
 * evidence: a durable mark the sign-out writes after the erasure succeeded, and that the next store
 * removes BEFORE it writes its ciphertext (`PushSecretKeystore.store`).
 *
 * **THE MARK EXPLAINS ONE FACT ONLY: NOTHING IS STORED** (review of #4012). "No ciphertext" (what a
 * sign-out leaves) and "a ciphertext that no longer decrypts" (a Keystore key gone) are two facts;
 * the mark explains the first, and the second is [LOST] whatever the mark says. A pending secret the
 * same pass failed to store is [ADOPTION_FAILED], so a store that throws after a sign-in never hides
 * behind the sign-out's mark.
 */
enum class KeystoreHealth {
    /** The secret reads back: background push works. */
    OPERATIONAL,

    /** Nothing stored, and the sign-out erased it on purpose with none stored since: nothing is lost. */
    ERASED_BY_SIGN_OUT,

    /** A pending secret was there and could not be stored in this pass. */
    ADOPTION_FAILED,

    /** A ciphertext that no longer decrypts, or nothing stored with nothing to explain it. */
    LOST;

    companion object {
        /**
         * The verdict. [ciphertextPresent]: a ciphertext is stored, decryptable or not.
         * [secretReadable]: it decrypted. [adoptionFailed]: the pending secret's move into the
         * Keystore failed in the same pass. [erasedBySignOut]: the sign-out's erasure mark is on disk.
         */
        fun of(
            ciphertextPresent: Boolean,
            secretReadable: Boolean,
            adoptionFailed: Boolean,
            erasedBySignOut: Boolean,
        ): KeystoreHealth = when {
            secretReadable -> OPERATIONAL
            ciphertextPresent -> LOST
            adoptionFailed -> ADOPTION_FAILED
            erasedBySignOut -> ERASED_BY_SIGN_OUT
            else -> LOST
        }
    }
}
