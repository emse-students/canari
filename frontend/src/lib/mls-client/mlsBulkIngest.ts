import type { IMlsService } from './IMlsService';

/**
 * Runs `fn` inside an MLS bulk-ingest window so disk persistence is deferred and a single
 * encrypted checkpoint is flushed when the window closes.
 *
 * Windows nest via the persister's depth counter, so the expensive Argon2 flush coalesces to
 * the outermost close. {@link IMlsService.endBulkIngest} resolves only after that flush
 * completes, which makes it safe to record durable progress markers (e.g. a history replay's
 * stream cursor) strictly AFTER this call returns - never ahead of the persisted ratchet.
 *
 * The window is closed BY ITS HANDLE: a queue drain may open its own window while `fn` runs and
 * close it first, and a close that ended "the innermost" window ended the wrong one.
 *
 * Note: it intentionally does not enable UI bulk-buffering (that buffer is not depth-counted
 * and would clobber a concurrent queue-drain); only persistence deferral is engaged.
 */
export async function withMlsBulkIngest<T>(
  mlsService: Pick<IMlsService, 'beginBulkIngest' | 'endBulkIngest'>,
  fn: () => Promise<T>
): Promise<T> {
  const handle = mlsService.beginBulkIngest();
  try {
    return await fn();
  } finally {
    await mlsService.endBulkIngest(handle);
  }
}
