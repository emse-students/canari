package fr.emse.canari

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import fr.emse.canari.FcmLog as Log
import fr.emse.canari.push.ConversationRef
import fr.emse.canari.push.HeldFrame
import fr.emse.canari.push.HeldFrames
import fr.emse.canari.push.throwableSite
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * REPLAYS THE PUSHES THE NETWORK OR THE LOCK STOPPED, ONCE A NETWORK IS BACK (2026-11-25).
 *
 * A visible push whose decrypt could not reach the server ([fr.emse.canari.push.ServerFetch]) or
 * found the MLS state lock held posts the generic "Nouveau message" line and HOLDS its frame here,
 * with the instant of that line. This job - one per conversation, waiting on
 * `NetworkType.CONNECTED`, an event and not a clock - replays each held frame through the push path
 * itself ([CanariFirebaseMessagingService.replayHeldFrameOnLane]: the same decrypt, ladder, foreground
 * yield and presentation) and the real line REPLACES the generic one. It is what step 6 of the
 * background ladder used to promise of `MlsBackgroundWorker`, which only ever swept the pending DB.
 *
 * A COROUTINE WORKER THAT BLOCKS NO THREAD. Every step - pick the next held frame, replay it, settle
 * it - is ONE task on the MLS push lane, and the job suspends until the lane ran it. WorkManager's
 * shared pool (a handful of threads, shared with the outbox retry) is never parked behind MLS work,
 * however many conversations come back with the network; a cancel frees the job at once. And because
 * the lane is one thread, two runs of a conversation (a `REPLACE`d one and its successor) never
 * replay side by side - no lock is needed.
 *
 * WHAT ENDS A HELD FRAME IS DURABLE STATE, NEVER A COUNT OR A TIMER ([HeldFrames]):
 * - a generic line that left the shade (read here, read elsewhere, swiped) has nothing to upgrade:
 *   the frame is dropped before any MLS work, at debug, and nothing is re-posted;
 * - a frame the app's drain read is refused for good by the advanced state: dropped at debug;
 * - the app in front keeps every frame (its engine owns the state) and cancels the jobs; its move to
 *   the background enqueues them again ([handBack]). An app opened offline drains nothing, so its
 *   frames are still owed - which is why the takeover never empties the store;
 * - a network that is up and still refuses, or a lock still held, keeps the frame and the run
 *   retries on WorkManager's backoff until one of the above ends it.
 *
 * The store is a file in `noBackupFilesDir`: the frames are ciphertext plus the push's cleartext
 * fields, and a restore onto another device could open none of them.
 */
