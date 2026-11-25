package fr.emse.canari.push

/**
 * A visible push whose decrypt was stopped by something that says nothing about the frame - a server
 * it could not reach, an MLS state lock held elsewhere - held until it can be replayed.
 *
 * @param groupId the conversation it belongs to - one replay job per conversation
 * @param frameKey the frame's identity: its `queuedMessageId`. A redelivered push is the same frame
 * @param placeholderStamps the MessagingStyle instants of the generic lines posted for it - the
 *   identity `showMessageNotification` handed back for each, which the replay's real line
 *   SUPERSEDES ([SupersededLines]). More than one only when the same frame was pushed twice.
 * @param fields the push's data map, replayed as it arrived: nothing is re-derived
 */
data class HeldFrame(
    val groupId: String,
    val frameKey: String,
    val placeholderStamps: Set<Long>,
    val fields: Map<String, String>,
)

/**
 * WHAT IS OWED TO A PUSH THE NETWORK REFUSED, AS PURE ARITHMETIC (2026-11-25).
 *
 * A push whose decrypt ended [ServerFetch.Unreachable] (the proto or the commits could not be
 * fetched), or found the MLS state lock held, posts the generic line - the user is owed the fact of a
 * message - and its frame is HELD in durable state, with the instant of that line. One WorkManager
 * job per conversation, constrained to `NetworkType.CONNECTED`, replays the held frames through the
 * same decrypt and REPLACES each generic line with the real text. A network coming back is an EVENT,
 * and the job waits on it rather than on a clock.
 *
 * Termination and idempotence come from durable state, never from a count or a timer:
 * - a generic line no longer in the shade (read, swiped, read on another device) has nothing to
 *   upgrade, so the frame is dropped at debug without any MLS work and nothing is re-posted;
 * - a frame the app's drain already read is refused for good by the advanced MLS state, so the
 *   replay drops it at debug and posts nothing. That holds whether or not the app could drain:
 *   opening the app offline leaves the frame held, and the move to the background hands it back.
 *
 * Nothing Android may be imported here (see [PushRecoveryLadder]); the store and the job live in
 * `HeldFrameWorker.kt`.
 */
object HeldFrames {

    /** The tag every replay job carries, so the app's move to the front cancels them all at once. */
    const val WORK_TAG = "canari_held_frame"

    /**
     * The ONE unique work name of a conversation's replay.
     *
     * Enqueued with `ExistingWorkPolicy.REPLACE`, and not `KEEP`: a frame is written to the store
     * BEFORE the enqueue, and a `KEEP` arriving while a run is past its last read of the store would
     * be dropped (the run is still RUNNING) and that run's success would leave the new frame unheld by
     * any job. `REPLACE` always leaves exactly one job that has not yet read the store. The two runs
     * never replay side by side, with no lock: every step of a run - picking the next held frame,
     * replaying it, settling it - is ONE task on the MLS push lane, a single thread, so a cancelled
     * run's last step finishes before its successor's first one reads the store.
     */
    fun uniqueWorkName(groupId: String): String = "${WORK_TAG}_$groupId"

    /**
     * Whether a push may hold its frame now. Not while the app is in front: its engine owns the MLS
     * state and its drain reads the frame. Asked under the store's lock, with the takeover taken
     * under the same lock, so a hold and a move to the front cannot interleave.
     */
    fun admits(foreground: Boolean): Boolean = !foreground

    /**
     * Holds [frame] in [held], idempotently: the same frame pushed twice is one entry whose generic
     * lines are both remembered, so the replay replaces both.
     */
    fun hold(held: List<HeldFrame>, frame: HeldFrame): List<HeldFrame> {
        val existing = held.firstOrNull { it.groupId == frame.groupId && it.frameKey == frame.frameKey }
            ?: return held + frame
        val merged = existing.copy(
            placeholderStamps = existing.placeholderStamps + frame.placeholderStamps,
            fields = frame.fields,
        )
        return held.map { if (it === existing) merged else it }
    }

