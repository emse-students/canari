package fr.emse.canari.push

/**
 * WHAT EACH ANSWER OF A KEY-GROUP JOIN FROM A PUSH MEANS, AS PURE FUNCTIONS (channel-encryption
 * section 25, decided by the user 2026-10-22: "Oui, rejoindre au push").
 *
 * A salon push whose seed frame names a key group this phone holds no seat in used to be said and
 * dropped ([SeedFrameLadder]'s ABSENT branch): the phone waited for the app to be opened, and every
 * salon push until then was a blind banner. Now the push service makes the external commit the app
 * makes on load, through the same server gate, in three steps - the base (`mls/push/key-group-base`),
 * the native prepare (`nativePrepareKeyGroupJoin`), the commit (`mls/push/key-group-join`) - and each
 * step's answer ends the attempt or lets it go on. This file is the table of those answers, so the
 * three-language seam is decided in one place and tested on a JVM.
 *
 * **EVERY END IS A [Settlement], and the ledger reads it** (`mobile/key_group_join.rs`): a
 * [Settlement.Refused] or [Settlement.Lost] group is not attempted again from a push until the app
 * has started (its own join owns it from then on); a [Settlement.Retryable] one may be tried by the
 * next push. An answer that is not an answer - a transport failure, a 503, a status nobody expects -
 * is never a refusal: it claims nothing about membership.
 *
 * Compiled by the JVM test project too, so nothing here may import Android.
 */
object KeyGroupPushJoin {

    /** How an attempt ended. [token] is what the ledger and every log line carry. */
    sealed class Settlement(val token: String) {
        /** Accepted and installed; the scope the server named goes to the app's key-group registry. */
        data class Joined(val scopeKind: String, val scopeId: String) : Settlement("joined")
        /** No later push can change the answer (not entitled, an inconsistent push). */
        data class Refused(val reason: String) : Settlement("refused")
        /** Accepted by the server and not installed: a leaf with no secrets, the app's to repair. */
        data class Lost(val reason: String) : Settlement("lost")
        /** Nothing was decided; a later push may try again. */
        data class Retryable(val reason: String) : Settlement("retryable")
    }

    /** The base, as the server served it to a device that may build on it. */
    data class Base(
        val scopeKind: String,
        val scopeId: String,
        val groupInfo: String,
        val baseEpoch: Long,
    )

    /** What the base step decided: go on with [Base], or stop with a [Settlement]. */
    sealed class AfterBase {
        data class Proceed(val base: Base) : AfterBase()
        data class Stop(val settlement: Settlement) : AfterBase()
    }

    /**
     * Reads the answer of `POST mls/push/key-group-base`.
     *
     * @param status the HTTP status, or null when no answer came back (a transport failure)
     * @param body the parsed fields of a 200, null otherwise
     */
    fun afterBase(status: Int?, body: BaseBody?): AfterBase {
        if (status == null) return AfterBase.Stop(Settlement.Retryable("base-unreachable"))
        // 403 is the server ANSWERING: not a key group, or not entitled. Nothing a push changes.
        if (status == 403) return AfterBase.Stop(Settlement.Refused("base-forbidden"))
        // A NestJS POST answers 201; any 2xx is the answer.
        if (status !in 200..299 || body == null) return AfterBase.Stop(Settlement.Retryable("base-status-$status"))
        // ONE DOOR AT A TIME: somebody is writing this device's leaf; a second writer is the
        // duplicate-leaf race. The Welcome is processed by its own push.
        if (body.welcomeOwed) return AfterBase.Stop(Settlement.Retryable("welcome-owed"))
        if (body.scopeKind.isNullOrEmpty() || body.scopeId.isNullOrEmpty()) {
            return AfterBase.Stop(Settlement.Retryable("base-no-scope"))
        }
        val groupInfo = body.groupInfo
        if (groupInfo.isNullOrEmpty() || body.baseEpoch == null || body.activeEpoch == null) {
            return AfterBase.Stop(Settlement.Retryable("no-base-published"))
        }
        // NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU: the gate refuses a stale base with
        // certainty, and only a member holding the tree can republish it.
        if (body.baseEpoch < body.activeEpoch) return AfterBase.Stop(Settlement.Retryable("stale-base"))
        return AfterBase.Proceed(Base(body.scopeKind, body.scopeId, groupInfo, body.baseEpoch))
    }

    /** The fields of a 200 from `mls/push/key-group-base`, as read off its JSON. */
    data class BaseBody(
        val welcomeOwed: Boolean,
        val scopeKind: String?,
        val scopeId: String?,
        val groupInfo: String?,
        val baseEpoch: Long?,
        val activeEpoch: Long?,
    )

    /**
     * Reads a refused native prepare: a `terminal` refusal (an inconsistent push) is [Settlement.Refused],
     * any other [Settlement.Retryable]. The token is the native side's, never prose.
     */
    fun afterPrepareRefusal(reason: String, terminal: Boolean): Settlement =
        if (terminal) Settlement.Refused("prepare-$reason") else Settlement.Retryable("prepare-$reason")

    /** What the commit step decided. */
    enum class AfterCommit {
        /** Accepted: install the staged state. */
        INSTALL,
        /** Not accepted: delete the staged state, and settle with the settlement returned beside it. */
        ABANDON,
    }

    /**
     * Reads the answer of `POST mls/push/key-group-join`, and the settlement an ABANDON carries.
     *
     * A transport failure is ABANDON + retryable even though the server MAY have accepted the commit:
     * nothing is claimed about membership, and if it did, the leaf it holds is replaced by the next
     * join (an external commit evicts a leaf carrying the same signature key) - the app's at its
     * next start, or the next push's.
     */
    fun afterCommit(status: Int?, accepted: Boolean?, reason: String?): Pair<AfterCommit, Settlement?> =
        when {
            status != null && status in 200..299 && accepted == true -> AfterCommit.INSTALL to null
            status != null && status in 200..299 ->
                AfterCommit.ABANDON to Settlement.Retryable("commit-refused-${reason ?: "unspecified"}")
            status == 403 -> AfterCommit.ABANDON to Settlement.Refused("commit-forbidden")
            status == 400 -> AfterCommit.ABANDON to Settlement.Refused("commit-malformed")
            status == null -> AfterCommit.ABANDON to Settlement.Retryable("commit-unreachable")
            else -> AfterCommit.ABANDON to Settlement.Retryable("commit-status-$status")
        }

    /** The settlement of an accepted commit once the install was tried. */
    fun afterInstall(installed: Boolean, base: Base): Settlement =
        if (installed) Settlement.Joined(base.scopeKind, base.scopeId) else Settlement.Lost("install-refused")
}
