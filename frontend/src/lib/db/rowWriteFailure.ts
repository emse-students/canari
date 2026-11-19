/**
 * WHETHER A FAILED ROW WRITE CAN EVER LAND - decided by the error's TYPE, never by its message
 * (rows before ratchet, review of #3851).
 *
 * A row shown and not stored is KEPT: its frame's ack is withheld and every checkpoint is refused
 * until a later hold stores it (`useMessaging`, `unstoredRowWrites`). That is right for a failure a
 * retry can pass - a full disk (`QuotaExceededError`), an aborted or inactive transaction, a store
 * closing under a reload - and wrong for a row the store refuses for WHAT IT IS: IndexedDB raises
 * `DataError` for a key it cannot take and `DataCloneError` for a value it cannot clone, both
 * SYNCHRONOUSLY from `add`/`put`, so the `DOMException` itself reaches the writer with its name. Such
 * a row fails the same way at every retry and after every reload (the frame is decrypted again and
 * produces the same row), so keeping it would stall the device for good: no checkpoint, so no
 * commit and no join, and its frame never acknowledged.
 *
 * ANYTHING ELSE IS TRANSIENT, deliberately: an error whose type says nothing (a string a transaction
 * rejected with, a native SQLite refusal) is kept and retried - withholding costs a re-listing and a
 * refused checkpoint, acking past a row a retry could have stored costs the message.
 * See docs/wiki/frontend/modules/chat.md#a-poison-row-is-dropped-not-kept-2026-11-19.
 */

/** What a failed row write is: a row the store will never take, or a failure a retry may pass. */
export type RowWriteFailureClass = 'poison' | 'transient';

/** The `DOMException` names a store raises for the row ITSELF - a key or a value it cannot take. */
const POISON_NAMES: ReadonlySet<string> = new Set(['DataError', 'DataCloneError']);

/**
 * Classifies a failed row write by the error's `DOMException` name. Only an object whose `name` is
 * one of {@link POISON_NAMES} is poison; a string, an untyped `Error` or any other name is transient.
 */
export function classifyRowWriteFailure(e: unknown): RowWriteFailureClass {
  if (typeof e !== 'object' || e === null) return 'transient';
  const name = (e as { name?: unknown }).name;
  return typeof name === 'string' && POISON_NAMES.has(name) ? 'poison' : 'transient';
}
