package fr.emse.canari.keyboard

/**
 * WHAT THE CONTENT'S BOTTOM PADDING DOES WHEN THE KEYBOARD'S INSET CHANGES (keyboard motion,
 * docs/wiki/frontend/keyboard-and-send-motion.md).
 *
 * Messenger draws its final layout on the first frame of a keyboard rise and lets the keyboard slide
 * up under it. Canari's page cannot: padding the content resizes the WebView, and the WebView shows
 * its LAST frame, cropped to the new size, until the page has laid out and drawn again - 128 ms on
 * the Mi 9T (8 frames, 2026-11-13), during which the composer is cut off. So a rise is HANDED OFF:
 * the page is told the keyboard's height first and lays itself out for it inside the full-size
 * WebView, and the padding lands only once the WebView reports that frame drawn
 * (`postVisualStateCallback`). The crop then removes only the band the keyboard is about to cover,
 * and the frames on either side of the resize are the same picture.
 *
 * - [HAND_OFF]: a rise from no keyboard while a page is there to take the target.
 * - [APPLY_NOW]: everything else that changes the padding - a fall (the WebView grows; the keyboard
 *   still covers what it uncovers), a height change while open, or no page to tell. It also ends a
 *   hand-off still in flight, whose target is no longer the keyboard's.
 * - [NOTHING]: the padding already is, or is already on its way to, this inset.
 *
 * Pure: compiled by the plain-JVM `android-tests` project, which has no Android classpath (an Android
 * import here breaks that build, and that is the guard).
 */
enum class ImeStep { HAND_OFF, APPLY_NOW, NOTHING }

/**
 * @param padding the content's bottom padding now, in px.
 * @param ime the keyboard's bottom inset in the insets being applied, in px.
 * @param pending the inset a hand-off in flight is taking the padding to, or null.
 * @param pageReachable whether a WebView exists to be told the target.
 */
fun imeStep(padding: Int, ime: Int, pending: Int?, pageReachable: Boolean): ImeStep {
    if (pending != null && ime == pending) return ImeStep.NOTHING
    if (pending == null && ime == padding) return ImeStep.NOTHING
    if (padding == 0 && ime > 0 && pageReachable) return ImeStep.HAND_OFF
    return ImeStep.APPLY_NOW
}

/**
 * The keyboard's height in the page's CSS px, which on Android's WebView are the display's dp:
 * `px / density`, kept to two decimals so the page can subtract it from `innerHeight` without a
 * rounding step of its own (the page compares heights within 2 CSS px anyway).
 */
fun imeCssPx(px: Int, density: Float): String {
    if (density <= 0f) return "0"
    val hundredths = Math.round(px / density * 100f)
    return "${hundredths / 100}.${(hundredths % 100).toString().padStart(2, '0')}"
}
