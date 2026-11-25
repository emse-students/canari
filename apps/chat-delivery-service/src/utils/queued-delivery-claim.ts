import type { EntityManager } from 'typeorm';

/**
 * The statement that claims a queued row's delivery: flips `deliveryRan` (migration 058) for ONE
 * caller and takes the row lock until that caller's transaction ends.
 */
export const CLAIM_QUEUED_DELIVERY_SQL = `UPDATE queued_message SET "deliveryRan" = true WHERE id = $1 AND "deliveryRan" = false`;

/**
 * Claims the delivery of queued row `id` inside the caller's transaction `m`: true for exactly one
 * delivery of that row, which then publishes it BEFORE `m` commits; false when a delivery already
 * ran, or when the row is gone (acknowledged by its device, or swept).
 *
 * THE ROW LOCK IS THE PROOF THAT A DELIVERY IS RUNNING, never a clock. The UPDATE locks the row until
 * the claimant's transaction ends, so a second claim of the same row WAITS for it, then re-reads the
 * row: committed true - the first delivery published, this one publishes nothing; still false - the
 * first claimant's transaction rolled back (its publish threw, or its process died and PostgreSQL
 * ended its session), and this one delivers. Two deliveries of one row cannot overlap, and a dead one
 * leaves the row deliverable.
 *
 * `m` MUST be transactional: in autocommit the flag would be committed before the publish, and a
 * process dying between the two would leave a row nobody delivers live again.
 */
export async function claimQueuedDelivery(m: EntityManager, id: string): Promise<boolean> {
  // TypeORM answers an UPDATE as `[rows, rowCount]`: the count is what says this caller flipped it.
  const [, claimed] = (await m.query(CLAIM_QUEUED_DELIVERY_SQL, [id])) as [unknown[], number];
  return claimed > 0;
}
