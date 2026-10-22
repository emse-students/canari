package fr.emse.canari

import fr.emse.canari.push.KeyGroupPushJoin
import fr.emse.canari.push.KeyGroupPushJoin.AfterBase
import fr.emse.canari.push.KeyGroupPushJoin.AfterCommit
import fr.emse.canari.push.KeyGroupPushJoin.BaseBody
import fr.emse.canari.push.KeyGroupPushJoin.Settlement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A shut phone joining a salon's key group from a push (channel-encryption section 25), as the
 * table of what each server and native answer means. What these pin is the rule the whole seam
 * rests on: only the server ANSWERING (a 403, a 400, an inconsistent push) is a refusal; an answer
 * that never came, a 503 or a status nobody expects claims nothing, and a later push may try again.
 */
class KeyGroupPushJoinTest {

    private fun body(
        welcomeOwed: Boolean = false,
        scopeKind: String? = "workspace",
        scopeId: String? = "ws1",
        groupInfo: String? = "Z2k=",
        baseEpoch: Long? = 4,
        activeEpoch: Long? = 4,
    ) = BaseBody(welcomeOwed, scopeKind, scopeId, groupInfo, baseEpoch, activeEpoch)

    @Test
    fun `a published current base lets the join go on, with the server's scope`() {
        val after = KeyGroupPushJoin.afterBase(201, body())
        assertEquals(AfterBase.Proceed(KeyGroupPushJoin.Base("workspace", "ws1", "Z2k=", 4)), after)
    }

    @Test
    fun `a 403 is the server answering, so it is a refusal`() {
        val after = KeyGroupPushJoin.afterBase(403, null) as AfterBase.Stop
        assertTrue(after.settlement is Settlement.Refused)
    }

    @Test
    fun `no answer, a 503 or an odd status claims nothing about membership`() {
        for (status in listOf(null, 503, 500, 429)) {
            val after = KeyGroupPushJoin.afterBase(status, null) as AfterBase.Stop
            assertTrue("status=$status", after.settlement is Settlement.Retryable)
        }
    }

    @Test
    fun `a Welcome on its way stops the push from writing a second leaf`() {
        val after = KeyGroupPushJoin.afterBase(200, body(welcomeOwed = true, groupInfo = null)) as AfterBase.Stop
        assertEquals(Settlement.Retryable("welcome-owed"), after.settlement)
    }

    @Test
    fun `no base and a stale base are known in advance and never submitted`() {
        val none = KeyGroupPushJoin.afterBase(200, body(groupInfo = null)) as AfterBase.Stop
        assertEquals(Settlement.Retryable("no-base-published"), none.settlement)
        val stale = KeyGroupPushJoin.afterBase(200, body(baseEpoch = 3, activeEpoch = 5)) as AfterBase.Stop
        assertEquals(Settlement.Retryable("stale-base"), stale.settlement)
    }

    @Test
    fun `an answer with no scope cannot be handed to the registry`() {
        val after = KeyGroupPushJoin.afterBase(200, body(scopeId = null)) as AfterBase.Stop
        assertTrue(after.settlement is Settlement.Retryable)
    }

    @Test
    fun `a terminal native refusal is final, any other is retryable`() {
        assertEquals(Settlement.Refused("prepare-sender-not-in-tree"), KeyGroupPushJoin.afterPrepareRefusal("sender-not-in-tree", true))
        assertEquals(Settlement.Retryable("prepare-epoch-mismatch"), KeyGroupPushJoin.afterPrepareRefusal("epoch-mismatch", false))
    }

    @Test
    fun `only an accepted commit installs the staged state`() {
        val (step, settlement) = KeyGroupPushJoin.afterCommit(201, true, null)
        assertEquals(AfterCommit.INSTALL, step)
        assertNull(settlement)
        assertEquals(AfterCommit.ABANDON to Settlement.Retryable("commit-refused-epoch_mismatch"), KeyGroupPushJoin.afterCommit(200, false, "epoch_mismatch"))
        assertEquals(AfterCommit.ABANDON to Settlement.Refused("commit-forbidden"), KeyGroupPushJoin.afterCommit(403, null, null))
        assertEquals(AfterCommit.ABANDON to Settlement.Refused("commit-malformed"), KeyGroupPushJoin.afterCommit(400, null, null))
        assertEquals(AfterCommit.ABANDON to Settlement.Retryable("commit-unreachable"), KeyGroupPushJoin.afterCommit(null, null, null))
        assertEquals(AfterCommit.ABANDON to Settlement.Retryable("commit-status-503"), KeyGroupPushJoin.afterCommit(503, null, null))
    }

    @Test
    fun `an accepted commit the install refused is lost, not joined`() {
        val base = KeyGroupPushJoin.Base("channel", "salon1", "Z2k=", 2)
        assertEquals(Settlement.Joined("channel", "salon1"), KeyGroupPushJoin.afterInstall(true, base))
        assertEquals(Settlement.Lost("install-refused"), KeyGroupPushJoin.afterInstall(false, base))
    }
}
