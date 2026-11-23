import type { Submission } from './entities/submission.entity';
import { RESUMABLE_CANCEL_ORIGINS, type PaymentCancelOrigin } from './payment-resume';

/**
 * A FAILED CARD PAYMENT IS SETTLED IN PERSON INSTEAD (owner decision of 2026-11-23): when the online
 * payment of an answer ("Paiement Canari", Lydia) fails, is cancelled or expires, the respondent is
 * offered "Réessayer" (the resume, `payment-resume.ts`) AND "Payer en direct": the SAME answer moves
 * to `pending_cash`, which the association validates by hand like any cash answer
 * (docs/wiki/frontend/modules/forms.md, "A failed card payment is switched to cash").
 *
 * What may be switched is decided from the ROW, so the page that offers it (`GET forms/:id/check`,
 * `cashSwitchable`; the guest receipt's `cashSwitchOffered`) and the routes that perform it read one
 * rule. Everything the form decides (cash accepted, a cash deadline for a guest, open, capacity, the
 * price) is the service's, judged with the same rules as a direct cash answer.
 */

/**
 * The `code` of the 409 a switch gets on an answer that has no failed online payment to move to
 * cash: paid, free, refunded, of nothing charged, cancelled by a manager (a decision), cancelled
 * with no origin recorded or after an issue whose outcome at Lydia is unknown (a request may be
 * payable that the row does not name), naming a request that cannot be settled, or of an anonymous
 * form (which takes no money, so it never has a card payment). Words: `form_payment_not_switchable`.
 */
export const PAYMENT_NOT_SWITCHABLE = 'PAYMENT_NOT_SWITCHABLE';

/**
 * The `code` of the 409 a switch gets on a form that does not take cash - or, for a GUEST, a form
 * with no cash deadline: a guest's cash answer must expire, as a direct one must
 * (`assertPublicConfigValid`). Words: `form_cash_not_offered`.
 */
export const FORM_CASH_NOT_OFFERED = 'FORM_CASH_NOT_OFFERED';

/** What of a row the rule reads. */
export type CashSwitchRow = Pick<
  Submission,
  'paymentStatus' | 'paymentMethod' | 'totalPaid' | 'paymentCancelOrigin'
>;

/**
 * Why this row cannot be switched to cash, judged on the row alone, or null when it may be.
 * Switchable: an ONLINE, charged answer that is
 *
 * - `pending` - WITHIN its hold too (unlike a resume): the payer may have left Lydia's page after a
 *   card failure that left the request open. Its request is settled at Lydia before anything moves
 *   (`settleOpenRequest`); one being issued right now refuses there (`PREVIOUS_PAYMENT_OPEN`);
 * - `expired`, or `pending` past its hold (its request died with D1);
 * - `cancelled` by an origin of {@link RESUMABLE_CANCEL_ORIGINS}: the payer's own cancel, Lydia's
 *   verdict, a request refused before it existed. The SAME allowlist as a resume, for the same
 *   reasons: `manager` is a decision, and `issue-unknown` or NULL may hide a payable request.
 *
 * `settleable` is `oldRequestSettleable`: a request the row names must be settleable at Lydia, or
 * the switch could never establish that it cannot still be paid.
 *
 * A row already `pending_cash` is not judged here: the service answers it as the switch already
 * made (idempotence from the row), before this rule.
 */
export function cashSwitchRowRefusal(
  row: CashSwitchRow,
  settleable: boolean
): typeof PAYMENT_NOT_SWITCHABLE | null {
  // Only an ONLINE answer that owes money: a cash row is the manager's, a free one owes nothing.
  if (row.paymentMethod !== null || !(row.totalPaid > 0)) return PAYMENT_NOT_SWITCHABLE;
  if (!settleable) return PAYMENT_NOT_SWITCHABLE;
  if (row.paymentStatus === 'pending' || row.paymentStatus === 'expired') return null;
  if (row.paymentStatus === 'cancelled') {
    return RESUMABLE_CANCEL_ORIGINS.includes(row.paymentCancelOrigin as PaymentCancelOrigin)
      ? null
      : PAYMENT_NOT_SWITCHABLE;
  }
  return PAYMENT_NOT_SWITCHABLE;
}

/** Who asks for the switch: the member who owns the answer, or the guest holding its receipt. */
export type CashSwitchCaller =
  | { kind: 'member'; submissionId: string; userId: string }
  | {
      kind: 'guest';
      /** The receipt the guest's return URL carries: the only key a guest has (`guest-receipt.ts`). */
      receipt: unknown;
      /** The visitor a waiting guest answer is counted against (PP5, `guest-visitor.ts`). */
      visitorAddress: string;
    };

/** What a switch answers. */
export interface CashSwitchOutcome {
  submissionId: string;
  /** The answer now waits for cash (`pending_cash`). Absent when `alreadyPaid`. */
  cashPayment?: true;
  /** Until when the answer holds its seat waiting for cash; null when the form sets no deadline. */
  cashExpiresAt?: Date | null;
  /** The online request was found PAID while it was being settled: recorded, nothing switched. */
  alreadyPaid?: true;
}
