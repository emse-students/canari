package fr.emse.canari

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import fr.emse.canari.FcmLog as Log
import fr.emse.canari.push.ConversationRef
import fr.emse.canari.push.HeldFrame
import fr.emse.canari.push.HeldFrames
import fr.emse.canari.push.throwableSite
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * REPLAYS THE PUSHES THE NETWORK REFUSED, ONCE A NETWORK IS BACK (2026-11-25).
 *
 * A visible push whose commit catch-up could not reach the server ([fr.emse.canari.push.CommitFetch])
 * posts the generic "Nouveau message" line and HOLDS its frame here, with the instant of that line.
 * This job - one per conversation, waiting on `NetworkType.CONNECTED`, an event and not a clock -
 * replays each held frame through the push path itself ([CanariFirebaseMessagingService.replayHeldFrame],
 * on the MLS push lane, under the state lock, with the push's foreground yield) and the real line
 * REPLACES the generic one. It is what step 6 of the background ladder used to promise of
 * `MlsBackgroundWorker`, which only ever swept the pending DB.
 *
 * WHAT ENDS A HELD FRAME IS DURABLE STATE, NEVER A COUNT OR A TIMER ([HeldFrames]):
 * - the app coming to the front takes every frame over ([takenOverByApp]): its drain reads them from
 *   the server queue, the store is emptied, and a job that runs afterwards finds nothing - at debug;
 * - a generic line that left the shade (read here, read elsewhere, swiped) has nothing to upgrade:
 *   the frame is dropped before any MLS work, at debug, and nothing is re-posted;
 * - a network that is up and still refuses (a captive portal, a resolver failing) keeps the frame,
 *   and the run retries on WorkManager's backoff until one of the two above ends it.
 *
 * The store is a file in `noBackupFilesDir`: the frames are ciphertext plus the push's cleartext
 * fields, and a restore onto another device could open none of them.
 */
class HeldFrameWorker(context: Context, workerParams: WorkerParameters) :
    Worker(context, workerParams) {

    companion object {
        const val TAG = "CanariHeldFrame"

        /** The conversation a job replays, in its input data. */
        private const val KEY_GROUP = "groupId"

        private const val STORE_FILE = "held_push_frames.json"

        /** Guards every read-modify-write of [STORE_FILE], and the enqueue that follows a hold. */
        private val STORE_LOCK = Any()

        /**
         * Held for a whole run: a job [ExistingWorkPolicy.REPLACE] cancelled stops between two frames,
         * and its successor waits here rather than replaying beside it.
         */
        private val REPLAY_LOCK = Any()

        /**
         * Holds [frame] and enqueues its conversation's replay. Written BEFORE the enqueue, under one
         * lock, so the job that runs always finds it.
         */
        fun hold(context: Context, frame: HeldFrame) {
            synchronized(STORE_LOCK) {
                val held = HeldFrames.hold(readStore(context), frame)
                if (!writeStore(context, held)) {
                    Log.e(TAG, "hold: the store could not be written -> the generic line stays until the app opens group=${ConversationRef.of(frame.groupId)}")
                    return
                }
                val request = OneTimeWorkRequestBuilder<HeldFrameWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                    .setInputData(workDataOf(KEY_GROUP to frame.groupId))
                    .addTag(HeldFrames.WORK_TAG)
                    .build()
                // REPLACE, and why not KEEP, is on [HeldFrames.uniqueWorkName].
                WorkManager.getInstance(context)
                    .enqueueUniqueWork(HeldFrames.uniqueWorkName(frame.groupId), ExistingWorkPolicy.REPLACE, request)
                Log.iRecorded(TAG, "hold: server unreachable -> frame held for a replay once a network is back group=${ConversationRef.of(frame.groupId)} held=${held.count { it.groupId == frame.groupId }}")
            }
        }

        /**
         * The app came to the front: its engine owns the MLS state and its drain reads every held
         * frame from the server queue. The store is emptied and every replay cancelled, so none
         * re-posts what the app already holds. Called by [MainActivity.onResume], off the main thread.
         */
        fun takenOverByApp(context: Context) {
            val dropped = synchronized(STORE_LOCK) {
                val held = readStore(context)
                if (held.isNotEmpty()) writeStore(context, emptyList())
                held.size
            }
            WorkManager.getInstance(context).cancelAllWorkByTag(HeldFrames.WORK_TAG)
            if (dropped > 0) Log.d(TAG, "takenOverByApp: $dropped held frame(s) left to the app's drain")
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

        /** Writes the store whole (deleted when empty). False when it could not be written. */
        private fun writeStore(context: Context, held: List<HeldFrame>): Boolean {
            val file = storeFile(context)
            return try {
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
                false
            }
        }

        /** Removes one frame from the store once its replay settled it. */
        private fun settle(context: Context, frame: HeldFrame) {
            synchronized(STORE_LOCK) {
                writeStore(context, readStore(context).filterNot { it.groupId == frame.groupId && it.frameKey == frame.frameKey })
            }
        }
    }

    override fun doWork(): Result {
        val groupId = inputData.getString(KEY_GROUP)
        if (groupId.isNullOrEmpty()) {
            Log.e(TAG, "doWork: no conversation in the request -> nothing to replay")
            return Result.failure()
        }
        synchronized(REPLAY_LOCK) {
            val held = synchronized(STORE_LOCK) { readStore(applicationContext) }.filter { it.groupId == groupId }
            if (held.isEmpty()) {
                // THE ORDINARY END OF A REPLACED JOB, AND OF ONE THE APP OVERTOOK: nothing is owed.
                Log.d(TAG, "doWork: nothing held group=${ConversationRef.of(groupId)} (the app took it over, or an earlier run settled it)")
                return Result.success()
            }
            val service = CanariFirebaseMessagingService().attachedTo(applicationContext)
            val replays = mutableListOf<HeldFrames.Replay>()
            for (frame in held) {
                if (isStopped) {
                    Log.d(TAG, "doWork: stopped (replaced, or the network went) -> the rest is the next run's group=${ConversationRef.of(groupId)}")
                    break
                }
                val replay = service.replayHeldFrame(frame)
                replays += replay
                val line = "doWork: replay ${replay.name} group=${ConversationRef.of(groupId)} lines=${frame.placeholderStamps.size}" // log-safe: an enum constant's name and a count
                when (HeldFrames.level(replay)) {
                    HeldFrames.Level.DEBUG -> Log.d(TAG, line)
                    HeldFrames.Level.INFO -> Log.iRecorded(TAG, line)
                    HeldFrames.Level.WARN -> Log.w(TAG, line)
                }
                if (!HeldFrames.keeps(replay)) settle(applicationContext, frame)
            }
            return when (HeldFrames.runEnd(replays)) {
                HeldFrames.RunEnd.DONE -> Result.success()
                HeldFrames.RunEnd.RETRY -> Result.retry()
            }
        }
    }
}
