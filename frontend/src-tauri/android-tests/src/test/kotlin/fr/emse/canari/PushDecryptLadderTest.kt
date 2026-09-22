package fr.emse.canari

import fr.emse.canari.push.GroupLocality
import fr.emse.canari.push.PushRecoveryLadder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THIS SUITE RUNS THE SERVICE'S OWN LADDER, NOT A DESCRIPTION OF IT.
 *
 * `PushRecoveryLadder` is compiled from `gen/android/app/src/main/java/fr/emse/canari/push` by this
 * project AND by the app module (see `build.gradle.kts` at the root of this project). It used to be
 * restated here as a private `runLadder`, which meant the suite could not fail when
 * `CanariFirebaseMessagingService` changed - the green tick said only that the mirror still agreed
 * with itself.
 *
 * Nothing here touches Android or JNI, because the ladder does not either: the decrypt, the
 * catch-up, the locality query and the wait between two retries all arrive as lambdas, and the
 * outcome is whatever type the caller uses - here an [Outcome], so a run reads as its own trace.
 */
class PushDecryptLadderTest {

    /**
     * The outcome the fakes pass around. `REFUSED` is the only value the ladder reacts to, which is
     * exactly what it knows about the service's `PushDecrypt` sealed interface.
     */
    private enum class Outcome { REFUSED, DECRYPTED, CAUGHT_UP }

    /** A run: what it ended on, and every line the ladder logged, in order. */
    private data class Run(val outcome: Outcome, val log: List<String>)

    /**
     * Drives [PushRecoveryLadder.run] with fakes and collects the log.
     *
     * The default [pause] is instantaneous and always succeeds, so no test here waits on a clock or
     * asserts one.
     */
    private fun ladder(
        initial: Outcome,
        locality: () -> GroupLocality,
        retryDecrypt: () -> Outcome = { Outcome.REFUSED },
        catchUp: () -> Outcome? = { error("catch-up must not be called in this scenario") },
        pause: () -> Boolean = { true },
    ): Run {
        val log = mutableListOf<String>()
        val outcome = PushRecoveryLadder.run(
            initial = initial,
            groupTag = "abcd1234",
            isRefused = { it == Outcome.REFUSED },
            locality = locality,
            retryDecrypt = retryDecrypt,
            catchUp = catchUp,
            pause = pause,
            log = { log.add(it) },
        )
        return Run(outcome, log)
    }

    @Test
    fun `local group with lagging epoch runs catch-up and never races a welcome`() {
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.LOCAL },
            retryDecrypt = { error("a joined group is not racing a Welcome") },
            catchUp = { Outcome.CAUGHT_UP },
        )

        assertEquals(Outcome.CAUGHT_UP, r.outcome)
        assertEquals(listOf("tryDecrypt refused group=abcd1234 locality=LOCAL"), r.log)
    }

    @Test
    fun `a local catch-up that produces nothing leaves the outcome refused`() {
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.LOCAL },
            retryDecrypt = { error("a joined group is not racing a Welcome") },
            catchUp = { null },
        )

        assertEquals("a catch-up with no answer must not invent one", Outcome.REFUSED, r.outcome)
    }

    @Test
    fun `absent group retries the welcome race and catches up if the group appears`() {
        // The locality is read once before the race (ABSENT) and once after (LOCAL), so the late
        // catch-up runs.
        val answers = mutableListOf(GroupLocality.ABSENT, GroupLocality.LOCAL)
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { answers.removeAt(0) },
            catchUp = { Outcome.CAUGHT_UP },
        )

        assertEquals(Outcome.CAUGHT_UP, r.outcome)
        assertEquals(
            listOf(
                "tryDecrypt refused group=abcd1234 locality=ABSENT",
                "tryDecrypt retry 1/3 (group-join race) group=abcd1234",
                "tryDecrypt retry 2/3 (group-join race) group=abcd1234",
                "tryDecrypt retry 3/3 (group-join race) group=abcd1234",
                "group appeared during welcome-race, attempting catch-up group=abcd1234",
            ),
            r.log,
        )
    }

    @Test
    fun `a welcome that lands mid-race stops the retries there`() {
        var attempts = 0
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.ABSENT },
            retryDecrypt = {
                attempts++
                if (attempts == 2) Outcome.DECRYPTED else Outcome.REFUSED
            },
        )

        assertEquals(Outcome.DECRYPTED, r.outcome)
        assertEquals("the race must stop on the first success", 2, attempts)
        assertTrue(
            "no third retry once the frame decrypted",
            r.log.none { it.startsWith("tryDecrypt retry 3/") },
        )
    }

    @Test
    fun `absent group that stays absent never runs catch-up`() {
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.ABSENT },
        )

        assertEquals(Outcome.REFUSED, r.outcome)
        assertEquals(
            listOf(
                "tryDecrypt refused group=abcd1234 locality=ABSENT",
                "tryDecrypt retry 1/3 (group-join race) group=abcd1234",
                "tryDecrypt retry 2/3 (group-join race) group=abcd1234",
                "tryDecrypt retry 3/3 (group-join race) group=abcd1234",
            ),
            r.log,
        )
    }

    @Test
    fun `an interrupted wait abandons the race instead of spinning through it`() {
        // A thread interrupted between two retries has been asked to stop. Continuing the loop
        // would run the remaining attempts back to back with no wait at all, which is the one
        // shape the delay exists to prevent.
        var attempts = 0
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.ABSENT },
            retryDecrypt = {
                attempts++
                Outcome.REFUSED
            },
            pause = { false },
        )

        assertEquals(0, attempts)
        assertEquals(listOf("tryDecrypt refused group=abcd1234 locality=ABSENT"), r.log)
    }

    /**
     * THE REGRESSION THAT COST THE APP ITS PROCESS.
     *
     * An unreadable MLS state used to answer "the group is not local", which is the ABSENT branch -
     * three more decrypt attempts against the very lock that could not be taken, per push, across
     * every thread of a backlog. Measured on device 2026-08-11: 97 lock timeouts and 60 race
     * retries, ending in `ActivityManager: Killing fr.emse.canari (adj 905): excessive cpu`.
     *
     * UNKNOWN must therefore reach neither recovery: the catch-up answers an epoch gap and the race
     * answers a pending join, and nothing here has established either.
     */
    @Test
    fun `unknown locality runs no recovery at all`() {
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.UNKNOWN },
            retryDecrypt = { error("no welcome race may run on an unknown locality") },
        )

        assertEquals(Outcome.REFUSED, r.outcome)
        assertEquals(
            listOf(
                "tryDecrypt refused group=abcd1234 locality=UNKNOWN",
                "locality unknown group=abcd1234 -> leaving it to the worker",
            ),
            r.log,
        )
    }

    @Test
    fun `a successful direct decrypt skips the ladder entirely`() {
        val r = ladder(
            initial = Outcome.DECRYPTED,
            locality = { error("the locality must not even be queried") },
        )

        assertEquals(Outcome.DECRYPTED, r.outcome)
        assertTrue("a decrypted frame logs nothing about recovery", r.log.isEmpty())
    }
}
