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
 * The pair write of a message and its outbox entry left the ENTRY on disk and not the message.
 *
 * Only SQLite can end this way: `tauri-plugin-sql` pools its connections, so the pair is two
 * statements and the entry is written first (`SqliteStorage.saveMessageWithOutboxEntry`). Thrown
 * typed so the send path knows the queue already holds the row: writing it again would put a second
 * blob in its slot, and re-staging the file would queue a second copy (review of #2874, M2).
 */
export class OutboxEntryWrittenAloneError extends Error {
  constructor(
    readonly messageId: string,
    cause: unknown
  ) {
    super(
      `outbox entry ${messageId.slice(0, 8)} was written, its message row was not: ${String(cause)}`,
      { cause }
    );
    this.name = 'OutboxEntryWrittenAloneError';
  }
}

/**
 * The one write of an own message and the outbox entry that sends it FAILED. Thrown by
 * `addMessageToChat` instead of being swallowed: the send path then lets the outbox write its own
 * row, rather than telling it the row is already durable (review of #2843, M1) - UNLESS
 * {@link entryWritten} says the entry reached disk alone, in which case the queue already owns it.
 */
export class MessagePairWriteError extends Error {
  /** True when the storage reported the ENTRY written without its message ({@link OutboxEntryWrittenAloneError}). */
  readonly entryWritten: boolean;

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
    this.entryWritten = cause instanceof OutboxEntryWrittenAloneError;
  }
}
