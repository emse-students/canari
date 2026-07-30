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

    /** Minimal version of the service ladder to make the order explicit and testable. */
    private fun runLadder(
        initialDecryptFails: Boolean,
        isGroupLocal: () -> Boolean,
        tryDecrypt: () -> Boolean,
        tryCatchup: () -> Boolean,
    ): Result {
        val steps = mutableListOf<String>()
        steps.add("tryDecrypt")
        if (!initialDecryptFails) return Result(success = true, catchupFirst = false, steps = steps)

        if (tryDecrypt()) {
            return Result(success = true, catchupFirst = false, steps = steps)
        }

        return if (isGroupLocal()) {
            steps.add("isGroupLocal=true")
            val ok = tryCatchup()
            if (ok) steps.add("tryCatchup")
            Result(success = ok, catchupFirst = true, steps = steps)
        } else {
            steps.add("isGroupLocal=false")
            var raceAttempt = 0
            var ok = false
            while (raceAttempt < 3 && !ok) {
                raceAttempt++
                steps.add("raceRetry:$raceAttempt")
                ok = tryDecrypt()
            }
            if (!ok && isGroupLocal()) {
                steps.add("isGroupLocal=true(afterRace)")
                ok = tryCatchup()
                if (ok) steps.add("tryCatchup")
            }
            Result(success = ok, catchupFirst = false, steps = steps)
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
            isGroupLocal = { true },
            tryDecrypt = { false },
            tryCatchup = { true },
        )
        val elapsed = System.currentTimeMillis() - start

        assertTrue("catch-up should run first for a local group", r.catchupFirst)
        assertTrue("should succeed after catch-up", r.success)
        assertEquals(listOf("tryDecrypt", "isGroupLocal=true", "tryCatchup"), r.steps)
        assertTrue("must finish before 3s", elapsed < 3_000L)
    }

    @Test
    fun `non-local group retries welcome race and falls back to catch-up if group appears`() {
        // isGroupLocal is checked once before the race (returns false) and once after the race
        // (returns true), so the late catch-up runs.
        val checks = mutableListOf<Boolean>(false, true)
        val r = runLadder(
            initialDecryptFails = true,
            isGroupLocal = { checks.removeAt(0) },
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
    fun `non-local group that stays non-local never runs catch-up`() {
        val r = runLadder(
            initialDecryptFails = true,
            isGroupLocal = { false },
            tryDecrypt = { false },
            tryCatchup = { error("catch-up must not be called for a non-local group") },
        )

        assertTrue("should fail without catch-up", !r.success)
        assertTrue("catchupFirst must be false", !r.catchupFirst)
        assertEquals(listOf("tryDecrypt", "isGroupLocal=false", "raceRetry:1", "raceRetry:2", "raceRetry:3"), r.steps)
    }

    @Test
    fun `successful direct decrypt skips ladder entirely`() {
        val r = runLadder(
            initialDecryptFails = false,
            isGroupLocal = { error("should not be called") },
            tryDecrypt = { error("should not be called") },
            tryCatchup = { error("should not be called") },
        )

        assertTrue("should succeed directly", r.success)
        assertEquals(listOf("tryDecrypt"), r.steps)
    }
}
