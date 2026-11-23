package app.tauri.gallery

/**
 * What the plugin tells the page about the CAMERA permission - pure, so a JVM test can pin it
 * (`CameraPermissionAnswerTest`; no Android import allowed in this directory).
 *
 * The Tauri permission states are reduced to the three the page branches on. `prompt-with-rationale`
 * is a prompt (the member refused once and may be asked again); a state the plugin did not report
 * is `unknown`, which the page reads as "no fact", never as a refusal.
 */
object CameraPermissionAnswer {
    const val GRANTED = "granted"
    const val DENIED = "denied"
    const val PROMPT = "prompt"
    const val UNKNOWN = "unknown"

    /** [state] is `PermissionState.toString()`, or null when the alias was not reported. */
    fun of(state: String?): String =
        when (state) {
            "granted" -> GRANTED
            "denied" -> DENIED
            "prompt", "prompt-with-rationale" -> PROMPT
            else -> UNKNOWN
        }
}
