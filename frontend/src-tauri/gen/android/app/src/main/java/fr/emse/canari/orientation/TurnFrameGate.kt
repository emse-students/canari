package fr.emse.canari.orientation

/**
 * Whether the WebView's resize from [oldWidth] x [oldHeight] to [newWidth] x [newHeight] is a TURN of
 * the screen: its longer side changed axis. A keyboard, a split screen or a status bar resizes one
 * side and never flips the shape, so this is read from the box itself, not from a configuration
 * delivered on another path. An unmeasured box (a zero side) is no turn.
 */
fun isTurn(oldWidth: Int, oldHeight: Int, newWidth: Int, newHeight: Int): Boolean {
    if (oldWidth <= 0 || oldHeight <= 0 || newWidth <= 0 || newHeight <= 0) return false
    return (oldWidth > oldHeight) != (newWidth > newHeight)
}

/**
 * The script that tells the shell when THE PAGE has the turn's shape: it calls
 * `canariTurn.laidOut(token)` at once if the layout viewport is already [landscape] (or not), else on
 * the `resize` that makes it so, and stops listening then. Run in the page's main thread, so the
 * answer means the renderer has applied the new size - every frame it commits from then on is laid
 * out at it.
 */
fun turnLaidOutScript(token: Long, landscape: Boolean): String =
    "(function(){var t='$token';function c(){if((innerWidth>innerHeight)===$landscape){" +
        "removeEventListener('resize',c);window.canariTurn&&canariTurn.laidOut(t);}}" +
        "addEventListener('resize',c);c();})();"

/**
 * THE WINDOW SHOWS NO FRAME OF THE WEBVIEW AT ITS OLD SIZE AFTER A TURN (owner, Mi 9T, 2026-11-15:
 * "Garder l'ancienne image jusqu'a la nouvelle"; docs/wiki/frontend/screen-orientation.md, "A turn
 * shows no stale frame").
 *
 * A turn resizes the WebView at once, but its content is the renderer's last frame, laid out at the
 * OLD size until the renderer commits one at the new size. Drawn in between, that frame is the
 * portrait page stuck at the left of a landscape screen (or the reverse) beside black. So the draw is
 * HELD from the turn, in two proofs and no clock:
 *
 * 1. [hold]: the WebView's box flipped shape; the page is asked when IT has that shape
 *    ([turnLaidOutScript]) - the WebView may forward the new size to the renderer later than its own
 *    resize (measured: 2 turns in 8 had a visual-state callback 24-31 ms after the resize, at the OLD
 *    size), so a frame proof asked at the resize could be answered by an old-size frame.
 * 2. [laidOut]: the page has the shape; only now is the WebView's visual-state callback posted, and
 *    every commit it can be answered by is laid out at the new size.
 * 3. [frameReady]: that callback came - the draw is released, and the window manager, which waits for
 *    the window's first draw in the new rotation, turns the screen onto the laid-out page.
 *
 * Each turn takes a new token; only the newest token moves the hold, so a second turn made before the
 * first frame came keeps it until ITS frame. Pure state, UI thread only: compiled by the plain-JVM
 * `android-tests` project (an Android import here breaks that build, which is the guard).
 */
class TurnFrameGate {
    private var newest = 0L
    private var pageLaidOut = false

    /** Whether the window's draw is held now. */
    var holding = false
        private set

    /** A turn was laid out by the WebView: the draw is held, and the token follows it. */
    fun hold(): Long {
        newest += 1
        holding = true
        pageLaidOut = false
        return newest
    }

    /**
     * The page said it has turn [token]'s shape. True when the visual-state callback must be posted
     * now (the newest turn, held, not yet answered); false for an older turn or a repeated answer.
     */
    fun laidOut(token: Long): Boolean {
        if (!holding || token != newest || pageLaidOut) return false
        pageLaidOut = true
        return true
    }

    /**
     * The visual-state callback of [token] came. True when it released the hold (the newest turn's,
     * posted after the page had the shape); false otherwise, and the hold stays.
     */
    fun frameReady(token: Long): Boolean {
        if (!holding || token != newest || !pageLaidOut) return false
        holding = false
        return true
    }
}
