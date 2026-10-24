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
 * A shut phone joining a salon's key group from a push (channel-encryption section 26), as the
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
            // (a 2xx with no body is the separate "unparsable" case below)
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
    fun `a terminal native refusal is final, an expensive one is deferred on its base, any other retryable`() {
        assertEquals(Settlement.Refused("prepare-sender-not-in-tree"), KeyGroupPushJoin.afterPrepareRefusal("sender-not-in-tree", true, false, 4))
        assertEquals(Settlement.Deferred("prepare-epoch-mismatch", 4), KeyGroupPushJoin.afterPrepareRefusal("epoch-mismatch", false, true, 4))
        assertEquals(Settlement.Retryable("prepare-warm-process"), KeyGroupPushJoin.afterPrepareRefusal("warm-process", false, false, 4))
    }

    @Test
    fun `a base a previous prepare failed on is not prepared again, another one is`() {
        val base = KeyGroupPushJoin.Base("workspace", "ws1", "Z2k=", 4)
        assertEquals(Settlement.Deferred("base-unchanged", 4), KeyGroupPushJoin.beforePrepare(base, 4, "salon"))
        assertNull(KeyGroupPushJoin.beforePrepare(base, 3, "salon"))
        assertNull(KeyGroupPushJoin.beforePrepare(base, null, "salon"))
    }

    @Test
    fun `a salon key group must be the salon the push is for`() {
        val base = KeyGroupPushJoin.Base("channel", "SALON-1", "Z2k=", 4)
        assertNull(KeyGroupPushJoin.beforePrepare(base, null, "salon-1"))
        assertEquals(Settlement.Refused("scope-mismatch"), KeyGroupPushJoin.beforePrepare(base, null, "salon-2"))
    }

    @Test
    fun `the claim answer is read, and anything else is not granted`() {
        assertEquals(KeyGroupPushJoin.ClaimAnswer.Granted(null), KeyGroupPushJoin.readClaim("granted"))
        assertEquals(KeyGroupPushJoin.ClaimAnswer.Granted(7), KeyGroupPushJoin.readClaim("granted-unless-base:7"))
        assertEquals(KeyGroupPushJoin.ClaimAnswer.NotGranted("attempted:refused"), KeyGroupPushJoin.readClaim("attempted:refused"))
        assertEquals(KeyGroupPushJoin.ClaimAnswer.NotGranted("claim-unparsable"), KeyGroupPushJoin.readClaim("granted-unless-base:x"))
    }

    @Test
    fun `a 2xx that could not be read is named, never taken for no answer`() {
        val after = KeyGroupPushJoin.afterBase(201, null) as AfterBase.Stop
        assertEquals(Settlement.Retryable("base-unparsable"), after.settlement)
        assertEquals(AfterCommit.ABANDON to Settlement.Retryable("commit-answer-unparsable"), KeyGroupPushJoin.afterCommit(201, null, null, 4))
    }

    @Test
    fun `only an accepted commit installs the staged state`() {
        val (step, settlement) = KeyGroupPushJoin.afterCommit(201, true, null, 4)
        assertEquals(AfterCommit.INSTALL, step)
        assertNull(settlement)
        assertEquals(AfterCommit.ABANDON to Settlement.Retryable("commit-refused-epoch_mismatch"), KeyGroupPushJoin.afterCommit(200, false, "epoch_mismatch", 4))
        assertEquals(AfterCommit.ABANDON to Settlement.Refused("commit-forbidden"), KeyGroupPushJoin.afterCommit(403, null, null, 4))
        assertEquals(AfterCommit.ABANDON to Settlement.Refused("commit-malformed"), KeyGroupPushJoin.afterCommit(400, null, null, 4))
        assertEquals(AfterCommit.ABANDON to Settlement.Retryable("commit-unreachable"), KeyGroupPushJoin.afterCommit(null, null, null, 4))
        assertEquals(AfterCommit.ABANDON to Settlement.Retryable("commit-status-503"), KeyGroupPushJoin.afterCommit(503, null, null, 4))
    }

    @Test
    fun `a rate-limited commit is deferred on its base, never lost`() {
        // The throttler answers before the commit is validated: nothing was accepted, and the same
        // base must not cost the next push another prepare.
        assertEquals(
            AfterCommit.ABANDON to Settlement.Deferred("commit-rate-limited", 4),
            KeyGroupPushJoin.afterCommit(429, null, null, 4),
        )
        val base = KeyGroupPushJoin.Base("workspace", "ws1", "Z2k=", 4)
        assertEquals(
            Settlement.Deferred("base-unchanged", 4),
            KeyGroupPushJoin.beforePrepare(base, 4, "salon"),
        )
        // The base read refused by the throttler: no work was done, the next push's read retries.
        val after = KeyGroupPushJoin.afterBase(429, null) as AfterBase.Stop
        assertEquals(Settlement.Retryable("base-rate-limited"), after.settlement)
    }

    @Test
    fun `an accepted commit the install refused is lost, not joined`() {
        val base = KeyGroupPushJoin.Base("channel", "salon1", "Z2k=", 2)
        assertEquals(Settlement.Joined("channel", "salon1"), KeyGroupPushJoin.afterInstall(true, base))
        assertEquals(Settlement.Lost("install-refused"), KeyGroupPushJoin.afterInstall(false, base))
        // The state lock was never taken: not an answer, so nothing is settled.
        assertNull(KeyGroupPushJoin.afterInstall(null, base))
    }
}
