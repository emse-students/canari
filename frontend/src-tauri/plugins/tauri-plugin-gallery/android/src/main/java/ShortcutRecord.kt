package app.tauri.gallery

import android.content.Context
import android.util.Log
import androidx.core.content.pm.ShortcutManagerCompat
import org.json.JSONArray

/**
 * The durable list of shortcut ids one publisher has handed the platform, oldest first - the
 * ALLOWLIST its removal works from (sharing lot S5). Written BEFORE the platform is touched, so a
 * later process (a sign-out after a restart) still names exactly what to remove; an id leaves it
 * only once its removal returned. Each publisher keeps its own file.
 */
internal class ShortcutRecord(private val prefsName: String, private val tag: String) {
    private val key = "ids"

    /** The recorded ids, oldest first; empty when nothing is recorded or the record is unreadable (said). */
    fun read(context: Context): List<String> {
        val raw = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE).getString(key, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            List(array.length()) { array.getString(it) }
        } catch (e: Exception) {
            Log.e(tag, "the shortcut record $prefsName is unreadable: ${e.message}")
            emptyList()
        }
    }

    /**
     * Replaces the record. `commit`, not `apply`: it must be on disk before the platform is
     * touched, and a `false` here means the caller must NOT touch it.
     */
    fun write(context: Context, ids: List<String>): Boolean {
        val written = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE).edit()
            .putString(key, JSONArray(ids.distinct()).toString())
            .commit()
        if (!written) Log.e(tag, "the shortcut record $prefsName (${ids.size} id(s)) was not written")
        return written
    }
}

/**
 * Disables the shortcuts among [ids] that the member pinned to the home screen: no app can unpin
 * one, so a disabled pinned shortcut no longer opens anything, and the launcher decides whether its
 * label stays. Returns how many were disabled.
 */
internal fun disablePinnedShortcuts(context: Context, ids: Collection<String>, tag: String): Int {
    val pinned = ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED)
        .map { it.id }
        .filter { it in ids }
    if (pinned.isNotEmpty()) {
        ShortcutManagerCompat.disableShortcuts(context, pinned, null)
        Log.w(tag, "${pinned.size} shortcut(s) pinned by the member - disabled, an app cannot unpin them")
    }
    return pinned.size
}
