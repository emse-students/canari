package fr.emse.canari.orientation

/**
 * WHICH WAY THE APP MAY TURN, AS THE PAGE ASKS IT (rotation on the video and camera screens only,
 * owner, 2026-11-09; design: docs/wiki/frontend/screen-orientation.md).
 *
 * The whole app is portrait on a phone. A video or camera screen REQUESTS another mode while it is
 * mounted (`screenOrientation.svelte.ts`), and its unmount is the only path back:
 *
 * - [PORTRAIT]: the app's default, upright only.
 * - [AUTO]: follows the accelerometer AND the phone's rotation lock - `SCREEN_ORIENTATION_USER`, which
 *   is the sensor while auto-rotate is on and the user's own rotation while it is off (Android 9+ then
 *   offers its rotate suggestion in the navigation bar, the user's gesture, not ours).
 * - [LANDSCAPE]: the rotate button, landscape even with the lock on - `USER_LANDSCAPE`, so the
 *   180-degree flip between the two landscape sides still respects the lock.
 * - [LOCKED]: a take or a live on air - the rotation on screen NOW and no other, on a tablet too
 *   (`SCREEN_ORIENTATION_LOCKED`): a recording has one frame size, and a frozen portrait mapped to a
 *   tablet's free rotation, or a landscape that may still flip sides, would turn under it.
 *
 * Pure: compiled by the plain-JVM `android-tests` project, which has no Android classpath (an Android
 * import here breaks that build, and that is the guard).
 */
enum class OrientationMode(val wire: String) {
    PORTRAIT("portrait"),
    AUTO("auto"),
    LANDSCAPE("landscape"),
    LOCKED("locked");

    companion object {
        /** The page's value, or null for anything else (the caller logs and ignores it). */
        fun parse(value: String?): OrientationMode? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * `ActivityInfo.SCREEN_ORIENTATION_*`, restated because this file may not import Android. The values
 * are the platform's published constants and have not moved since API 18.
 */
object ScreenOrientation {
    const val UNSPECIFIED = -1
    const val PORTRAIT = 1
    const val USER = 2
    const val USER_LANDSCAPE = 11
    const val LOCKED = 14
}

/**
 * The `requestedOrientation` for [mode]. [lockPortrait] is `R.bool.canari_lock_portrait`: true on a
 * phone, false on a tablet (`values-sw600dp`), which is a PC here and rotates freely - so there the
 * portrait and auto modes leave the orientation to the system and only the button forces landscape.
 */
fun requestedOrientationFor(mode: OrientationMode, lockPortrait: Boolean): Int = when (mode) {
    OrientationMode.PORTRAIT ->
        if (lockPortrait) ScreenOrientation.PORTRAIT else ScreenOrientation.UNSPECIFIED
    OrientationMode.AUTO ->
        if (lockPortrait) ScreenOrientation.USER else ScreenOrientation.UNSPECIFIED
    OrientationMode.LANDSCAPE -> ScreenOrientation.USER_LANDSCAPE
    OrientationMode.LOCKED -> ScreenOrientation.LOCKED
}
