package fr.emse.canari

import fr.emse.canari.push.GroupLocality
import fr.emse.canari.push.SeedFrameLadder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The seed frame a salon push carries (channel-encryption §19), opened by the service's own
 * [SeedFrameLadder] - compiled from the app tree, as [PushDecryptLadderTest] explains.
 *
 * What these pin is the one place it differs from the MLS ladder: a key group this device does not
 * hold is SAID, and never waited on, because the frame is not a conversation being joined.
 */
class SeedFrameLadderTest {

    private enum class Outcome { REFUSED, KEY_MATERIAL, CAUGHT_UP }

    private data class Run(val outcome: Outcome, val log: List<String>, val localityAsked: Int)

    private fun open(
        initial: Outcome,
        locality: GroupLocality,
        catchUp: () -> Outcome? = { error("catch-up must not be called in this scenario") },
    ): Run {
        val log = mutableListOf<String>()
        var asked = 0
        val outcome = SeedFrameLadder.open(
            initial = initial,
            groupTag = "dist1234",
            isRefused = { it == Outcome.REFUSED },
            locality = { asked++; locality },
            catchUp = catchUp,
            log = { log.add(it) },
        )
        return Run(outcome, log, asked)
    }

    @Test
    fun `a frame that opens is used as it is, without asking where the group is`() {
        val run = open(Outcome.KEY_MATERIAL, GroupLocality.LOCAL)

        assertEquals(Outcome.KEY_MATERIAL, run.outcome)
        // The locality costs an MLS load under the state lock; a frame that opened owes none.
        assertEquals(0, run.localityAsked)
        assertTrue(run.log.isEmpty())
    }

    @Test
    fun `a frame one commit ahead of a held key group is opened by the catch-up`() {
        // NOTIF-19's shape: a member joined while the phone was shut, and that join rotated the
        // session - so the frame is sealed at an epoch the phone has not reached.
        val run = open(Outcome.REFUSED, GroupLocality.LOCAL, catchUp = { Outcome.CAUGHT_UP })

        assertEquals(Outcome.CAUGHT_UP, run.outcome)
        assertTrue(run.log.single().contains("locality=LOCAL -> commit catch-up"))
    }

    @Test
    fun `a catch-up that reached nothing leaves the refusal, so the message is held`() {
        val run = open(Outcome.REFUSED, GroupLocality.LOCAL, catchUp = { null })

        assertEquals(Outcome.REFUSED, run.outcome)
    }

    @Test
    fun `a key group this device does not hold is said and not waited on`() {
        // The default catch-up throws: neither a catch-up nor a retry may run for a group that is
        // not here, and there is no pause to inject because none may be taken.
        val run = open(Outcome.REFUSED, GroupLocality.ABSENT)

        assertEquals(Outcome.REFUSED, run.outcome)
        assertTrue(run.log.single().contains("not in the salon's key group"))
    }

    @Test
    fun `an unknown locality establishes nothing and tries nothing`() {
        val run = open(Outcome.REFUSED, GroupLocality.UNKNOWN)

        assertEquals(Outcome.REFUSED, run.outcome)
        assertTrue(run.log.single().contains("locality=UNKNOWN"))
    }
}
