package fr.emse.canari

import android.content.Context
import android.util.Log
import fr.emse.canari.push.HandedQuickReplies
import org.json.JSONObject

/**
 * THE DURABLE RECORD OF THE QUICK REPLIES HANDED TO THE PAGE ([HandedQuickReplies]): one entry per
 * reply, keyed by its id, written BEFORE its banner says "sending" and removed when the page settles
 * it - so a process that dies between the two still knows what its banner promised, and the next
 * page's sweep says the reply lost rather than leaving "sending" for good.
 *
 * Every read and write runs under [LOCK], the receiver's hand-over, the page's settlement and the
 * sweep alike. Lock order: [LOCK], then the Rust quick-reply file lock (through the hand-over and the
 * sweep's read) or `READ_ELSEWHERE.lock` (the banner) - never the other way, and never under
 * `OUTBOX_LOCK`.
 */
internal object HandedQuickReplyStore {
    private const val TAG = "HandedQuickReplies"
    private const val PREFS = "canari_handed_quick_replies"

    /** The one lock of the record (see the class comment for its order). */
    val LOCK = Any()

    /** Records [handed]; false when the write failed (said). The caller holds [LOCK]. */
    fun record(context: Context, handed: HandedQuickReplies.Handed): Boolean {
        val json = JSONObject()
            .put("accountId", handed.accountId)
            .put("groupId", handed.groupId)
            .put("text", handed.text)
            .put("repliedAt", handed.repliedAt)
            .put("notifiedAt", handed.notifiedAt)
            .put("notifiedServerAt", handed.notifiedServerAt)
            .toString()
        val written = prefs(context).edit().putString(handed.replyId, json).commit()
        if (!written) Log.e(TAG, "record: reply id=${handed.replyId.take(8)} NOT recorded - its banner cannot follow the page")
        return written
    }

    /** The record of [replyId], or null. The caller holds [LOCK]. */
    fun peek(context: Context, replyId: String): HandedQuickReplies.Handed? =
        prefs(context).getString(replyId, null)?.let { parse(replyId, it) }

    /** Removes and returns the record of [replyId], or null. The caller holds [LOCK]. */
    fun take(context: Context, replyId: String): HandedQuickReplies.Handed? {
        val handed = peek(context, replyId)
        if (!prefs(context).edit().remove(replyId).commit()) {
            Log.e(TAG, "take: reply id=${replyId.take(8)} NOT removed from the record - a later sweep may say it lost")
        }
        return handed
    }

    /** Every record. The caller holds [LOCK]. */
    fun all(context: Context): List<HandedQuickReplies.Handed> =
        prefs(context).all.mapNotNull { (id, value) -> (value as? String)?.let { parse(id, it) } }

    private fun parse(replyId: String, json: String): HandedQuickReplies.Handed? = try {
        val o = JSONObject(json)
        HandedQuickReplies.Handed(
            replyId = replyId,
            accountId = o.getString("accountId"),
            groupId = o.getString("groupId"),
            text = o.optString("text"),
            repliedAt = o.optLong("repliedAt"),
            notifiedAt = o.optLong("notifiedAt"),
            notifiedServerAt = o.optLong("notifiedServerAt"),
        )
    } catch (e: Exception) {
        Log.e(TAG, "parse: the record of reply id=${replyId.take(8)} is unreadable - skipped: ${e.javaClass.simpleName}")
        null
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
