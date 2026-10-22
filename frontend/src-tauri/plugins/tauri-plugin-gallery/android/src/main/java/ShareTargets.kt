package app.tauri.gallery

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat

/**
 * Canari's recent conversations as DIRECT targets of Android's share sheet (sharing lot S5), the
 * way Messenger offers its own: picking one delivers `ACTION_SEND` to `MainActivity` carrying
 * `EXTRA_SHORTCUT_ID`, and the page opens its share picker on that conversation.
 *
 * WHAT IS PUBLISHED. One DYNAMIC shortcut per target, in the share-target [CATEGORY] the app
 * declares in `res/xml/shortcuts.xml` (the `<share-target>` naming MainActivity and the mime types
 * of its SEND filter). NOT long-lived: a long-lived shortcut can be cached by system services
 * (conversation notifications) beyond the dynamic set, and the sheet needs none of that - so
 * removing the dynamic shortcut removes it from the sheet. The notification shortcuts
 * (`chat_<group>`, long-lived, `CanariFirebaseMessagingService`) are a different id space and are
 * never touched here: this object adds and removes by ITS OWN ids only, never `setDynamicShortcuts`
 * or `removeAllDynamicShortcuts`, which would take theirs too.
 *
 * WHAT IS REMOVED, AND HOW IT IS KNOWN. Every id this object may have left published is recorded
 * in its own preferences BEFORE the platform is touched, so a later process - a sign-out after a
 * restart - still names exactly what to remove: an ALLOWLIST of what it published, never a
 * pattern matched against whatever the launcher holds. An id leaves the record only once its
 * removal returned.
 *
 * A SHORTCUT THE MEMBER PINNED to the home screen cannot be removed by any app: it is DISABLED
 * instead (it no longer opens anything), and the launcher decides whether it still shows it. That
 * is logged with its count.
 *
 * Android 10+ (API 29) shows these in the sheet. Android 9 would need `androidx.sharetarget` and
 * its chooser service, which this app does not ship: there the shortcuts are published and the
 * sheet simply does not list them.
 */
internal object ShareTargets {
    private const val TAG = "ShareTargets"

    /**
     * The share-target category. MUST equal the `<category>` of the `<share-target>` in the app's
     * `res/xml/shortcuts.xml` - a shortcut in any other category is never shown in the sheet
     * (`androidShortcutsManifest.test.ts` pins both).
     */
    const val CATEGORY = "fr.emse.canari.category.SHARE_TARGET"

    /** The page's shortcut ids are `c:<conversation id>` (`shareTargetsNative.ts`). */
    private const val ID_PREFIX = "c:"
    private const val MAX_ID_LENGTH = 200
    private const val MAX_LABEL_LENGTH = 100

    private const val PREFS = "canari_share_targets"
    private const val KEY_IDS = "published_ids"

    /** One target as the page sends it. */
    class Target(val id: String, val label: String, val link: String)

    /**
     * Replaces the published targets with [targets], in that order (rank 0 first), capped at the
     * platform's per-activity maximum. Returns how many were published.
     */
    @Synchronized
    fun publish(activity: Activity, targets: List<Target>): Int {
        val context = activity.applicationContext
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)
        val valid = targets.filter { isValid(it) }.distinctBy { it.id }
        if (valid.size < targets.size) {
            Log.w(TAG, "publish: ${targets.size - valid.size} malformed target(s) dropped")
        }
        val kept = valid.take(max)
        if (kept.size < valid.size) {
            Log.w(TAG, "publish: capped at the platform maximum of $max")
        }
        val keptIds = kept.map { it.id }
        val previous = recordedIds(context)
        val stale = previous - keptIds.toSet()
        // RECORDED FIRST: a process that dies below must still be able to name what it published.
        record(context, previous + keptIds)
        val staleLeft = if (stale.isEmpty() || remove(context, stale.toList())) emptySet() else stale
        enablePinned(context, keptIds)
        var published = 0
        for ((rank, target) in kept.withIndex()) {
            // One shortcut at a time, each in its own try: one refused by the platform must not
            // take the others with it.
            try {
                val info = ShortcutInfoCompat.Builder(context, target.id)
                    .setShortLabel(target.label)
                    .setLongLabel(target.label)
                    .setCategories(setOf(CATEGORY))
                    .setRank(rank)
                    // A tap from the launcher's long-press menu opens the conversation, the same
                    // deep link as a tapped notification.
                    .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(target.link), context, activity.javaClass))
                    .build()
                if (ShortcutManagerCompat.pushDynamicShortcut(context, info)) {
                    published++
                } else {
                    Log.w(TAG, "publish: the platform refused target #$rank")
                }
            } catch (e: Exception) {
                Log.e(TAG, "publish: target #$rank failed: ${e.message}", e)
            }
        }
        record(context, staleLeft + keptIds)
        Log.i(TAG, "publish: $published of ${kept.size} published, ${stale.size - staleLeft.size} removed, ${staleLeft.size} left to remove")
        return published
    }

    /** Removes every target this object ever recorded. Returns how many ids were removed. */
    @Synchronized
    fun clear(context: Context): Int {
        val ids = recordedIds(context)
        if (ids.isEmpty()) {
            Log.d(TAG, "clear: nothing published")
            return 0
        }
        if (!remove(context, ids.toList())) {
            Log.e(TAG, "clear: ${ids.size} target(s) not removed - kept on record for the next clear")
            return 0
        }
        record(context, emptySet())
        Log.i(TAG, "clear: ${ids.size} target(s) removed")
        return ids.size
    }

    /** Removes [ids] from the dynamic set, and disables any the member pinned. */
    private fun remove(context: Context, ids: List<String>): Boolean = try {
        ShortcutManagerCompat.removeDynamicShortcuts(context, ids)
        val pinned = ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED)
            .map { it.id }
            .filter { it in ids }
        if (pinned.isNotEmpty()) {
            ShortcutManagerCompat.disableShortcuts(context, pinned, null)
            Log.w(TAG, "remove: ${pinned.size} target(s) pinned by the member - disabled, an app cannot unpin them")
        }
        true
    } catch (e: Exception) {
        Log.e(TAG, "remove: ${ids.size} target(s) not removed: ${e.message}", e)
        false
    }

    /** A pinned target disabled by an earlier removal is enabled again before it is republished. */
    private fun enablePinned(context: Context, ids: List<String>) {
        try {
            val disabled = ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED)
                .filter { it.id in ids && !it.isEnabled }
            if (disabled.isEmpty()) return
            ShortcutManagerCompat.enableShortcuts(context, disabled)
            Log.i(TAG, "publish: ${disabled.size} pinned target(s) enabled again")
        } catch (e: Exception) {
            Log.e(TAG, "publish: pinned targets not enabled again: ${e.message}", e)
        }
    }

    private fun isValid(target: Target): Boolean =
        target.id.startsWith(ID_PREFIX) &&
            target.id.length in (ID_PREFIX.length + 1)..MAX_ID_LENGTH &&
            target.label.isNotBlank() &&
            target.label.length <= MAX_LABEL_LENGTH &&
            Uri.parse(target.link).scheme?.isNotEmpty() == true

    private fun recordedIds(context: Context): Set<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(KEY_IDS, null)?.toSet().orEmpty()

    /** `commit`, not `apply`: the record must be on disk before the platform is touched. */
    private fun record(context: Context, ids: Set<String>) {
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(KEY_IDS, ids).commit()) {
            Log.e(TAG, "the record of ${ids.size} published target(s) was not written")
        }
    }
}
