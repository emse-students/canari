package fr.emse.canari

import fr.emse.canari.push.BackgroundJoinAnswer
import fr.emse.canari.push.BackgroundJoinAnswer.Outcome
import fr.emse.canari.push.OutboxRetry.Prospect
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The background join answers a typed cause, never a bare false. The cases are the shared contract
 * (`libs/contracts/background-join-answer.cases.json`), which the Rust side's test also reads.
 */
class BackgroundJoinAnswerTest {

    private val contract = JSONObject(
        File(System.getProperty("user.dir"), "../../../libs/contracts/background-join-answer.cases.json").readText(),
    )

    @Test
    fun theClosedCauseSetIsTheContracts() {
        val causes = contract.getJSONArray("causes").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
        assertEquals(causes, BackgroundJoinAnswer.CAUSES)
    }

    @Test
    fun everyContractCaseParsesAsItsOutcome() {
        val cases = contract.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val token = c.getString("token")
            val expected = when (c.getString("outcome")) {
                "joined" -> Outcome.Joined
                "failed" -> Outcome.Failed(
                    c.getString("cause"),
                    if (c.getString("prospect") == "never") Prospect.NEVER else Prospect.NOT_YET,
                )
                else -> Outcome.Unreadable(token)
            }
            assertEquals("token '$token'", expected, BackgroundJoinAnswer.parse(token))
        }
    }

    @Test
    fun theStateUnreadableNeverTokenIsAnError() {
        assertEquals(
            Outcome.Failed("state-unreadable", Prospect.NEVER),
            BackgroundJoinAnswer.parse("failed:state-unreadable:never"),
        )
    }

    @Test
    fun aNullAnswerIsUnreadable() {
        assertEquals(Outcome.Unreadable(null), BackgroundJoinAnswer.parse(null))
    }
}
