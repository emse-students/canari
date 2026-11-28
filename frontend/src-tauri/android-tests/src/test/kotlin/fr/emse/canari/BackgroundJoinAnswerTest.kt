package fr.emse.canari

import fr.emse.canari.push.BackgroundJoinAnswer
import fr.emse.canari.push.BackgroundJoinAnswer.Outcome
import fr.emse.canari.push.OutboxRetry.Prospect
import org.junit.Assert.assertEquals
import org.junit.Test

/** The background join answers a typed cause, never a bare false. */
class BackgroundJoinAnswerTest {

    @Test
    fun aJoinedTokenIsJoined() {
        assertEquals(Outcome.Joined, BackgroundJoinAnswer.parse("joined"))
    }

    @Test
    fun aRefusedWriteIsNotYetWithItsCause() {
        assertEquals(
            Outcome.Failed("write-refused", Prospect.NOT_YET),
            BackgroundJoinAnswer.parse("failed:write-refused:not-yet"),
        )
    }

    @Test
    fun aWelcomeThatNeverInstallsIsNever() {
        assertEquals(
            Outcome.Failed("welcome-refused", Prospect.NEVER),
            BackgroundJoinAnswer.parse("failed:welcome-refused:never"),
        )
    }

    @Test
    fun anUnreadableAnswerIsSaidAsUnclassified() {
        assertEquals(Outcome.Failed("unclassified", Prospect.NOT_YET), BackgroundJoinAnswer.parse(null))
        assertEquals(Outcome.Failed("unclassified", Prospect.NOT_YET), BackgroundJoinAnswer.parse("false"))
    }
}
