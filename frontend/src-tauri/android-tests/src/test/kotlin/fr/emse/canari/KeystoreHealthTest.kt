package fr.emse.canari

import fr.emse.canari.push.KeystoreHealth
import org.junit.Assert.assertEquals
import org.junit.Test

/** A SECRET THE SIGN-OUT ERASED IS NOT A LOST KEYSTORE, AND ONLY THAT EVIDENCE SILENCES THE ACCUSATION (S17). */
class KeystoreHealthTest {
    @Test
    fun aReadableSecretIsOperationalWhateverTheMarkSays() {
        assertEquals(KeystoreHealth.OPERATIONAL, KeystoreHealth.of(secretReadable = true, erasedBySignOut = false))
        // A stale mark next to a stored secret changes nothing: the secret is there.
        assertEquals(KeystoreHealth.OPERATIONAL, KeystoreHealth.of(secretReadable = true, erasedBySignOut = true))
    }

    @Test
    fun anAbsenceTheSignOutWroteIsNotALoss() {
        assertEquals(KeystoreHealth.ERASED_BY_SIGN_OUT, KeystoreHealth.of(secretReadable = false, erasedBySignOut = true))
    }

    @Test
    fun anAbsenceNothingExplainsIsStillALoss() {
        assertEquals(KeystoreHealth.LOST, KeystoreHealth.of(secretReadable = false, erasedBySignOut = false))
    }
}
