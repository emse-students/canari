package app.tauri.gallery

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Log
import androidx.core.graphics.drawable.IconCompat

/**
 * The picture of a launcher shortcut - ONE implementation for both kinds Canari publishes: the
 * share-sheet suggestions ([ShareTargets], published from the page) and the conversation shortcuts
 * a message notification publishes (`CanariFirebaseMessagingService.publishConversationShortcut`).
 * A shortcut with no icon is the empty white circle the launcher's long-press menu showed until
 * 2026-11-20 (owner's screenshot), where Messenger and Google Messages show a face.
 *
 * WHAT THIS MODULE CANNOT DO, AND WHO DOES IT INSTEAD. The avatar fetch (the push secret, the 24 h
 * file cache, the remembered absence of a photo) and the initials disc live in the APP module,
 * which depends on this one and not the other way round. The app registers a [Source] at start
 * (`CanariApplication.onCreate`), so there is still ONE fetch path and ONE initials disc for the
 * notifications, the call surfaces and the shortcuts.
 *
 * WHAT A LAUNCHER DOES WITH THE BITMAP. [adaptive] hands the platform an ADAPTIVE bitmap: a
 * 108-unit square of which only the central 72 units are shown, cut by the launcher's own mask
 * (a circle on a Pixel). A plain bitmap is drawn unmasked and unpadded, so a disc would show
 * edge to edge and a launcher with a squircle mask would clip it.
 */
object ShortcutIcons {
    private const val TAG = "ShortcutIcons"

    /** Edge of an adaptive icon's whole canvas, in the platform's units (dp). */
    private const val ADAPTIVE_CANVAS = 108f

    /** Edge of the part of that canvas every launcher mask shows. */
    private const val ADAPTIVE_VISIBLE = 72f

    /** Where the app answers for what this module cannot reach. */
    interface Source {
        /**
         * The circular picture of [avatar] from the LOCAL cache only - no network, so it is cheap
         * enough to answer inside a publish. Null when it is not cached, or the server answered
         * that there is none.
         */
        fun cached(context: Context, avatar: ShareTargets.Avatar): Bitmap?

        /**
         * The same picture, fetched when the cache misses. NETWORK I/O: never on the main thread.
         * Null when there is none or the fetch failed (the app side logs which).
         */
        fun fetch(context: Context, avatar: ShareTargets.Avatar): Bitmap?

        /** The circular initials disc of [label] - the one every notification falls back to. */
        fun initials(label: String): Bitmap
    }

    /** Registered by the app at start; null in a process that never ran `CanariApplication`. */
    @Volatile
    var source: Source? = null

    /**
     * The icon for a shortcut: [circle] (a circular picture or initials disc, transparent outside
     * the circle) centred on an adaptive canvas so the circle is exactly the launcher's visible
     * window. [circle] is left untouched, and still usable as a notification large icon.
     */
    fun adaptive(circle: Bitmap): IconCompat {
        val canvasEdge = Math.round(circle.width * ADAPTIVE_CANVAS / ADAPTIVE_VISIBLE)
        val visibleEdge = Math.round(canvasEdge * ADAPTIVE_VISIBLE / ADAPTIVE_CANVAS)
        val offset = (canvasEdge - visibleEdge) / 2f
        val canvasBitmap = Bitmap.createBitmap(canvasEdge, canvasEdge, Bitmap.Config.ARGB_8888)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        Canvas(canvasBitmap).drawBitmap(
            Bitmap.createScaledBitmap(circle, visibleEdge, visibleEdge, true),
            offset,
            offset,
            paint
        )
        return IconCompat.createWithAdaptiveBitmap(canvasBitmap)
    }

    /** [source], or null with the accusation: reaching this means the app never registered one. */
    fun requireSource(step: String): Source? {
        val s = source
        if (s == null) Log.e(TAG, "$step: no icon source registered - shortcuts are published without a picture")
        return s
    }
}
