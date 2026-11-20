package app.tauri.gallery

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import java.util.concurrent.Executors

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
 * (`chat_<group>`, long-lived) share the dynamic set and are a different id space with their own
 * record and their own erase at sign-out ([ConversationShortcuts]): this object adds and removes
 * by ITS OWN ids only, never `setDynamicShortcuts` or `removeAllDynamicShortcuts`, which would take
 * theirs too.
 *
 * WHAT IS REMOVED, AND HOW IT IS KNOWN. Every id this object may have left published is recorded
 * ([ShortcutRecord]) BEFORE the platform is touched - a record that cannot be written aborts the
 * call - so a later process still names exactly what to remove: an ALLOWLIST, never a pattern. An
 * id leaves the record only once its removal returned, and a publish that could not remove a stale
 * id says so ([Published.leftover]), so the page does not believe the set is what it asked for.
 *
 * A SHORTCUT THE MEMBER PINNED to the home screen cannot be removed by any app: it is DISABLED
 * instead (`disablePinnedShortcuts`), and the launcher decides whether it still shows it.
 *
 * THE PICTURE. Each target carries an [ShortcutIcons.Avatar] - an id and a kind, never a location nor bytes - and
 * is published with its picture ([ShortcutIcons.adaptive]): the cached one when the app's file
 * cache holds it, else the initials disc of its label. A picture NOT cached is fetched by the app's
 * own path afterwards, on [iconThread] - a publish never waits for the network - and the target is
 * pushed again under the SAME id, which replaces it (idempotent). That second push is guarded by
 * [generations]: a later publish or a clear (sign-out) ends or replaces it, and an upgrade fetched under an older
 * one is dropped, so a slow fetch can never put a conversation back after the clear. The files are
 * the app's avatar caches, which already exist for the notifications: this object adds none.
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

    private val record = ShortcutRecord("canari_share_targets", TAG)

    /** Longest avatar id accepted: a user id or a media id, far below this. */
    private const val MAX_AVATAR_ID_LENGTH = 100

    /** One target as the page sends it. */
    class Target(val id: String, val label: String, val link: String, val avatar: ShortcutIcons.Avatar? = null)

    /** Runs the avatar fetches that a publish must not wait for - one at a time, in order. */
    private val iconThread = Executors.newSingleThreadExecutor()

    /**
     * Started by every publish, ended by every clear. An icon upgrade pushes only under the
     * generation it was started in, so it cannot outlive the set it belongs to.
     */
    private val generations = UpgradeGeneration()

    /**
     * What a publish left: [present] suggestions the platform actually lists afterwards, and
     * [leftover] stale ones it could not remove (still recorded, for the next call).
     */
    class Published(val present: Int, val leftover: Int)

    /**
     * Replaces the published targets with [targets], in that order (rank 0 first), capped at the
     * platform's per-activity maximum. Throws when the record cannot be written - nothing is then
     * touched.
     */
    @Synchronized
    fun publish(activity: Activity, targets: List<Target>): Published {
        val context = activity.applicationContext
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)
        val valid = targets.filter { isValid(it) }.distinctBy { it.id }
        if (valid.size < targets.size) {
            Log.w(TAG, "publish: ${targets.size - valid.size} malformed target(s) dropped")
        }
        val kept = valid.take(max).map { dropMalformedAvatar(it) }
        if (kept.size < valid.size) {
            Log.w(TAG, "publish: capped at the platform maximum of $max")
        }
        val keptIds = kept.map { it.id }
        val previous = record.read(context)
        val stale = previous - keptIds.toSet()
        // RECORDED FIRST: a process that dies below must still be able to name what it published.
        if (!record.write(context, previous + keptIds)) {
            throw IllegalStateException("the share targets could not be recorded - nothing published")
        }
        val staleLeft = if (stale.isEmpty() || remove(context, stale)) emptyList() else stale
        enablePinned(context, keptIds)
        val icons = ShortcutIcons.requireSource("publish")
        val activityClass = activity.javaClass
        val started = generations.next()
        // The targets whose picture the cache MISSES - not the ones it remembers as absent, which
        // have nothing to fetch: fetched afterwards.
        val toFetch = mutableListOf<Pair<Int, Target>>()
        for ((rank, target) in kept.withIndex()) {
            // One shortcut at a time, each in its own try: one refused by the platform must not
            // take the others with it.
            try {
                val avatar = target.avatar
                val state = if (icons != null && avatar != null) cachedPicture(context, icons, avatar, rank) else null
                if (state is ShortcutIcons.Cached.Miss) toFetch.add(rank to target)
                val picture = (state as? ShortcutIcons.Cached.Hit)?.picture ?: icons?.initials(context, target.label)
                if (!pushOne(context, activityClass, target, rank, picture)) {
                    Log.w(TAG, "publish: the platform refused target #$rank")
                }
            } catch (e: Exception) {
                Log.e(TAG, "publish: target #$rank failed: ${e.javaClass.simpleName}")
            }
        }
        if (icons != null && toFetch.isNotEmpty()) {
            Log.d(TAG, "publish: ${toFetch.size} picture(s) to fetch after the publish")
            iconThread.execute { upgradeIcons(context, activityClass, icons, toFetch, started) }
        }
        record.write(context, staleLeft + keptIds)
        // WHAT THE PLATFORM LISTS, not what was pushed: a push can succeed and be evicted at once
        // by the per-activity cap the notification shortcuts share.
        val present = ShortcutManagerCompat.getDynamicShortcuts(context).count { it.id.startsWith(ID_PREFIX) }
        Log.i(TAG, "publish: $present of ${kept.size} present, ${stale.size - staleLeft.size} removed, ${staleLeft.size} left to remove")
        return Published(present, staleLeft.size)
    }

    /** Removes every target this object recorded. Returns how many; throws when the platform refused. */
    @Synchronized
    fun clear(context: Context): Int {
        // A picture still being fetched for a target of THIS set must not push it back afterwards.
        generations.invalidate()
        val ids = record.read(context)
        if (ids.isEmpty()) {
            Log.d(TAG, "clear: nothing published")
            return 0
        }
        if (!remove(context, ids)) {
            throw IllegalStateException("${ids.size} share target(s) not removed - kept on record")
        }
        record.write(context, emptyList())
        Log.i(TAG, "clear: ${ids.size} target(s) removed")
        return ids.size
    }

    /** An avatar the page named wrongly is dropped (logged); the target itself is still published. */
    private fun dropMalformedAvatar(target: Target): Target {
        val avatar = target.avatar ?: return target
        val ok = (avatar.kind == ShortcutIcons.AVATAR_USER || avatar.kind == ShortcutIcons.AVATAR_MEDIA) &&
            avatar.id.isNotBlank() && avatar.id.length <= MAX_AVATAR_ID_LENGTH
        if (ok) return target
        Log.w(TAG, "publish: a malformed avatar (kind length ${avatar.kind.length}) dropped, initials drawn instead")
        return Target(target.id, target.label, target.link, null)
    }

    /** What the cache holds for [avatar]; a read that throws is logged and counts as a miss. */
    private fun cachedPicture(context: Context, icons: ShortcutIcons.Source, avatar: ShortcutIcons.Avatar, rank: Int): ShortcutIcons.Cached = try {
        icons.cached(context, avatar)
    } catch (e: Exception) {
        Log.w(TAG, "publish: target #$rank: the cache could not be read: ${e.javaClass.simpleName}")
        ShortcutIcons.Cached.Miss
    }

    /**
     * Pushes ONE target with [picture] (null: no icon - only when no icon source is registered).
     * The first publish and the later upgrade go through this one call, so they cannot drift.
     */
    private fun pushOne(context: Context, activityClass: Class<*>, target: Target, rank: Int, picture: Bitmap?): Boolean {
        val builder = ShortcutInfoCompat.Builder(context, target.id)
            .setShortLabel(target.label)
            .setLongLabel(target.label)
            .setCategories(setOf(CATEGORY))
            .setRank(rank)
            // A tap from the launcher's long-press menu opens the conversation, the same deep link
            // as a tapped notification.
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(target.link), context, activityClass))
        if (picture != null) builder.setIcon(ShortcutIcons.adaptive(picture))
        return ShortcutManagerCompat.pushDynamicShortcut(context, builder.build())
    }

    /**
     * Fetches each missing picture and pushes its target again with it, under the SAME id. Runs on
     * [iconThread]. A target with no picture (the server answered there is none) or a failed fetch
     * keeps its initials - the app side has logged why. Each push is made through
     * [UpgradeGeneration.runIfCurrent], so only while [started] is still the current generation.
     */
    private fun upgradeIcons(
        context: Context,
        activityClass: Class<*>,
        icons: ShortcutIcons.Source,
        pending: List<Pair<Int, Target>>,
        started: Long
    ) {
        var done = 0
        for ((rank, target) in pending) {
            val avatar = target.avatar ?: continue
            try {
                val picture = icons.fetch(context, avatar) ?: continue
                val current = generations.runIfCurrent(started) {
                    if (pushOne(context, activityClass, target, rank, picture)) done++
                    else Log.w(TAG, "upgradeIcons: the platform refused the picture of target #$rank")
                    true
                }
                if (current == null) {
                    Log.d(TAG, "upgradeIcons: superseded by a later publish or a clear, the rest dropped")
                    return
                }
            } catch (e: Exception) {
                Log.e(TAG, "upgradeIcons: target #$rank failed: ${e.javaClass.simpleName}")
            }
        }
        Log.i(TAG, "upgradeIcons: $done of ${pending.size} picture(s) set")
    }

    /** Removes [ids] from the dynamic set, and disables any the member pinned. */
    private fun remove(context: Context, ids: List<String>): Boolean = try {
        ShortcutManagerCompat.removeDynamicShortcuts(context, ids)
        disablePinnedShortcuts(context, ids, TAG)
        true
    } catch (e: Exception) {
        Log.e(TAG, "remove: ${ids.size} target(s) not removed: ${e.message}", e) // log-safe: message of a system or native call (Exception); this try parses and names no user input
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
            Log.e(TAG, "publish: pinned targets not enabled again: ${e.message}", e) // log-safe: message of a system or native call (Exception); this try parses and names no user input
        }
    }

    private fun isValid(target: Target): Boolean =
        target.id.startsWith(ID_PREFIX) &&
            target.id.length in (ID_PREFIX.length + 1)..MAX_ID_LENGTH &&
            target.label.isNotBlank() &&
            target.label.length <= MAX_LABEL_LENGTH &&
            Uri.parse(target.link).scheme?.isNotEmpty() == true
}
