import { Raw, type EntityManager, type FindOptionsWhere } from 'typeorm';
import type { Submission } from './entities/submission.entity';

/**
 * HOW LONG AN ONLINE-PAYMENT `pending` SUBMISSION HOLDS ITS SEAT, from its own `paymentRequestedAt`
 * - the instant its CURRENT payment request was issued (migration 084). `createdAt` would be wrong
 * the moment `submit` reuses a live pending row for a new request: the hold must restart with it.
 *
 * UNMEASURED: 30 minutes is a guess at Lydia's payment window, not a reading of it (the window is
 * one of the Livrable A questions, [backlog WP-LYDIA-1]). Too short and a slow payer lands over
 * capacity (`paid_over_capacity`, which the organiser refunds by hand); too long and an abandoned
 * checkout keeps a seat nobody will take. Before 2026-10-15 it was infinite: nothing released an
 * online `pending` row at all.
 */
export const PENDING_PAYMENT_HOLD_SECONDS = 30 * 60;

/**
 * The instant before which a `pending` row no longer holds a seat, as SQL on the DATABASE clock.
 *
 * The database clock, not the service's: `paymentRequestedAt` is written by the database's own `now()` into
 * a `timestamp` column, so comparing it with `now()` reads both sides through the same session time
 * zone, whatever zone the Node process runs in. The constant is interpolated, never a parameter, so
 * this fragment is the same text in a `find` and in the expiry `UPDATE` - ONE definition of
 * "still holding", whose two halves are `>` and `<=` of it.
 */
export const PENDING_HOLD_CUTOFF_SQL = `now() - make_interval(secs => ${PENDING_PAYMENT_HOLD_SECONDS})`;

/** The statuses whose money has already landed: a second `markPaid` on them is a replay. */
export const SETTLED_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'paid',
  'paid_over_capacity',
]);

/**
 * The submissions that hold a seat on a form, as a TypeORM `where` (an OR of four rows).
 *
 * A `pending` row holds one only while it is younger than the hold, and that is decided HERE, from
 * the row, so a count is right whether or not the expiry job has run. `extra` narrows every branch
 * the same way (one submitter, one submission id).
 */
export function seatHoldingWhere(
  formId: string,
  extra: FindOptionsWhere<Submission> = {}
): FindOptionsWhere<Submission>[] {
  return [
    { ...extra, formId, paymentStatus: 'paid' },
    { ...extra, formId, paymentStatus: 'free' },
    livePendingWhere(formId, extra),
    { ...extra, formId, paymentStatus: 'pending_cash' },
  ];
}

/** An online `pending` submission still younger than the hold: the one branch with a clock in it. */
export function livePendingWhere(
  formId: string,
  extra: FindOptionsWhere<Submission> = {}
): FindOptionsWhere<Submission> {
  return {
    ...extra,
    formId,
    paymentStatus: 'pending',
    paymentRequestedAt: Raw((column) => `${column} > ${PENDING_HOLD_CUTOFF_SQL}`),
  };
}

/**
 * Takes the form's row lock, which is what serialises every decision about its seats.
 *
 * A count followed by a write is a race unless something orders the writers: two submits, or two
 * late payments, could both read "one seat left" and both take it. Every path that counts seats and
 * then takes one (`submit`, `markPaid`) calls this FIRST in its transaction, so the form row is the
 * one lock they queue on, always taken before any submission row (one order, no deadlock). The
 * transaction must be READ COMMITTED: the count that follows has to see what the previous holder
 * committed, and a REPEATABLE READ snapshot would be taken before the wait.
 */
export async function lockFormSeats(manager: EntityManager, formId: string): Promise<void> {
  await manager.query('SELECT 1 FROM forms WHERE id = $1 FOR UPDATE', [formId]);
}

/**
 * Puts the rows the organiser must act on first: a payment that landed over capacity is owed a
 * refund, and at the bottom of a long list it would be found by nobody. Stable, so the order the
 * caller asked for holds inside each half.
 */
export function overCapacityFirst<T extends { paymentStatus: string }>(rows: T[]): T[] {
  return [
    ...rows.filter((row) => row.paymentStatus === 'paid_over_capacity'),
    ...rows.filter((row) => row.paymentStatus !== 'paid_over_capacity'),
  ];
}
