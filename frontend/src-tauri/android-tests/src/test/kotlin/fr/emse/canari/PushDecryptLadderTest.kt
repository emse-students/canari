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
 * catch-up and the locality query all arrive as lambdas, and the
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

    /** Drives [PushRecoveryLadder.run] with fakes and collects the log. */
    private fun ladder(
        initial: Outcome,
        locality: () -> GroupLocality,
        catchUp: () -> Outcome? = { error("catch-up must not be called in this scenario") },
    ): Run {
        val log = mutableListOf<String>()
        val outcome = PushRecoveryLadder.run(
            initial = initial,
            groupTag = "abcd1234",
            isRefused = { it == Outcome.REFUSED },
            locality = locality,
            catchUp = catchUp,
            log = { log.add(it) },
        )
        return Run(outcome, log)
    }

    @Test
    fun `local group with lagging epoch runs catch-up`() {
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.LOCAL },
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
            catchUp = { null },
        )

        assertEquals("a catch-up with no answer must not invent one", Outcome.REFUSED, r.outcome)
    }

    /**
     * NO CLOCK, AND NO SECOND DECRYPT (user, 2026-09-28: "Supprime ce delai"). An absent group whose
     * Welcome is queued on the push lane never reaches this ladder - the caller re-queues the frame
     * behind it - so nothing this thread could wait for would join it. It used to sleep 3 x 1.8 s on
     * the one push lane; measured on NOTIF-21, that sleep sat in front of the very Welcome it waited
     * for. The frame now goes where UNKNOWN goes, and neither recovery runs.
     */
    @Test
    fun `absent group waits for nothing and runs no recovery`() {
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.ABSENT },
        )

        assertEquals(Outcome.REFUSED, r.outcome)
        assertEquals(
            listOf(
                "tryDecrypt refused group=abcd1234 locality=ABSENT",
                "group not joined here and no Welcome for it is queued group=abcd1234 -> leaving it to the worker",
            ),
            r.log,
        )
    }

    /**
     * THE REGRESSION THAT COST THE APP ITS PROCESS.
     *
     * An unreadable MLS state used to answer "the group is not local", which was the ABSENT branch's
     * Welcome-race loop (deleted 2026-09-28) - three more decrypt attempts against the very lock that
     * could not be taken, per push, across every thread of a backlog. Measured on device 2026-08-11: 97 lock timeouts and 60 race
     * retries, ending in `ActivityManager: Killing fr.emse.canari (adj 905): excessive cpu`.
     *
     * UNKNOWN must therefore reach no recovery: the catch-up answers an epoch gap, and nothing here
     * has established one.
     */
    @Test
    fun `unknown locality runs no recovery at all`() {
        val r = ladder(
            initial = Outcome.REFUSED,
            locality = { GroupLocality.UNKNOWN },
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
