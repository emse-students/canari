package fr.emse.canari.camera

/**
 * THE CAMERA IN FRONT: the volume keys as its shutter and the phone's angle for its glyphs (owner,
 * 2026-11-11; design: docs/wiki/frontend/screen-orientation.md, "The camera keeps its layout").
 *
 * The page's camera screen ARMS a flag (`window.canariCamera.set("on")`) while its live preview is in
 * front and disarms it at teardown; the activity also disarms it at `onPause`, so no stale flag
 * survives the app leaving the screen. While armed, the activity hands every volume key event to
 * [cameraKeyAction] before anything else sees it, and runs an `OrientationEventListener` whose angles
 * go through [angleWorthSending].
 *
 * Pure: compiled by the plain-JVM `android-tests` project, which has no Android classpath (an Android
 * import here breaks that build, and that is the guard).
 */

/** `android.view.KeyEvent` constants, restated because this file may not import Android. */
object Keys {
    const val KEYCODE_VOLUME_UP = 24
    const val KEYCODE_VOLUME_DOWN = 25
    const val ACTION_DOWN = 0
    const val ACTION_UP = 1
}

/** What the activity does with one key event. */
enum class CameraKeyAction {
    /** The first `down` of a press: the page's shutter press. Consumed. */
    PRESS,

    /** The key let go: the page's shutter release. Consumed. */
    RELEASE,

    /** A volume key's auto-repeat (or an action the shutter has no use for): consumed, nothing sent. */
    SWALLOW,

    /** Not the camera's: the system handles it as usual (the volume moves). */
    PASS
}

/**
 * The fate of a key event: only a VOLUME key, only while the camera is [armed]. A held key repeats
 * its `down` (`repeatCount` > 0); only the first is the press, and the repeats are swallowed so the
 * system volume never moves during a take filmed with the key held.
 */
fun cameraKeyAction(armed: Boolean, keyCode: Int, action: Int, repeatCount: Int): CameraKeyAction {
    if (!armed) return CameraKeyAction.PASS
    if (keyCode != Keys.KEYCODE_VOLUME_UP && keyCode != Keys.KEYCODE_VOLUME_DOWN) return CameraKeyAction.PASS
    return when {
        action == Keys.ACTION_DOWN && repeatCount == 0 -> CameraKeyAction.PRESS
        action == Keys.ACTION_UP -> CameraKeyAction.RELEASE
        else -> CameraKeyAction.SWALLOW
    }
}

/** `OrientationEventListener.ORIENTATION_UNKNOWN`: the phone lies flat, no angle to read. */
const val ORIENTATION_UNKNOWN = -1

/**
 * The smallest move, in degrees, worth telling the page. The page turns the angle into a quarter turn
 * with its own hysteresis (`quadrantFor`, `cameraHardware.svelte.ts`); this only keeps the sensor's
 * stream of near-identical angles off the WebView bridge.
 */
const val ANGLE_STEP_DEG = 10

/**
 * Whether `now` (the listener's clockwise angle from upright, 0-359) is worth sending, given the
 * angle `last` sent (null: nothing yet, so the first reading always goes). A flat phone sends nothing.
 */
fun angleWorthSending(last: Int?, now: Int): Boolean {
    if (now == ORIENTATION_UNKNOWN || now < 0) return false
    if (last == null) return true
    val d = Math.floorMod(now - last, 360)
    return minOf(d, 360 - d) >= ANGLE_STEP_DEG
}
