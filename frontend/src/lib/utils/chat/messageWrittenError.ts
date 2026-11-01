/**
 * Thrown by a send that failed AFTER its message was durably written - the DM/group echo and its
 * outbox entry (one write), or a salon echo and its unsent-ledger entry. The message EXISTS and its
 * queue sends it, so a caller that would otherwise retry must never send it a second time.
 *
 * Classified at the throw (review of #2843, A3): the notification quick-reply drain put a reply back
 * on any throw, and a throw from the outbox's mirror after the write would have sent it twice.
 */
export class MessageWrittenError extends Error {
  constructor(
    readonly messageId: string,
    cause: unknown
  ) {
    super(`message ${messageId.slice(0, 8)} was written, then the send failed: ${String(cause)}`, {
      cause,
    });
    this.name = 'MessageWrittenError';
  }
}

/**
 * The one write of an own message and the outbox entry that sends it FAILED - nothing of the pair
 * is on disk (`IStorage.saveMessageWithOutboxEntry` is one transaction). Thrown by
 * `addMessageToChat` instead of being swallowed: the send path then lets the outbox write its own
 * row, rather than telling it the row is already durable (review of #2843, M1).
 */
export class MessagePairWriteError extends Error {
  constructor(
    readonly messageId: string,
    cause: unknown
  ) {
    super(
      `message ${messageId.slice(0, 8)} and its outbox entry were not written: ${String(cause)}`,
      {
        cause,
      }
    );
    this.name = 'MessagePairWriteError';
  }
}
