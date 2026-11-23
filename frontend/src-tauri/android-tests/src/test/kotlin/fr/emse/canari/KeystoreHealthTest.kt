package fr.emse.canari

import fr.emse.canari.push.KeystoreHealth
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A SECRET THE SIGN-OUT ERASED IS NOT A LOST KEYSTORE, AND THE MARK EXPLAINS ONLY "NOTHING IS
 * STORED" (S17; review of #4012).
 */
class KeystoreHealthTest {
    private fun of(
        ciphertext: Boolean = false,
        readable: Boolean = false,
        adoptionFailed: Boolean = false,
        mark: Boolean = false,
    ) = KeystoreHealth.of(ciphertext, readable, adoptionFailed, mark)

    @Test
    fun aReadableSecretIsOperationalWhateverTheMarkSays() {
        assertEquals(KeystoreHealth.OPERATIONAL, of(ciphertext = true, readable = true))
        assertEquals(KeystoreHealth.OPERATIONAL, of(ciphertext = true, readable = true, mark = true))
    }

    @Test
    fun nothingStoredAfterTheSignOutIsNotALoss() {
        assertEquals(KeystoreHealth.ERASED_BY_SIGN_OUT, of(mark = true))
    }

    @Test
    fun nothingStoredWithNothingToExplainItIsALoss() {
        assertEquals(KeystoreHealth.LOST, of())
    }

    /** A ciphertext that no longer decrypts is a lost key: the mark cannot explain it. */
    @Test
    fun aCiphertextThatNoLongerDecryptsIsALossWhateverTheMarkSays() {
        assertEquals(KeystoreHealth.LOST, of(ciphertext = true))
        assertEquals(KeystoreHealth.LOST, of(ciphertext = true, mark = true))
    }

    /** A store that threw after a sign-in never hides behind the sign-out's mark. */
    @Test
    fun aPendingSecretThatCouldNotBeStoredIsAccusedEvenUnderTheMark() {
        assertEquals(KeystoreHealth.ADOPTION_FAILED, of(adoptionFailed = true, mark = true))
        assertEquals(KeystoreHealth.ADOPTION_FAILED, of(adoptionFailed = true))
    }
}
