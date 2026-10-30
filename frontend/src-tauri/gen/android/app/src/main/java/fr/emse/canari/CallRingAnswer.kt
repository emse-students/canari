package fr.emse.canari

import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * THE NATIVE ANSWER IS CARRIED BY A PRIVATE INTENT, NEVER A PUBLIC URL (calls.md, "An answer from
 * the ring joins on the ring's facts").
 *
 * Each ring this phone shows is recorded here with a random nonce ([record]); the ring's Answer
 * PendingIntent carries the call id and that nonce as EXTRAS ([putAnswer]), its URL only the
 * conversation to open. [MainActivity] hands every intent it receives to [takeAnswer], which writes
 * `pending_call_accept.json` - from the RECORDED facts, never the intent's - only when the nonce
 * matches a ring still recorded, and forgets the record so an answer is taken once. The webview
 * drains that file (`read_and_clear_pending_call_accept`), exactly as it drains the iPhone's CallKit
 * answer.
 *
 * Stored in a private preferences file rather than memory, so an answer still works when the
 * process died between the ring and the tap; the record dies with its ring ([forget], [forgetAll]).
 */
internal object CallRingAnswer {
    private const val TAG = "CallRingAnswer"
    private const val PREFS = "canari_call_ring_answers"
    private const val PENDING_FILE = "pending_call_accept.json"
    const val EXTRA_ANSWER_CALL_ID = "fr.emse.canari.answerCallId"
    const val EXTRA_ANSWER_NONCE = "fr.emse.canari.answerNonce"

    /** Records a ring this phone shows and returns the nonce its Answer intent must carry. */
    fun record(context: Context, groupId: String, callId: String, callerId: String, hasVideo: Boolean): String {
        val nonce = UUID.randomUUID().toString()
        val entry = JSONObject()
            .put("nonce", nonce)
            .put("groupId", groupId)
            .put("callerId", callerId)
            .put("hasVideo", hasVideo)
            .put("rungAt", System.currentTimeMillis())
        prefs(context).edit().putString(callId, entry.toString()).apply()
        Log.d(TAG, "record: ring call=$callId recorded for its answer")
        return nonce
    }

    /** Puts the answer extras on the ring's Answer intent. */
    fun putAnswer(intent: Intent, callId: String, nonce: String) {
        intent.putExtra(EXTRA_ANSWER_CALL_ID, callId)
        intent.putExtra(EXTRA_ANSWER_NONCE, nonce)
    }

    /** Forgets the ring of [callId] (it stopped, for whatever reason). */
    fun forget(context: Context, callId: String) {
        if (callId.isEmpty()) return
        prefs(context).edit().remove(callId).apply()
    }

    /** Forgets every ring (the app came to the foreground, which ends them all). */
    fun forgetAll(context: Context) {
        prefs(context).edit().clear().apply()
    }

    /**
     * Takes the answer an intent carries, if it carries one: writes the pending accept for the
     * webview when its nonce names a ring still recorded. Returns true when an answer was taken.
     */
    fun takeAnswer(context: Context, intent: Intent?): Boolean {
        val callId = intent?.getStringExtra(EXTRA_ANSWER_CALL_ID) ?: return false
        val nonce = intent.getStringExtra(EXTRA_ANSWER_NONCE).orEmpty()
        // Taken once: a relaunch that re-delivers this intent finds nothing to take.
        intent.removeExtra(EXTRA_ANSWER_CALL_ID)
        intent.removeExtra(EXTRA_ANSWER_NONCE)
        val raw = prefs(context).getString(callId, null)
        if (raw == null) {
            Log.w(TAG, "takeAnswer: call=$callId is not a ring this phone shows - nothing answered")
            return false
        }
        val entry = try {
            JSONObject(raw)
        } catch (e: Exception) {
            Log.e(TAG, "takeAnswer: the record of call=$callId is unreadable - nothing answered: ${e.message}")
            forget(context, callId)
            return false
        }
        if (nonce.isEmpty() || entry.optString("nonce") != nonce) {
            Log.w(TAG, "takeAnswer: call=$callId answered with a nonce its ring never issued - nothing answered")
            return false
        }
        forget(context, callId)
        val pending = JSONObject()
            .put("groupId", entry.optString("groupId"))
            .put("callId", callId)
            .put("callerId", entry.optString("callerId"))
            .put("hasVideo", entry.optBoolean("hasVideo"))
            .put("rungAt", entry.optLong("rungAt"))
            .put("acceptedAt", System.currentTimeMillis())
        return try {
            val dir = MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }
            val tmp = File(dir, "$PENDING_FILE.tmp")
            tmp.writeText(pending.toString())
            if (!tmp.renameTo(File(dir, PENDING_FILE))) error("rename failed")
            Log.i(TAG, "takeAnswer: call=$callId answered on the ring - pending accept written")
            true
        } catch (e: Exception) {
            Log.e(TAG, "takeAnswer: the pending accept of call=$callId could not be written: ${e.message}")
            false
        }
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
