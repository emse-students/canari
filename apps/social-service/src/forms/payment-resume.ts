import { In, IsNull, MoreThan, Not, Raw, type FindOptionsWhere } from 'typeorm';
import type { Submission } from './entities/submission.entity';
import { PENDING_HOLD_CUTOFF_SQL } from './seat-hold';

/**
 * RESUMING A PAYMENT: a member whose online payment was cancelled, declined or expired pays the SAME
 * answer again, through a NEW Lydia request (owner decision of 2026-11-21, "launch now: payment
 * resume"; docs/wiki/frontend/modules/forms.md, "A released payment is resumed on the same answer").
 *
 * What may be resumed is decided from the ROW and nothing else - its status, its method, its amount
 * and its owner - so the page that offers the action (`GET forms/:id/check`, `resumable`) and the
 * route that performs it (`POST forms/submissions/:id/resume-payment`) read one rule.
 */

/**
 * The statuses of an online answer whose payment ended without money: cancelled (by the payer, a
 * verified callback, or a release of a request that was never issued) or expired (its hold passed).
 * A `pending` row whose hold has passed is one too - its request died with the hold (D1) and only
 * the five-minute expiry job has not said so yet - so it is resumable as well (`staleResumableWhere`).
 */
export const RESUMABLE_PAYMENT_STATUSES: readonly string[] = ['cancelled', 'expired'];

/**
 * The `code` of the 409 a resume gets while the answer's payment is IN PROGRESS: a `pending` row
 * still within its hold, or one a concurrent resume has just reopened. Durable state, never a clock
 * guess: the row is `pending` and the second click is refused, so one answer never waits on two
 * requests. The client words it through Paraglide (`form_payment_resume_in_progress`).
 */
export const PAYMENT_IN_PROGRESS = 'PAYMENT_IN_PROGRESS';

/**
 * The `code` of the 409 a resume gets on an answer that has nothing to resume: paid, free, refunded,
 * in cash (a manager's matter), free of charge, or of an anonymous form.
 */
export const PAYMENT_NOT_RESUMABLE = 'PAYMENT_NOT_RESUMABLE';

/**
 * The `code` of the 409 a resume gets when the stored answer no longer prices at what it was charged
 * (the form's prices or supplements changed since): a resume never sells at another price than a
 * fresh submit would, so the member fills the form again. An answer whose combination closed is the
 * submit's own `FORM_COMBINATION_UNAVAILABLE`, and the client treats both alike.
 */
export const PAYMENT_PRICE_CHANGED = 'PAYMENT_PRICE_CHANGED';

/** The typed refusals of a resume that come from the row alone. */
export type ResumeRowRefusal = typeof PAYMENT_IN_PROGRESS | typeof PAYMENT_NOT_RESUMABLE;

/**
 * WHO OR WHAT CANCELLED an online answer's payment (`submissions.paymentCancelledBy`, migration
 * 179), written with the move to `cancelled`:
 *
 * - `member`: the submitter cancelled their own pending payment (`cancelSubmission`);
 * - `manager`: a form manager cancelled it (or deleted the answer) - a decision, never offered back;
 * - `provider`: Lydia reported or read the request declined, cancelled or expired;
 * - `unissued`: the request was refused before Lydia created anything (`releaseUnissuedRow`);
 * - `issue-unknown`: the issuing call failed after it was SENT (a timeout, a 5xx, an answer with no
 *   URL), so a request may exist at Lydia that the row does not name - resuming would risk a second
 *   payable request for one answer, so it is not offered (the follow-up that settles it by its
 *   order_ref is in the backlog entry).
 *
 * NULL on a row cancelled before 179: its origin is unknown and it is treated as resumable.
 */
export type PaymentCancelOrigin = 'member' | 'manager' | 'provider' | 'unissued' | 'issue-unknown';

/** The cancel origins a resume never undoes (see {@link PaymentCancelOrigin}). */
export const UNRESUMABLE_CANCEL_ORIGINS: readonly PaymentCancelOrigin[] = [
  'manager',
  'issue-unknown',
];

/** What of a row the rule reads. */
export type ResumableRow = Pick<
  Submission,
  'paymentStatus' | 'paymentMethod' | 'totalPaid' | 'paymentCancelledBy'
>;

/**
 * Why this row cannot be resumed, judged on the row alone, or null when it may be.
 *
 * `holdLive` says whether a `pending` row still holds its seat (`livePendingWhere`, on the
 * database clock - read by the caller, under the row lock when it decides).
 */
export function resumeRowRefusal(row: ResumableRow, holdLive: boolean): ResumeRowRefusal | null {
  // Only an ONLINE answer: `cash` is the manager's to validate or cancel, a Stripe-era row has no
  // request Lydia can read, and a free answer owes nothing.
  if (row.paymentMethod !== null || !(row.totalPaid > 0)) return PAYMENT_NOT_RESUMABLE;
  if (row.paymentStatus === 'pending') return holdLive ? PAYMENT_IN_PROGRESS : null;
  if (
    row.paymentStatus === 'cancelled' &&
    row.paymentCancelledBy !== null &&
    UNRESUMABLE_CANCEL_ORIGINS.includes(row.paymentCancelledBy as PaymentCancelOrigin)
  ) {
    return PAYMENT_NOT_RESUMABLE;
  }
  return RESUMABLE_PAYMENT_STATUSES.includes(row.paymentStatus) ? null : PAYMENT_NOT_RESUMABLE;
}

/**
 * The caller's answers on a form that `resumeRowRefusal` admits, as a TypeORM `where` (an OR):
 * online, charged, and expired, cancelled by anything but a manager or an issue of unknown outcome,
 * or pending past its hold. What `GET forms/:id/check`
 * reads to offer "Reprendre le paiement".
 */
export function resumableWhere(formId: string, userId: string): FindOptionsWhere<Submission>[] {
  const base: FindOptionsWhere<Submission> = {
    formId,
    userId,
    paymentMethod: IsNull(),
    totalPaid: MoreThan(0),
  };
  return [
    { ...base, paymentStatus: 'expired' },
    // A cancel whose origin is unknown (before 179) or one a resume may undo; never a manager's.
    { ...base, paymentStatus: 'cancelled', paymentCancelledBy: IsNull() },
    {
      ...base,
      paymentStatus: 'cancelled',
      paymentCancelledBy: Not(In([...UNRESUMABLE_CANCEL_ORIGINS])),
    },
    {
      ...base,
      paymentStatus: 'pending',
      paymentRequestedAt: Raw((column) => `${column} <= ${PENDING_HOLD_CUTOFF_SQL}`),
    },
  ];
}

/** What `GET forms/:id/check` tells the page about the answer it may resume. */
export interface ResumableAnswer {
  submissionId: string;
  /** What the resumed request charges: the answer's own total, as stored at submit (cents). */
  amountCents: number;
}
