package fr.emse.canari.push

/**
 * HOW A SALON PUSH OPENS THE SEED FRAME IT CARRIES, AS A PURE FUNCTION (channel-encryption §19).
 *
 * A message sealed under a Graine session carries, since §19, the MLS frame that distributed that
 * session's seed on the salon's key group. A phone whose mirror has no seed for the session opens
 * the frame instead of holding the message for a second push - which is the race §19 removes.
 *
 * **IT IS NOT [PushRecoveryLadder], AND THE DIFFERENCE IS THE ABSENT BRANCH.** That ladder waits
 * out a Welcome/message race because the frame it is given IS the conversation: a message of a
 * group being joined right now. A seed frame rides on a message of the SALON, so a key group this
 * device does not hold is not a join in flight to wait for - it is a device missing from its own
 * community's key group, the defect `reportSingleHolderGroups` watches. Sleeping 5.4 s on the
 * channel lane would buy nothing but a later generic banner, so it is said, and not waited on.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object SeedFrameLadder {

    /**
     * Opens one attached frame, and returns the best outcome it reached.
     *
     * @param initial the first decrypt of the frame; returned untouched unless refused
     * @param groupTag the short key-group id the log lines carry
     * @param isRefused the only diagnosis this answers - see `PushDecrypt.Refused`
     * @param locality where the key group is; asked only after a refusal
     * @param catchUp the commit catch-up, `null` when it could not produce an outcome
     * @param log every branch says which one it took
     */
    fun <T> open(
        initial: T,
        groupTag: String,
        isRefused: (T) -> Boolean,
        locality: () -> GroupLocality,
        catchUp: () -> T?,
        log: (String) -> Unit,
    ): T {
        if (!isRefused(initial)) return initial

        return when (val where = locality()) {
            // The key group is here and the frame is ahead of it: a commit this device has not
            // applied - a member joined while it was shut, which is what rotated the session.
            GroupLocality.LOCAL -> {
                log("seed frame refused group=$groupTag locality=LOCAL -> commit catch-up")
                catchUp() ?: initial
            }
            GroupLocality.ABSENT -> {
                log("seed frame refused group=$groupTag locality=ABSENT -> this device is not in the salon's key group; no join to wait for")
                initial
            }
            GroupLocality.UNKNOWN -> {
                log("seed frame refused group=$groupTag locality=$where -> nothing established, the message is held for its seed push")
                initial
            }
        }
    }
}