    /** The store without [frame]. */
    fun settle(held: List<HeldFrame>, frame: HeldFrame): List<HeldFrame> =
        held.filterNot { it.groupId == frame.groupId && it.frameKey == frame.frameKey }

    /** The next frame of [groupId] a run has not replayed yet ([done] holds the keys it did). */
    fun next(held: List<HeldFrame>, groupId: String, done: Set<String>): HeldFrame? =
        held.firstOrNull { it.groupId == groupId && it.frameKey !in done }

    /** The conversations with a frame still held - each owed a replay job when the app leaves the front. */
    fun groupsHeld(held: List<HeldFrame>): Set<String> = held.mapTo(LinkedHashSet()) { it.groupId }

    /** What one replay of one held frame came to. */
    enum class Replay {
        /** The real line replaced the generic one(s). */
        UPGRADED,
        /** No generic line of this frame is in the shade any more: nothing to upgrade, nothing posted. */
        GONE,
        /** The app is in front: the frame stays held, and the app's move to the background hands it back. */
        FOREGROUND,
        /** The server still could not be reached: the frame stays held, the job retries. */
        STILL_UNREACHABLE,
        /** The MLS state lock was held - a fact about the lock, not the frame: kept, the job retries. */
        STATE_BUSY,
        /**
         * The frame decrypted to nothing a line can show (a commit, key material): its generic line
         * is replaced by NOTHING - removed - and the frame is done.
         */
        EMPTY,
        /** Refused for good: the app's drain (or another engine) already read it. Done, nothing posted. */
        CONSUMED,
        /** Refused: a frame that should have opened and did not. Dropped, and said. */
        NOT_READABLE,
    }

    /**
     * Asked BEFORE any MLS work: whether the replay can stop here. Null means "decrypt it".
     *
     * @param foreground `MainActivity.isInForeground` now
     * @param shownStamps the instants of the lines the conversation's notification holds now
     */
    fun before(frame: HeldFrame, foreground: Boolean, shownStamps: Set<Long>): Replay? = when {
        foreground -> Replay.FOREGROUND
        stillShown(frame, shownStamps).isEmpty() -> Replay.GONE
        else -> null
    }

    /** The generic lines of [frame] the shade still holds - the ones the real line must replace. */
    fun stillShown(frame: HeldFrame, shownStamps: Set<Long>): Set<Long> =
        frame.placeholderStamps.filterTo(LinkedHashSet()) { it in shownStamps }

    /** Whether the frame stays in the store after [replay]: only for what says nothing about the frame. */
    fun keeps(replay: Replay): Boolean =
        replay == Replay.STILL_UNREACHABLE || replay == Replay.STATE_BUSY || replay == Replay.FOREGROUND

    /** How a job's run ends. */
    enum class RunEnd { DONE, RETRY }

    /**
     * A run retries only while the network or the lock still stands in the way. A frame kept for the
     * app in front is not retried: the move to the background enqueues a fresh job for it.
     */
    fun runEnd(replays: Collection<Replay>): RunEnd =
        if (replays.any { it == Replay.STILL_UNREACHABLE || it == Replay.STATE_BUSY }) RunEnd.RETRY else RunEnd.DONE

    /** The level a replay is logged at. */
    enum class Level { DEBUG, INFO, WARN }

    /**
     * Nothing owed is DEBUG - the line is gone, the app has it, a frame with nothing to show - because
     * each is the mechanism working. Only a frame that should have opened and did not accuses.
     */
    fun level(replay: Replay): Level = when (replay) {
        Replay.GONE, Replay.FOREGROUND, Replay.EMPTY, Replay.CONSUMED -> Level.DEBUG
        Replay.UPGRADED, Replay.STILL_UNREACHABLE, Replay.STATE_BUSY -> Level.INFO
        Replay.NOT_READABLE -> Level.WARN
    }
}
