import type { EntityManager } from 'typeorm';

/**
 * Reads a queued row's `deliveryRan` (migration 058) under its row lock: waits for a delivery that
 * holds it, then reads what that delivery committed - or no row, when it is gone.
 */
export const LOCK_QUEUED_DELIVERY_SQL = `SELECT "deliveryRan" FROM queued_message WHERE id = $1 FOR UPDATE`;

/** Records, under the lock taken by {@link LOCK_QUEUED_DELIVERY_SQL}, that this delivery runs. */
export const MARK_QUEUED_DELIVERY_SQL = `UPDATE queued_message SET "deliveryRan" = true WHERE id = $1`;

/**
 * What {@link claimQueuedDelivery} found: this caller delivers (`claimed`), a delivery of the row
 * already ran and the row is still queued (`already_ran`), or the row is gone - acknowledged by its
 * device, or swept (`gone`). Two different reasons to publish nothing, and they want different
 * follow-ups: a row still queued may still owe its device a push, a gone row owes nothing.
 */
export type QueuedDeliveryClaim = 'claimed' | 'already_ran' | 'gone';

/**
 * Claims the delivery of queued row `id` inside the caller's transaction `m`: `claimed` for exactly
 * one delivery of that row, which then publishes it BEFORE `m` commits.
 *
 * THE ROW LOCK IS THE PROOF THAT A DELIVERY IS RUNNING, never a clock. `FOR UPDATE` holds the row
 * until the claimant's transaction ends, so a second claim of the same row WAITS for it, then reads
 * the committed row: `deliveryRan` true - the first delivery published, this one publishes nothing;
 * still false - the first claimant's transaction rolled back (its publish threw, or its process died
 * and PostgreSQL ended its session), and this one delivers. Two deliveries of one row cannot overlap,
 * and a dead one leaves the row deliverable.
 *
 * THE RESIDUAL WINDOW, named because it is not closed: a publish that SUCCEEDED and a COMMIT that then
 * failed (or a process that died between the two) leaves `deliveryRan` false, so the next re-send of
 * that row publishes it once more. The server cannot tell "published, not recorded" from "never
 * published" without a write that would itself have the same window; the receiving client drops the
 * second copy by its queued id (`BaseMlsService`, acknowledged and not decrypted again), so it costs a
 * frame, never a message.
 *
 * `m` MUST be transactional: in autocommit the flag would be committed before the publish, and a
 * process dying between the two would leave a row nobody delivers live again.
 */
export async function claimQueuedDelivery(
  m: EntityManager,
  id: string
): Promise<QueuedDeliveryClaim> {
  const [row] = (await m.query(LOCK_QUEUED_DELIVERY_SQL, [id])) as { deliveryRan: boolean }[];
  if (!row) return 'gone';
  if (row.deliveryRan) return 'already_ran';
  await m.query(MARK_QUEUED_DELIVERY_SQL, [id]);
  return 'claimed';
}
