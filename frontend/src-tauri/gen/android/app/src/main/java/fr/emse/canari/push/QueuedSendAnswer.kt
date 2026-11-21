package fr.emse.canari.push

/**
 * WHAT `POST /api/mls/push/send` ANSWERED THE BACKGROUND SENDER, AND WHETHER THE MESSAGE LEAVES ITS
 * QUEUE.
 *
 * A message counted as sent is dropped from the native outbox for good, so only an answer that is
 * the SERVER's acceptance may count. Three things look like one and are not:
 * - a 2xx whose body is JSON: the server took it; its `receivedAt` dates every recipient's copy (0
 *   when the answer carries none);
 * - a 2xx whose body is NOT JSON: a captive portal's page, not the server (the web send's rule,
 *   chat.md "A 2xx a captive portal answered is no answer") - kept;
 * - a 2xx whose body could not be READ: the transport failed after the status line - the server may
 *   have taken it, but nothing proves it - kept, logged as a transport failure and not as a non-JSON
 *   body (#3366 review, 2026-11-12). The retry may deliver the message twice: `mls/push/send` does
 *   not hand `messageId` to the server's send, so the SERVER deduplicates nothing. The next drain
 *   encrypts the kept entry afresh (`encryptQueuedMessages`), so the second copy is a new frame
 *   carrying the same inner message id, and the RECIPIENT drops it: every deduplication of a
 *   received message compares that id (`addMessageToChat`, chat.md "Every deduplication in the
 *   application compares ids").
 *
 * The JSON parse stays in the service (`org.json` is Android's); this decides from what the read
 * produced. Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object QueuedSendAnswer {

    /** What reading a 2xx body produced. */
    sealed interface BodyRead {
        /** The body parsed as JSON; [receivedAt] is its `receivedAt`, 0 when it has none. */
        data class Json(val receivedAt: Long) : BodyRead

        /** The body was read whole and is not JSON. */
        data object NotJson : BodyRead

        /** The connection failed while the body was being read; [message] is the failure's. */
        data class TransportFailed(val message: String?) : BodyRead
    }

    /**
     * Why a message stays queued, and with it whether a later drain can send it
     * ([OutboxRetry.Prospect]) - classified here, where the answer is read.
     */
    enum class KeptCause(val prospect: OutboxRetry.Prospect) {
        /** A status that is neither an acceptance nor a final refusal: a server fault, a "later". */
        NOT_ACCEPTED_STATUS(OutboxRetry.Prospect.NOT_YET),

        /** A 4xx refusal of this frame or credential ([OutboxRetry.isFinalRefusal]): never from here. */
        REFUSED(OutboxRetry.Prospect.NEVER),

        /**
         * 403 `sender_not_active` with the device's row `pending`: a re-add of this device is in
         * flight, and once it lands the same frame is accepted - read from the server's TYPED body
         * (`messaging.service.ts`, `error` and `status`), never from its prose.
         */
        SENDER_BEING_READDED(OutboxRetry.Prospect.NOT_YET),

        /** A 2xx whose body is not JSON: no answer from the server. */
        BODY_NOT_JSON(OutboxRetry.Prospect.NOT_YET),

        /** A 2xx whose body could not be read: a transport failure after the status. */
        BODY_READ_FAILED(OutboxRetry.Prospect.NOT_YET),

        /** No answer at all: DNS, connect, timeout, a reset before the status. */
        TRANSPORT_FAILED(OutboxRetry.Prospect.NOT_YET),
    }

    /** The typed fields of a refusal's JSON body (`error`, `status`); null when absent or unread. */
    data class Refusal(val error: String?, val status: String?) {
        companion object {
            val UNREAD = Refusal(null, null)
        }
    }

    /** The decision. */
    sealed interface Outcome {
        /** Sent; [receivedAt] is the server's receive time, 0 when it answered none. */
        data class Sent(val receivedAt: Long) : Outcome

        /** Kept for the next attempt, for [cause]; [detail] is the transport failure's message. */
        data class Kept(val cause: KeptCause, val detail: String? = null) : Outcome
    }

    /**
     * Decides from the status [code] and, only when it is 200 or 201, the body [readBody] produces.
     * A final refusal reads only its typed fields ([readRefusal]), and only for a 403 - the one
     * status whose `sender_not_active` is a "later" while a re-add is in flight.
     */
    fun classify(code: Int, readRefusal: () -> Refusal = { Refusal.UNREAD }, readBody: () -> BodyRead): Outcome {
        if (code != 200 && code != 201) {
            if (!OutboxRetry.isFinalRefusal(code)) return Outcome.Kept(KeptCause.NOT_ACCEPTED_STATUS)
            if (code == 403) {
                val refusal = readRefusal()
                if (refusal.error == "sender_not_active" && refusal.status == "pending") {
                    return Outcome.Kept(KeptCause.SENDER_BEING_READDED)
                }
            }
            return Outcome.Kept(KeptCause.REFUSED)
        }
        return when (val body = readBody()) {
            is BodyRead.Json -> Outcome.Sent(body.receivedAt.coerceAtLeast(0L))
            BodyRead.NotJson -> Outcome.Kept(KeptCause.BODY_NOT_JSON)
            is BodyRead.TransportFailed -> Outcome.Kept(KeptCause.BODY_READ_FAILED, body.message)
        }
    }
}
