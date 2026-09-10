package fr.emse.canari

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies the intended order of the background MLS decrypt ladder without depending on
 * Android/JNI native code. The real service methods are private and JNI-bound; this suite
 * exercises the ladder as a pure Kotlin state machine with the same branching rules.
 */
class PushDecryptLadderTest {

    /** Mirror of the service's `GroupLocality`: the third value is the point of it. */
    enum class Locality { LOCAL, ABSENT, UNKNOWN }

    /** Minimal version of the service ladder to make the order explicit and testable. */
    private fun runLadder(
        initialDecryptFails: Boolean,
        locality: () -> Locality,
        tryDecrypt: () -> Boolean,
        tryCatchup: () -> Boolean,
    ): Result {
        val steps = mutableListOf<String>()
        steps.add("tryDecrypt")
        if (!initialDecryptFails) return Result(success = true, catchupFirst = false, steps = steps)

        if (tryDecrypt()) {
            return Result(success = true, catchupFirst = false, steps = steps)
        }

        return when (locality()) {
            Locality.UNKNOWN -> {
                // Neither recovery is an answer to "I could not tell", so neither runs.
                steps.add("locality=UNKNOWN")
                Result(success = false, catchupFirst = false, steps = steps)
            }
            Locality.LOCAL -> {
                steps.add("locality=LOCAL")
                val ok = tryCatchup()
                if (ok) steps.add("tryCatchup")
                Result(success = ok, catchupFirst = true, steps = steps)
            }
            Locality.ABSENT -> {
                steps.add("locality=ABSENT")
                var raceAttempt = 0
                var ok = false
                while (raceAttempt < 3 && !ok) {
                    raceAttempt++
                    steps.add("raceRetry:$raceAttempt")
                    ok = tryDecrypt()
                }
                if (!ok && locality() == Locality.LOCAL) {
                    steps.add("locality=LOCAL(afterRace)")
                    ok = tryCatchup()
                    if (ok) steps.add("tryCatchup")
                }
                Result(success = ok, catchupFirst = false, steps = steps)
            }
        }
    }

    data class Result(
        val success: Boolean,
        val catchupFirst: Boolean,
        val steps: List<String>,
    )

    @Test
    fun `local group with lagging epoch runs catch-up before any welcome-race retry`() {
        val start = System.currentTimeMillis()
        val r = runLadder(
            initialDecryptFails = true,
            locality = { Locality.LOCAL },
            tryDecrypt = { false },
            tryCatchup = { true },
        )
        val elapsed = System.currentTimeMillis() - start

        assertTrue("catch-up should run first for a local group", r.catchupFirst)
        assertTrue("should succeed after catch-up", r.success)
        assertEquals(listOf("tryDecrypt", "locality=LOCAL", "tryCatchup"), r.steps)
        assertTrue("must finish before 3s", elapsed < 3_000L)
    }

    @Test
    fun `absent group retries welcome race and falls back to catch-up if group appears`() {
        // The locality is read once before the race (ABSENT) and once after (LOCAL), so the late
        // catch-up runs.
        val checks = mutableListOf(Locality.ABSENT, Locality.LOCAL)
        val r = runLadder(
            initialDecryptFails = true,
            locality = { checks.removeAt(0) },
            tryDecrypt = { false },
            tryCatchup = { true },
        )

        assertTrue("should succeed after late catch-up", r.success)
        assertTrue(
            "should have retried before catch-up",
            r.steps.contains("raceRetry:1") && r.steps.contains("raceRetry:2") && r.steps.contains("raceRetry:3")
        )
        assertTrue("late catch-up should be last", r.steps.last() == "tryCatchup")
    }

    @Test
    fun `absent group that stays absent never runs catch-up`() {
        val r = runLadder(
            initialDecryptFails = true,
            locality = { Locality.ABSENT },
            tryDecrypt = { false },
            tryCatchup = { error("catch-up must not be called for an absent group") },
        )

        assertTrue("should fail without catch-up", !r.success)
        assertTrue("catchupFirst must be false", !r.catchupFirst)
        assertEquals(
            listOf("tryDecrypt", "locality=ABSENT", "raceRetry:1", "raceRetry:2", "raceRetry:3"),
            r.steps
        )
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
        val r = runLadder(
            initialDecryptFails = true,
            locality = { Locality.UNKNOWN },
            tryDecrypt = { false },
            tryCatchup = { error("catch-up must not be called when the locality is unknown") },
        )

        assertTrue("should fail, leaving the push to the worker", !r.success)
        assertEquals(listOf("tryDecrypt", "locality=UNKNOWN"), r.steps)
        assertTrue(
            "no welcome-race retry may run on an unknown locality",
            r.steps.none { it.startsWith("raceRetry") }
        )
    }

    @Test
    fun `successful direct decrypt skips ladder entirely`() {
        val r = runLadder(
            initialDecryptFails = false,
            locality = { error("should not be called") },
            tryDecrypt = { error("should not be called") },
            tryCatchup = { error("should not be called") },
        )

        assertTrue("should succeed directly", r.success)
        assertEquals(listOf("tryDecrypt"), r.steps)
    }
}
