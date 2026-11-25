package fr.emse.canari.push

/**
 * A visible push whose commit catch-up could not reach the server, held until a network is back.
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
 * A push whose catch-up ended [CommitFetch.Unreachable] posts the generic line - the user is owed
 * the fact of a message - and its frame is HELD in durable state, with the instant of that line. One
 * WorkManager job per conversation, constrained to `NetworkType.CONNECTED`, replays the held frames
 * through the same catch-up and REPLACES each generic line with the real text. A network coming back
 * is an EVENT, and the job waits on it rather than on a clock.
 *
 * Termination and idempotence come from durable state, never from a count or a timer:
 * - the app coming to the front takes every held frame over (its drain reads them from the server
 *   queue) and the store is emptied, so a job that runs afterwards finds nothing and says so at debug;
 * - a generic line no longer in the shade (read, swiped, read on another device) has nothing to
 *   upgrade, so the frame is dropped at debug without any MLS work and nothing is re-posted.
 *
 * Nothing Android may be imported here (see [PushRecoveryLadder]); the store and the job live in
 * `HeldFrameWorker.kt`.
 */
object HeldFrames {

    /** The tag every replay job carries, so the app's takeover cancels them all at once. */
    const val WORK_TAG = "canari_held_frame"

    /**
     * The ONE unique work name of a conversation's replay.
     *
     * Enqueued with `ExistingWorkPolicy.REPLACE`, and not `KEEP`: a frame is written to the store
     * BEFORE the enqueue, and a `KEEP` arriving while a run is past its last read of the store would
     * be dropped (the run is still RUNNING) and that run's success would leave the new frame unheld by
     * any job. `REPLACE` always leaves exactly one job that has not yet read the store; the run it
     * cancels stops between two frames (`isStopped`), and the two runs never overlap because a replay
     * holds one process-wide lock for its whole pass. `APPEND_OR_REPLACE` would chain one job per push
     * of an outage, all but the first finding nothing.
     */
    fun uniqueWorkName(groupId: String): String = "${WORK_TAG}_$groupId"

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

    /** What one replay of one held frame came to. */
    enum class Replay {
        /** The real line replaced the generic one(s). */
        UPGRADED,
        /** No generic line of this frame is in the shade any more: nothing to upgrade, nothing posted. */
        GONE,
        /** The app is in front: its engine owns the state and its drain reads the frame. */
        FOREGROUND,
        /** The catch-up still could not reach the server: the frame stays held, the job retries. */
        STILL_UNREACHABLE,
        /** The frame decrypted to something no line can show, or was refused: dropped, said. */
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

    /** Whether the frame stays in the store after [replay]: only a network still refusing keeps it. */
    fun keeps(replay: Replay): Boolean = replay == Replay.STILL_UNREACHABLE

    /** How a job's run ends. */
    enum class RunEnd { DONE, RETRY }

    /** A run retries only while a frame is still held for the network; anything else is settled. */
    fun runEnd(replays: Collection<Replay>): RunEnd =
        if (replays.any(::keeps)) RunEnd.RETRY else RunEnd.DONE

    /** The level a replay is logged at. */
    enum class Level { DEBUG, INFO, WARN }

    /**
     * Nothing owed is DEBUG - the app took the frame, or the line is gone - because both are the
     * mechanism working. A frame that should have opened and did not is a WARN.
     */
    fun level(replay: Replay): Level = when (replay) {
        Replay.GONE, Replay.FOREGROUND -> Level.DEBUG
        Replay.UPGRADED, Replay.STILL_UNREACHABLE -> Level.INFO
        Replay.NOT_READABLE -> Level.WARN
    }
}
