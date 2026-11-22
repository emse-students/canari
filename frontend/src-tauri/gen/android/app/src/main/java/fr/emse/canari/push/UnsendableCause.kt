package fr.emse.canari.push

/**
 * WHY A DRAIN MARKED A MIRROR LINE `unsendable`, written on the line as `unsendableCause` ([wire]) so
 * the page adopts the failure as what it was (`NativeRefusal` in `outboxMirror.ts`). Without it the
 * page parks the entry at its 5xx bound and said "the server answered 5xx on 5 attempts" for a 403
 * (Mi 9T, 1.7.3-alpha.6). Typed where the answer is read, never recovered from a log line.
 *
 * Compiled by the JVM test project too, so nothing here may import Android.
 */
enum class UnsendableCause(val wire: String) {
    /** The server refused this frame for good: a final 4xx ([QueuedSendAnswer.KeptCause.REFUSED]). */
    REFUSED("refused"),

    /**
     * The native batch could not encrypt it for good: its group not held here, this device removed
     * from it, a malformed proto ([OutboxRetry.Prospect.NEVER] from the encryption).
     */
    NOT_ENCRYPTABLE("not_encryptable");

    companion object {
        /**
         * The verdict a POST answer kept for [cause] carries: one for every cause that will NEVER go
         * from here, null for every other - the drain marks the line exactly when this is not null.
         */
        fun of(cause: QueuedSendAnswer.KeptCause): UnsendableCause? = when (cause) {
            QueuedSendAnswer.KeptCause.REFUSED -> REFUSED
            QueuedSendAnswer.KeptCause.NOT_ACCEPTED_STATUS,
            QueuedSendAnswer.KeptCause.SENDER_BEING_READDED,
            QueuedSendAnswer.KeptCause.CREDENTIAL_REFUSED,
            QueuedSendAnswer.KeptCause.BODY_NOT_JSON,
            QueuedSendAnswer.KeptCause.BODY_READ_FAILED,
            QueuedSendAnswer.KeptCause.TRANSPORT_FAILED -> null
        }
    }
}
