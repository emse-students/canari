package app.tauri.gallery

import android.content.Context
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat

/**
 * The LONG-LIVED `chat_<group>` shortcuts that make a message notification a CONVERSATION to the
 * platform (`CanariFirebaseMessagingService.publishConversationShortcut`, which pushes through
 * [push]). They carry a conversation's name and a Person, so they belong to the account that
 * received the message: [clear] erases them at every sign-out, beside the share suggestions
 * (`ShareTargets`) - nothing of an account stays for the next one.
 *
 * Every id is RECORDED before it is pushed ([ShortcutRecord]), so the clear removes exactly what was
 * published, by id, never by matching whatever the launcher holds. The record is bounded at [CAP]:
 * past it, the conversation whose notification is the oldest is removed from the platform, which
 * also keeps the shared dynamic-shortcut budget from filling with conversations nobody hears from.
 *
 * `removeLongLivedShortcuts` removes the dynamic shortcut AND, on API 30+, the copy the system
 * cached for a posted notification.
 */
object ConversationShortcuts {
    private const val TAG = "ConversationShortcuts"

    /** Every id this object manages starts with it - the notification's `chat_<group id>`. */
    const val ID_PREFIX = "chat_"

    /** The most conversation shortcuts kept; the oldest beyond it is removed. */
    const val CAP = 30

    private val record = ShortcutRecord("canari_conversation_shortcuts", TAG)

    /**
     * Records [info]'s id, then pushes it; past [CAP], removes the oldest recorded. Returns whether
     * the platform took it. A record that cannot be written stops the push: an unrecorded shortcut
     * is one no sign-out could name.
     */
    @Synchronized
    fun push(context: Context, info: ShortcutInfoCompat): Boolean {
        val id = info.id
        if (!id.startsWith(ID_PREFIX)) {
            Log.e(TAG, "push: refused an id outside $ID_PREFIX")
            return false
        }
        val ids = record.read(context).filter { it != id } + id
        if (!record.write(context, ids)) {
            Log.e(TAG, "push: not recorded, so not pushed")
            return false
        }
        val pushed = ShortcutManagerCompat.pushDynamicShortcut(context, info)
        if (!pushed) Log.w(TAG, "push: the platform refused the shortcut")
        if (ids.size > CAP) {
            val evicted = ids.take(ids.size - CAP)
            if (remove(context, evicted)) {
                record.write(context, ids.drop(evicted.size))
                Log.i(TAG, "push: ${evicted.size} oldest conversation shortcut(s) removed, cap $CAP")
            }
        }
        return pushed
    }

    /**
     * Removes every recorded conversation shortcut - at sign-out. Returns how many; throws when the
     * platform refused, and the record then keeps them for the next clear.
     */
    @Synchronized
    fun clear(context: Context): Int {
        val ids = record.read(context)
        if (ids.isEmpty()) {
            Log.d(TAG, "clear: nothing recorded")
            return 0
        }
        if (!remove(context, ids)) {
            throw IllegalStateException("${ids.size} conversation shortcut(s) not removed - kept on record")
        }
        record.write(context, emptyList())
        Log.i(TAG, "clear: ${ids.size} conversation shortcut(s) removed")
        return ids.size
    }

    /**
     * Removes the RECORDED conversation shortcuts whose id starts with [prefix] - an allowlist read
     * from the record, never a match against whatever the launcher holds - and drops them from the
     * record. Returns how many (0 when none is recorded), or null when the record is unreadable or
     * the removal failed - both already logged, and neither may be taken for done.
     *
     * A shortcut the user PINNED to the home screen is disabled too ([disablePinnedShortcuts]): it
     * stays on the launcher, greyed, and tapping it says it is no longer available.
     *
     * Its one caller retires the salon shortcuts (`chat_channel_<id>`) the socket trigger published
     * before 2026-11-01: a salon no longer takes one, and those already out would otherwise stay
     * in the shared dynamic budget until the next sign-out.
     */
    @Synchronized
    fun removeRecordedWithPrefix(context: Context, prefix: String): Int? {
        val ids = record.readOrNull(context) ?: return null
        val doomed = ids.filter { it.startsWith(prefix) }
        if (doomed.isEmpty()) return 0
        if (!remove(context, doomed)) return null
        record.write(context, ids - doomed.toSet())
        Log.i(TAG, "removeRecordedWithPrefix: ${doomed.size} conversation shortcut(s) under $prefix removed")
        return doomed.size
    }

    private fun remove(context: Context, ids: List<String>): Boolean = try {
        ShortcutManagerCompat.removeLongLivedShortcuts(context, ids)
        disablePinnedShortcuts(context, ids, TAG)
        true
    } catch (e: Exception) {
        Log.e(TAG, "remove: ${ids.size} conversation shortcut(s) not removed: ${e.message}", e)
        false
    }
}
