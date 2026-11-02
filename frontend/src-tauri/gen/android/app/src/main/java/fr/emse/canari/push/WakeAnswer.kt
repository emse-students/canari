package fr.emse.canari.push

/**
 * WHAT A CONTENT-FREE WAKE-UP PUSH TURNED INTO, as a pure function (owner, 2026-11-02;
 * docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
 *
 * With `push_mode = wake` the server sends this device only `type: wake`, `queuedMessageId` and
 * `silent`; the service fetches `GET /api/mls/push/wake` and runs the answer through the path a full
 * push takes. This object decides, from what the fetch returned, which of three things happened:
 *
 * - [Outcome.Frame]: the data map the full push would have carried - dispatched as one;
 * - [Outcome.Gone]: the row was drained or acknowledged since the push left - an ANSWER, nothing to
 *   draw;
 * - [Outcome.Failed]: anything else, with the stage that failed. The caller logs it at ERROR and, on
 *   a visible frame, posts a notification that says the message could not be loaded - never the
 *   generic text, which would read as a message with nothing in it.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
object WakeAnswer {

    /** The `type` a wake push carries, and that no fetched frame may carry back. */
    const val WAKE_TYPE = "wake"

    /** What one wake fetch became. */
    sealed class Outcome {
        /** The full push's data map, ready for the dispatcher. */
        data class Frame(val fields: Map<String, String>) : Outcome()

        /** The queued row is not there any more: nothing new to draw. */
        object Gone : Outcome()

        /** The fetch did not produce a frame; [stage] says where, as a code token for the log. */
        data class Failed(val stage: String) : Outcome()
    }

    /**
     * Classifies a fetch.
     *
     * @param httpStatus The response status, or null when no response arrived (a transport error).
     * @param status The body's `status` field, null when absent or unreadable.
     * @param fields The body's `fields` object as strings, null when absent.
     */
    fun classify(httpStatus: Int?, status: String?, fields: Map<String, String>?): Outcome {
        if (httpStatus == null) return Outcome.Failed("transport")
        if (httpStatus != 200) return Outcome.Failed("http-$httpStatus")
        return when (status) {
            "gone" -> Outcome.Gone
            "frame" -> when {
                fields == null -> Outcome.Failed("frame-without-fields")
                fields["type"].isNullOrEmpty() -> Outcome.Failed("frame-without-type")
                // A frame that is itself a wake would loop the dispatcher back into a fetch.
                fields["type"] == WAKE_TYPE -> Outcome.Failed("frame-is-a-wake")
                else -> Outcome.Frame(fields)
            }
            else -> Outcome.Failed("unknown-status")
        }
    }
}
