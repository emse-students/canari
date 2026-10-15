import { Raw, type EntityManager, type FindOptionsWhere } from 'typeorm';
import type { Submission } from './entities/submission.entity';

/**
 * HOW LONG AN ONLINE-PAYMENT `pending` SUBMISSION HOLDS ITS SEAT, from its own `paymentRequestedAt`
 * - the instant its CURRENT payment request was issued (migration 084). `createdAt` would be wrong
 * the moment `submit` reuses a live pending row for a new request: the hold must restart with it.
 *
 * The payment request's own lifetime is derived from it (`PAYMENT_REQUEST_LIFETIME_SECONDS`), so
 * the request stops being payable BEFORE the seat stops being held. Too short and a slow payer
 * cannot pay; too long and an abandoned checkout keeps a seat nobody will take. Before 2026-10-15
 * it was infinite: nothing released an online `pending` row at all.
 */
export const PENDING_PAYMENT_HOLD_SECONDS = 30 * 60;

/**
 * How long Lydia's request may be expired AFTER its deadline: its expiry runs on a sweep, measured
 * firing +79 s after a 60 s deadline and +61 s after a 120 s one (sandbox, 2026-10-15), plus the
 * callback's own latency. Two minutes covers both with room.
 */
export const PAYMENT_REQUEST_EXPIRY_MARGIN_SECONDS = 120;

/**
 * The lifetime `submit` asks the provider for (`expireAfterSeconds`, Lydia's `expire_time`, whole
 * seconds): the hold minus the sweep margin, 1680 s, so the request is dead by the time the seat is
 * released and a late payment stays the exception `markPaid` handles, not the ordinary case.
 */
export const PAYMENT_REQUEST_LIFETIME_SECONDS =
  PENDING_PAYMENT_HOLD_SECONDS - PAYMENT_REQUEST_EXPIRY_MARGIN_SECONDS;

/**
 * The `code` of the 409 a retry (or a cancel) gets while the request its answer is waiting on
 * cannot be shown dead or paid: issuing another would leave two payable requests for one answer.
 * The client words it through Paraglide (`paymentRefusal.ts`).
 */
export const PREVIOUS_PAYMENT_OPEN = 'PREVIOUS_PAYMENT_OPEN';

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
 * The statuses of an online answer whose request the payer's return may still find PAID at the
 * provider (`confirmPayment`): waiting, or released with no seat (`expired`, `cancelled`) while a
 * payment made at the end of the hold had its callback lost. Anything settled is already decided.
 */
export const CONFIRMABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'expired',
  'cancelled',
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
