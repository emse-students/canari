/**
 * WHETHER A FAILED ROW WRITE CAN EVER LAND - decided by a TYPE raised at the throw, never by a
 * message, and never by a name read off whatever reached the writer (rows before ratchet, reviews of
 * #3851).
 *
 * A row shown and not stored is KEPT: its frame's ack is withheld and every checkpoint is refused
 * until a later hold stores it (`useMessaging`, `unstoredRowWrites`). That is right for a failure a
 * retry can pass - a full disk (`QuotaExceededError`), an aborted or inactive transaction, a store
 * closing under a reload, a device key not loaded yet - and wrong for a row the store refuses for
 * WHAT IT IS: IndexedDB raises `DataError` for a key it cannot take and `DataCloneError` for a value
 * it cannot clone, SYNCHRONOUSLY from the `add`/`put` of that row. Such a row fails the same way at
 * every retry and after every reload (the frame is decrypted again and produces the same row), so
 * keeping it would stall the device for good: no checkpoint, so no commit and no join.
 *
 * CLASSIFIED AT THE THROW: the store wraps the refusal of ONE row's request into a
 * {@link RowRefusedError} (`IndexedDbStorage.saveMessagesIfAbsent`, the message merge). A `DataError`
 * from anywhere else is NOT that - `crypto.subtle.importKey` raises one for an empty device key, which
 * sign-in paths hand the store on purpose (second review of #3851): read by name, it would have
 * dropped every row of the page as poison and acknowledged their frames. So only the type decides.
 *
 * ANYTHING ELSE IS TRANSIENT, deliberately: withholding costs a re-listing and a refused checkpoint,
 * acking past a row a retry could have stored costs the message.
 * See docs/wiki/frontend/modules/chat.md#a-poison-row-is-dropped-not-kept-2026-11-19.
 */

/** What a failed row write is: a row the store will never take, or a failure a retry may pass. */
export type RowWriteFailureClass = 'poison' | 'transient';

/** The `DOMException` names a store raises for the row ITSELF - a key or a value it cannot take. */
const POISON_NAMES: ReadonlySet<string> = new Set(['DataError', 'DataCloneError']);

/**
 * The store refused ONE message row's request (`add`/`put` threw synchronously): raised by the store
 * at that request, carrying the row and the refusal's `DOMException` name - the only evidence
 * {@link classifyRowWriteFailure} reads.
 */
export class RowRefusedError extends Error {
  /** The refusal's `DOMException` name (`DataError`, `DataCloneError`, ...), or `unknown`. */
  readonly domName: string;
  constructor(
    readonly rowId: string,
    cause: unknown
  ) {
    const name = (cause as { name?: unknown } | null)?.name;
    super(`the store refused the row ${String(rowId).slice(0, 8)}: ${String(cause)}`, { cause });
    this.name = 'RowRefusedError';
    this.domName = typeof name === 'string' ? name : 'unknown';
  }
}

/**
 * Classifies a failed row write: POISON only for a {@link RowRefusedError} whose refusal is one of
 * {@link POISON_NAMES}; everything else - a bare `DOMException` of any name included - is transient.
 */
export function classifyRowWriteFailure(e: unknown): RowWriteFailureClass {
  return e instanceof RowRefusedError && POISON_NAMES.has(e.domName) ? 'poison' : 'transient';
}
