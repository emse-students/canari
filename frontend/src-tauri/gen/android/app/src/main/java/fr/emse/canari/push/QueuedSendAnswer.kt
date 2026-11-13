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

    /** Why a message stays queued. */
    enum class KeptCause {
        /** The status was not 200 or 201: a refusal or a server fault. */
        NOT_ACCEPTED_STATUS,

        /** A 2xx whose body is not JSON: no answer from the server. */
        BODY_NOT_JSON,

        /** A 2xx whose body could not be read: a transport failure after the status. */
        BODY_READ_FAILED,
    }

    /** The decision. */
    sealed interface Outcome {
        /** Sent; [receivedAt] is the server's receive time, 0 when it answered none. */
        data class Sent(val receivedAt: Long) : Outcome

        /** Kept for the next attempt, for [cause]; [detail] is the transport failure's message. */
        data class Kept(val cause: KeptCause, val detail: String? = null) : Outcome
    }

    /**
     * Decides from the status [code] and, only when it is 200 or 201, the body [readBody] produces -
     * a refused status never reads its body.
     */
    fun classify(code: Int, readBody: () -> BodyRead): Outcome {
        if (code != 200 && code != 201) return Outcome.Kept(KeptCause.NOT_ACCEPTED_STATUS)
        return when (val body = readBody()) {
            is BodyRead.Json -> Outcome.Sent(body.receivedAt.coerceAtLeast(0L))
            BodyRead.NotJson -> Outcome.Kept(KeptCause.BODY_NOT_JSON)
            is BodyRead.TransportFailed -> Outcome.Kept(KeptCause.BODY_READ_FAILED, body.message)
        }
    }
}
