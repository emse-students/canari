package fr.emse.canari.orientation

import kotlin.math.abs

/**
 * Whether the WebView's resize is a TURN OF THE SCREEN: the display's rotation changed since the last
 * layout AND the box's longer side changed axis. Both, because each alone is wrong somewhere: a
 * split-screen divider, a freeform window, a fold or a split-screen keyboard can flip the box's shape
 * with no rotation, and a 180-degree turn rotates with no new shape (nothing to re-lay out). An
 * unmeasured box (a zero side) is no turn.
 */
fun isTurn(
    oldRotation: Int,
    newRotation: Int,
    oldWidth: Int,
    oldHeight: Int,
    newWidth: Int,
    newHeight: Int,
): Boolean {
    if (oldRotation == newRotation) return false
    if (oldWidth <= 0 || oldHeight <= 0 || newWidth <= 0 || newHeight <= 0) return false
    return (oldWidth > oldHeight) != (newWidth > newHeight)
}

/**
 * Whether the page's layout viewport ([cssWidth] x [cssHeight] CSS px at [devicePixelRatio], as the
 * page reports them) IS the WebView's box ([boxWidth] x [boxHeight] physical px): each side within one
 * CSS px, the page rounding to whole CSS px. THE ONE DEFINITION of "the page has the new size": the
 * page sends its numbers and only this decides, so a near-square box (1081x1080 px at 2.75 is
 * 393x393 CSS px) is judged on its size, never on a shape the two sides would round differently.
 */
fun pageMatchesBox(
    cssWidth: Double,
    cssHeight: Double,
    devicePixelRatio: Double,
    boxWidth: Int,
    boxHeight: Int,
): Boolean {
    if (devicePixelRatio <= 0.0 || cssWidth <= 0.0 || cssHeight <= 0.0) return false
    return abs(cssWidth - boxWidth / devicePixelRatio) <= 1.0 &&
        abs(cssHeight - boxHeight / devicePixelRatio) <= 1.0
}

/**
 * The script that reports the page's layout viewport for [turn] through
 * `canariTurn.size(turn, innerWidth, innerHeight, devicePixelRatio)`: once now and at every `resize`
 * until the next turn's script replaces its listener (`window.__canariTurnSize`). The page decides
 * nothing; [pageMatchesBox] does. Run in the page's main thread, so a report means the renderer has
 * applied that size - every frame it commits afterwards is laid out at it.
 */
fun turnSizeScript(turn: Long): String =
    "(function(){var o=window.__canariTurnSize;if(o)removeEventListener('resize',o);" +
        "function c(){window.canariTurn&&canariTurn.size($turn,innerWidth,innerHeight,devicePixelRatio);}" +
        "window.__canariTurnSize=c;addEventListener('resize',c);c();})();"

/** The script that removes the size listener once the hold is over. */
const val TURN_SIZE_STOP_SCRIPT: String =
    "(function(){var o=window.__canariTurnSize;if(o){removeEventListener('resize',o);window.__canariTurnSize=null;}})();"

/** Why a hold ended without its frame: the events that prove no answer can come. */
enum class TurnAbandon(val reason: String) {
    NEW_DOCUMENT("a new document started, the old one's listener is gone"),
    DETACHED("the WebView left the window"),
    PAUSED("the activity paused"),
    STOPPED("the activity stopped"),
}

/**
 * THE WINDOW SHOWS NO FRAME OF THE WEBVIEW AT ITS OLD SIZE AFTER A TURN (owner, Mi 9T, 2026-11-15:
 * "Garder l'ancienne image jusqu'a la nouvelle"; docs/wiki/frontend/screen-orientation.md, "A turn
 * shows no stale frame").
 *
 * A turn resizes the WebView at once, but its content is the renderer's last frame, laid out at the
 * OLD size until the renderer commits one at the new size. So the draw is HELD from the turn, and
 * released by proofs and terminal events, never by a clock:
 *
 * 1. [hold]: a turn ([isTurn]) laid the WebView out at a new box; the page is asked for its size
 *    ([turnSizeScript]). A later relayout during the hold moves the box ([rebox]).
 * 2. [pageSize]: the page reported a size; when it IS the box ([pageMatchesBox]) the WebView's
 *    visual-state callback is posted - asked earlier, it was answered by an OLD-size frame (Mi 9T,
 *    2 turns in 8, 24-31 ms after the resize).
 * 3. [frameReady]: that callback came - released.
 * 4. [abandon]: an event proving no answer can come ([TurnAbandon]) - released, and the caller logs
 *    it as an ERROR, since the old frame may then show.
 *
 * Each turn has its number and its start; only the newest moves the hold. Pure state, UI thread only:
 * compiled by the plain-JVM `android-tests` project (an Android import here breaks that build).
 */
class TurnFrameGate {
    /** One turn: its number, the box it must reach and when it began (nanoseconds, the caller's clock). */
    data class Turn(val number: Long, val boxWidth: Int, val boxHeight: Int, val startedAtNanos: Long)

    private var counter = 0L
    private var proofs = 0L

    /** The visual-state proof in flight for the held turn and its current box, null when none. */
    private var pendingProof: Long? = null

    /** The held turn, null when nothing is held. */
    var held: Turn? = null
        private set

    /** Whether the window's draw is held now. */
    val holding: Boolean get() = held != null

    /** A turn laid the WebView out at [boxWidth] x [boxHeight]: the draw is held for it. */
    fun hold(boxWidth: Int, boxHeight: Int, nowNanos: Long): Turn {
        counter += 1
        pendingProof = null
        return Turn(counter, boxWidth, boxHeight, nowNanos).also { held = it }
    }

    /**
     * The box changed again while held (insets settling, a second layout): the held turn now waits
     * for THAT size, and a proof already posted for the previous box no longer releases. False when
     * nothing is held or the box is the same.
     */
    fun rebox(boxWidth: Int, boxHeight: Int): Boolean {
        val turn = held ?: return false
        if (turn.boxWidth == boxWidth && turn.boxHeight == boxHeight) return false
        held = turn.copy(boxWidth = boxWidth, boxHeight = boxHeight)
        pendingProof = null
        return true
    }

    /**
     * The page reported its size for turn [number]: the id of the visual-state proof to post now when
     * the size IS the held box and no proof is in flight for it, else null.
     */
    fun pageSize(number: Long, cssWidth: Double, cssHeight: Double, devicePixelRatio: Double): Long? {
        val turn = held ?: return null
        if (turn.number != number || pendingProof != null) return null
        if (!pageMatchesBox(cssWidth, cssHeight, devicePixelRatio, turn.boxWidth, turn.boxHeight)) return null
        proofs += 1
        pendingProof = proofs
        return proofs
    }

    /** The visual-state proof [proof] came: the released turn, or null (a superseded proof, or none held). */
    fun frameReady(proof: Long): Turn? {
        val turn = held ?: return null
        if (proof != pendingProof) return null
        held = null
        pendingProof = null
        return turn
    }

    /** No answer can come any more ([TurnAbandon]): the released turn, or null when nothing was held. */
    fun abandon(): Turn? = held.also {
        held = null
        pendingProof = null
    }
}
