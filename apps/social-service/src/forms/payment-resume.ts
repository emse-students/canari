import { In, IsNull, MoreThan, Raw, type FindOptionsWhere } from 'typeorm';
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
 * WHO OR WHAT CANCELLED an online answer's payment (`submissions.paymentCancelOrigin`, migration
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
 * NULL on a row cancelled before 179, or by an older image during the rolling deploy: its origin is
 * unknown - it may be a manager's decision, or an issue that timed out with a request still payable
 * at Lydia and named nowhere - and nothing durable tells them apart, so it is NOT resumable (fail
 * closed: the member answers anew, as before this feature).
 */
export type PaymentCancelOrigin = 'member' | 'manager' | 'provider' | 'unissued' | 'issue-unknown';

/**
 * The ONLY cancel origins a resume may undo - an allowlist, so an unknown or new origin is never
 * resumed by default (see {@link PaymentCancelOrigin}): the payer's own cancel, Lydia's verdict, and a
 * request refused before anything existed. Never `manager`, `issue-unknown` or NULL.
 */
export const RESUMABLE_CANCEL_ORIGINS: readonly PaymentCancelOrigin[] = [
  'member',
  'provider',
  'unissued',
];

/** What of a row the rule reads. */
export type ResumableRow = Pick<
  Submission,
  'paymentStatus' | 'paymentMethod' | 'totalPaid' | 'paymentCancelOrigin'
>;

/**
 * Whether the request a row names, if any, can be SETTLED before a new one is issued
 * (`settleOpenRequest`): it is cancelled or read with the Business it was issued to
 * (`lydiaVendorToken`, migration 120), on a form that has an association. A row naming a request
 * without that Business (written before 120) can never be settled, so a resume of it would always be
 * refused - it is not offered, and the route refuses it as not resumable.
 */
export function oldRequestSettleable(
  row: Pick<Submission, 'paymentRequestId' | 'stripeSessionId' | 'lydiaVendorToken'>,
  formHasAssociation: boolean
): boolean {
  if (!row.paymentRequestId && !row.stripeSessionId) return true;
  return formHasAssociation && !!row.lydiaVendorToken;
}

/**
 * Why this row cannot be resumed, judged on the row alone, or null when it may be. Resumable: an
 * online, charged answer that is `expired` (its hold passed), `pending` past its hold (its request
 * died with D1, the five-minute expiry job has not said so yet), or `cancelled` by an allowed origin.
 *
 * `holdLive` says whether a `pending` row still holds its seat (`livePendingWhere`, on the
 * database clock - read by the caller, under the row lock when it decides); `settleable` is
 * {@link oldRequestSettleable}.
 */
export function resumeRowRefusal(
  row: ResumableRow,
  holdLive: boolean,
  settleable: boolean
): ResumeRowRefusal | null {
  // Only an ONLINE answer: `cash` is the manager's to validate or cancel, a Stripe-era row has no
  // request Lydia can read, and a free answer owes nothing.
  if (row.paymentMethod !== null || !(row.totalPaid > 0)) return PAYMENT_NOT_RESUMABLE;
  if (row.paymentStatus === 'pending' && holdLive) return PAYMENT_IN_PROGRESS;
  if (!settleable) return PAYMENT_NOT_RESUMABLE;
  if (row.paymentStatus === 'pending') return null;
  // Only the expiry job writes `expired`: its origin needs no record.
  if (row.paymentStatus === 'expired') return null;
  if (row.paymentStatus === 'cancelled') {
    return RESUMABLE_CANCEL_ORIGINS.includes(row.paymentCancelOrigin as PaymentCancelOrigin)
      ? null
      : PAYMENT_NOT_RESUMABLE;
  }
  return PAYMENT_NOT_RESUMABLE;
}

/**
 * The caller's answers on a form that `resumeRowRefusal` admits, as a TypeORM `where` (an OR):
 * online, charged, and expired, cancelled by an origin of {@link RESUMABLE_CANCEL_ORIGINS} (never
 * NULL), or pending past its hold. What `GET forms/:id/check` reads to offer "Reprendre le paiement";
 * the caller then applies {@link resumeRowRefusal} with {@link oldRequestSettleable}, which this
 * `where` cannot express (`lydiaVendorToken` is never selected by default).
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
    { ...base, paymentStatus: 'cancelled', paymentCancelOrigin: In([...RESUMABLE_CANCEL_ORIGINS]) },
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
