package fr.emse.canari.push

/**
 * THE BACKGROUND DECRYPT RECOVERY LADDER, AS A PURE FUNCTION - AND THAT IS THE WHOLE POINT.
 *
 * This package is compiled TWICE, from this one copy: by the Android app module, and by the
 * standalone JVM project in `frontend/src-tauri/android-tests`, which adds this directory as a
 * `main` source directory. `PushDecryptLadderTest` therefore exercises the code the service runs
 * rather than a second description of it - it used to hold a private `runLadder` that restated the
 * branching, so it could not fail when `CanariFirebaseMessagingService` changed, which is the one
 * thing a regression test is for.
 *
 * **NOTHING IN THIS PACKAGE MAY IMPORT ANYTHING ANDROID.** That is not a style rule: the JVM
 * project has no Android classpath, so an `android.util.Log` here fails `:compileKotlin` there and
 * the suite stops running. Everything the ladder needs from the platform - the clock, the logger,
 * the JNI decrypt, the MLS state lock - arrives as a lambda.
 */

/**
 * Whether a group is joined in the local MLS state - or whether that could not be established.
 *
 * [UNKNOWN] IS NOT [ABSENT], AND COLLAPSING THEM SENT EVERY RECOVERY DOWN THE WRONG BRANCH.
 * The producing query returned a plain Boolean, and every way of failing to reach the state - lock
 * not acquired, `mls.bin` unreadable, device key missing, JNI not loaded - came back as `false`,
 * which the caller reads as "the group is not joined here". So a device that had been in a
 * conversation for months answered "not mine" whenever another thread happened to hold the lock,
 * and the message was handed to the Welcome-race retry loop: three more attempts, each re-entering
 * the same contended lock, for a group that was never racing a Welcome at all. Measured on device
 * 2026-08-11: twenty `local=false` verdicts from ten epoch queries - half the answers were given by
 * a timeout, about the main DM.
 */
enum class GroupLocality { LOCAL, ABSENT, UNKNOWN }

/** The recovery ladder a refused background decrypt goes down, and the constants that shape it. */
object PushRecoveryLadder {

    /** How many times the Welcome/message race is re-tried before the group is given up on. */
    const val WELCOME_RACE_RETRIES = 3

    /** Delay between two retries (the JNI process_welcome takes ~5s; give it time). */
    const val WELCOME_RACE_RETRY_DELAY_MS = 1_800L

    /**
     * Runs the ladder over an outcome of any type, and returns the best outcome it reached.
     *
     * The ladder is generic because it decides WHAT TO DO, never what a message is: [isRefused] is
     * the only thing it knows about `T`. Every effect is injected, so the caller keeps the JNI, the
     * state lock and the clock, and this file stays compilable with no Android at all.
     *
     * @param initial the outcome of the first decrypt attempt; returned untouched unless refused
     * @param groupTag the short group id the log lines carry - the caller truncates, not this
     * @param isRefused the ONLY diagnosis this ladder answers; see `PushDecrypt.Refused`
     * @param locality where the group is, re-read after the race because it may have appeared
     * @param retryDecrypt one more attempt at the same frame
     * @param catchUp the commit catch-up, `null` when it could not produce an outcome
     * @param pause waits between two race retries, and returns `false` if it was interrupted
     * @param log every branch says which one it took; a silent ladder is unreadable in a bug report
     */
    fun <T> run(
        initial: T,
        groupTag: String,
        isRefused: (T) -> Boolean,
        locality: () -> GroupLocality,
        retryDecrypt: () -> T,
        catchUp: () -> T?,
        pause: () -> Boolean,
        log: (String) -> Unit,
    ): T {
        var outcome = initial
        if (!isRefused(outcome)) return outcome

        val where = locality()
        log("tryDecrypt refused group=$groupTag locality=$where")

        when (where) {
            // NOTHING WAS ESTABLISHED, SO NOTHING IS RETRIED HERE. Both recoveries below are
            // answers to a diagnosis, and there is none: the commit catch-up costs a fetch and a
            // state load to close an epoch gap nobody saw, and the Welcome race waits on a join
            // that is probably not happening. The push falls through to the WorkManager fallback,
            // which is where work with no deadline belongs.
            GroupLocality.UNKNOWN ->
                log("locality unknown group=$groupTag -> leaving it to the worker")

            // The group exists locally: the only plausible reason for a direct failure is an epoch
            // gap (a commit arrived while the app was closed). Catch-up FIRST, before any expensive
            // Welcome-race loop that cannot help a group that is already joined.
            GroupLocality.LOCAL ->
                catchUp()?.let { outcome = it }

            // The epoch query ran and the group is genuinely not joined here. Welcome/message race:
            // the concurrent Welcome push may be joining the group when this message arrives. We
            // retry briefly so the 1st message of a new conversation produces a real notification
            // instead of a generic fallback, rather than showing then correcting the notification.
            GroupLocality.ABSENT -> {
                var raceAttempt = 0
                while (isRefused(outcome) && raceAttempt < WELCOME_RACE_RETRIES) {
                    raceAttempt++
                    if (!pause()) break
                    log("tryDecrypt retry $raceAttempt/$WELCOME_RACE_RETRIES (group-join race) group=$groupTag")
                    outcome = retryDecrypt()
                }
                // The group may have appeared during the race (a Welcome queued ahead of this one
                // on the MLS lane). Last-resort catch-up before falling back to the worker.
                if (isRefused(outcome) && locality() == GroupLocality.LOCAL) {
                    log("group appeared during welcome-race, attempting catch-up group=$groupTag")
                    catchUp()?.let { outcome = it }
                }
            }
        }

        return outcome
    }
}