class HeldFrameWorker(context: Context, workerParams: WorkerParameters) :
    CoroutineWorker(context, workerParams) {

    companion object {
        const val TAG = "CanariHeldFrame"

        /** The conversation a job replays, in its input data. */
        private const val KEY_GROUP = "groupId"

        private const val STORE_FILE = "held_push_frames.json"

        /** Guards every read-modify-write of [STORE_FILE], the enqueue that follows a hold, and the takeover. */
        private val STORE_LOCK = Any()

        /**
         * Holds [frame] and enqueues its conversation's replay. Written BEFORE the enqueue, under one
         * lock, so the job that runs always finds it - and refused while the app is in front, asked
         * under that same lock, so a push and the move to the front cannot interleave ([takenOverByApp]).
         */
        fun hold(context: Context, frame: HeldFrame) {
            synchronized(STORE_LOCK) {
                if (!HeldFrames.admits(MainActivity.isInForeground)) {
                    Log.d(TAG, "hold: the app is in front, its drain reads the frame -> not held group=${ConversationRef.of(frame.groupId)}")
                    return
                }
                val held = HeldFrames.hold(readStore(context), frame)
                if (!writeStore(context, held)) {
                    Log.e(TAG, "hold: the store could not be written -> the generic line stays until the app opens group=${ConversationRef.of(frame.groupId)}")
                    return
                }
                enqueue(context, frame.groupId)
                Log.iRecorded(TAG, "hold: frame held for a replay group=${ConversationRef.of(frame.groupId)} held=${held.count { it.groupId == frame.groupId }}")
            }
        }

        /** The conversation's ONE replay job ([HeldFrames.uniqueWorkName], why REPLACE is there). */
        private fun enqueue(context: Context, groupId: String) {
            val request = OneTimeWorkRequestBuilder<HeldFrameWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                .setInputData(workDataOf(KEY_GROUP to groupId))
                .addTag(HeldFrames.WORK_TAG)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(HeldFrames.uniqueWorkName(groupId), ExistingWorkPolicy.REPLACE, request)
        }

        /**
         * The app came to the front: its engine owns the MLS state, so no replay may run beside it -
         * every job is cancelled. THE FRAMES STAY HELD: the app may have opened offline, and a drain
         * that never ran read nothing. A frame its drain did read is refused for good when the replay
         * meets it, and dropped then. Called by [MainActivity.onResume], off the main thread, AFTER
         * `isInForeground = true`, under the hold's lock.
         */
        fun takenOverByApp(context: Context) {
            synchronized(STORE_LOCK) {
                WorkManager.getInstance(context).cancelAllWorkByTag(HeldFrames.WORK_TAG)
                val held = readStore(context)
                if (held.isNotEmpty()) Log.d(TAG, "takenOverByApp: ${held.size} held frame(s) kept, replays cancelled while the app is in front")
            }
        }

        /**
         * The app left the front: every conversation with a frame still held gets its job back, as
         * [OutboxRetryWorker.enqueueIfMirrorHolds] hands the outbox back. Called by [MainActivity.onPause],
         * off the main thread.
         */
        fun handBack(context: Context) {
            synchronized(STORE_LOCK) {
                val groups = HeldFrames.groupsHeld(readStore(context))
                groups.forEach { enqueue(context, it) }
                if (groups.isNotEmpty()) Log.d(TAG, "handBack: ${groups.size} conversation(s) with held frames handed back to their replay")
            }
        }

        private fun storeFile(context: Context) = File(context.noBackupFilesDir, STORE_FILE)

        /** The store, or empty when there is none. An unreadable one is said, and read as empty. */
        private fun readStore(context: Context): List<HeldFrame> {
            val file = storeFile(context)
            if (!file.exists()) return emptyList()
            return try {
                val array = JSONArray(file.readText())
                (0 until array.length()).map { i ->
                    val o = array.getJSONObject(i)
                    val stamps = o.getJSONArray("stamps")
                    val fields = o.getJSONObject("fields")
                    HeldFrame(
                        groupId = o.getString("groupId"),
                        frameKey = o.getString("frameKey"),
                        placeholderStamps = (0 until stamps.length()).mapTo(LinkedHashSet()) { stamps.getLong(it) },
                        fields = fields.keys().asSequence().associateWith { fields.getString(it) },
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "readStore: unreadable -> read as empty, the app's drain reads the frames: ${throwableSite(e)}")
                emptyList()
            }
        }

        /** Writes the store whole (deleted when empty). False, and said, when it could not be written. */
        private fun writeStore(context: Context, held: List<HeldFrame>): Boolean {
            val file = storeFile(context)
            val written = try {
                if (held.isEmpty()) {
                    file.delete() || !file.exists()
                } else {
                    val array = JSONArray()
                    held.forEach { frame ->
                        array.put(JSONObject().apply {
                            put("groupId", frame.groupId)
                            put("frameKey", frame.frameKey)
                            put("stamps", JSONArray(frame.placeholderStamps.toList()))
                            put("fields", JSONObject(frame.fields))
                        })
                    }
                    val tmp = File(file.parentFile, "$STORE_FILE.tmp")
                    tmp.writeText(array.toString())
                    tmp.renameTo(file)
                }
            } catch (e: Exception) {
                Log.e(TAG, "writeStore: failed: ${throwableSite(e)}")
                return false
            }
            if (!written) Log.e(TAG, "writeStore: the ${if (held.isEmpty()) "delete" else "rename"} was refused - the store on disk is the previous one")
            return written
        }

        /**
         * Removes one frame from the store once its replay settled it. A store that cannot be written
         * keeps the frame, which a later run replays again: its line is gone by then, so that run ends
         * it at GONE, before any MLS work - said here at a level that accuses.
         */
        private fun settle(context: Context, frame: HeldFrame) {
            synchronized(STORE_LOCK) {
                if (!writeStore(context, HeldFrames.settle(readStore(context), frame))) {
                    Log.e(TAG, "settle: the frame could not be removed from the store group=${ConversationRef.of(frame.groupId)}")
                }
            }
        }

        /** The next frame of [groupId] this run has not replayed. */
        private fun nextHeld(context: Context, groupId: String, done: Set<String>): HeldFrame? =
            synchronized(STORE_LOCK) { HeldFrames.next(readStore(context), groupId, done) }
    }

    /** One step of a run, as the lane answered it: the frame it replayed, or none left. */
    private class Step(val frame: HeldFrame?, val replay: HeldFrames.Replay?)

    override suspend fun doWork(): Result {
        val groupId = inputData.getString(KEY_GROUP)
        if (groupId.isNullOrEmpty()) {
            Log.e(TAG, "doWork: no conversation in the request -> nothing to replay")
            return Result.failure()
        }
        val service = CanariFirebaseMessagingService().attachedTo(applicationContext)
        val done = LinkedHashSet<String>()
        val replays = mutableListOf<HeldFrames.Replay>()
        while (true) {
            val step = onLane(service) {
                // PICKED ON THE LANE: a cancelled run's last step settles its frame before this reads.
                val frame = nextHeld(applicationContext, groupId, done) ?: return@onLane Step(null, null)
                val replay = service.replayHeldFrameOnLane(frame)
                if (!HeldFrames.keeps(replay)) settle(applicationContext, frame)
                Step(frame, replay)
            }
            val frame = step.frame
            val replay = step.replay
            if (frame == null || replay == null) break
            done += frame.frameKey
            replays += replay
            val line = "doWork: replay ${replay.name} group=${ConversationRef.of(groupId)} lines=${frame.placeholderStamps.size}" // log-safe: an enum constant's name and a count
            when (HeldFrames.level(replay)) {
                HeldFrames.Level.DEBUG -> Log.d(TAG, line)
                HeldFrames.Level.INFO -> Log.iRecorded(TAG, line)
                HeldFrames.Level.WARN -> Log.w(TAG, line)
            }
        }
        if (replays.isEmpty()) {
            // THE ORDINARY END OF A REPLACED JOB, AND OF ONE AN EARLIER RUN SETTLED: nothing is owed.
            Log.d(TAG, "doWork: nothing held group=${ConversationRef.of(groupId)}")
        }
        return when (HeldFrames.runEnd(replays)) {
            HeldFrames.RunEnd.DONE -> Result.success()
            HeldFrames.RunEnd.RETRY -> Result.retry()
        }
    }

    /**
     * Runs [block] as one task of the MLS push lane and suspends until it ran. A cancel resumes the job
     * at once; the lane task it leaves behind finishes its one frame, and nothing waits for it.
     */
    private suspend fun onLane(service: CanariFirebaseMessagingService, block: () -> Step): Step =
        suspendCancellableCoroutine { cont ->
            service.onPushLane("held_frame_replay") {
                val step = try {
                    block()
                } catch (e: Throwable) {
                    Log.e(TAG, "onLane: the replay step threw: ${throwableSite(e)}")
                    Step(null, null)
                }
                if (cont.isActive) cont.resume(step)
            }
        }
}
