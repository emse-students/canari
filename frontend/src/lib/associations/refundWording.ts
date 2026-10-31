import { m } from '$lib/paraglide/messages';
import type {
  AssociationRefund,
  RefundStanding,
  RefundWithdrawal,
  StatementLabels,
} from '$lib/associations/api';
import { formatAmount } from '$lib/forms/fillAnswers';
import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';

/**
 * The typed codes the refund routes answer (`libs/contracts/lydia-refusal-codes.json`, section
 * `refund`; `refundCodes.contract.test.ts` asserts them). The screen words each one, and never shows
 * the code itself.
 */
export const REFUND_SOCIAL_CODES = {
  notRefundable: 'LYDIA_REFUND_NOT_REFUNDABLE',
  exceedsPaid: 'LYDIA_REFUND_EXCEEDS_PAID',
  inFlight: 'LYDIA_REFUND_IN_FLIGHT',
  invalid: 'LYDIA_REFUND_INVALID',
  notPending: 'LYDIA_REFUND_NOT_PENDING',
} as const;

/** core-service's codes, relayed by social-service when Lydia answered (or nothing was sent). */
export const REFUND_CORE_CODES = {
  noKey: 'LYDIA_REFUND_NO_KEY',
  notRefundableAtLydia: 'LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE',
  notAllowed: 'LYDIA_REFUND_NOT_ALLOWED',
  rejected: 'LYDIA_REFUND_REJECTED',
  unconfirmed: 'LYDIA_REFUND_UNCONFIRMED',
} as const;

/** The code of a refund that could not be sent at all (social-service's 503). */
const NOT_SENT = 'PAYMENT_SERVICE_NOT_READY';

/**
 * What a refund attempt came to, as the dialog shows it:
 * - `refunded`: Lydia confirmed;
 * - `unconfirmed`: Lydia did not answer - the refund waits for a manager's check;
 * - `refused`: nothing was refunded, `message` says why;
 * - `unknown`: no answer reached this screen at all - the list is re-read before anything else.
 */
export type RefundAttempt =
  | { kind: 'refunded' }
  | { kind: 'unconfirmed' }
  | { kind: 'refused'; message: string }
  | { kind: 'unknown' };

/**
 * Classifies a refund call's failure by its STATUS and typed code, never its message: the 504
 * `LYDIA_REFUND_UNCONFIRMED` is a refund that may have gone through; a typed refusal is worded; no
 * HTTP answer at all is `unknown`, because the request may have reached the server.
 */
export function refundAttemptOf(err: unknown): RefundAttempt {
  const status = refusalStatus(err);
  const code = refusalCode(err);
  if (code === REFUND_CORE_CODES.unconfirmed) return { kind: 'unconfirmed' };
  if (status === null) return { kind: 'unknown' };
  const message = refundRefusalMessage(code);
  return message ? { kind: 'refused', message } : { kind: 'unknown' };
}

/** The sentence for a typed refund refusal; null for a code this screen does not know. */
export function refundRefusalMessage(code: string | null): string | null {
  switch (code) {
    case REFUND_SOCIAL_CODES.notRefundable:
      return m.asso_refund_refused_not_refundable();
    case REFUND_SOCIAL_CODES.exceedsPaid:
      return m.asso_refund_refused_exceeds();
    case REFUND_SOCIAL_CODES.inFlight:
      return m.asso_refund_refused_in_flight();
    case REFUND_SOCIAL_CODES.invalid:
      return m.asso_refund_refused_invalid();
    case REFUND_SOCIAL_CODES.notPending:
      return m.asso_refund_refused_already_checked();
    case REFUND_CORE_CODES.notRefundableAtLydia:
      return m.asso_refund_refused_already_at_lydia();
    case REFUND_CORE_CODES.notAllowed:
      return m.asso_refund_refused_not_allowed();
    case REFUND_CORE_CODES.noKey:
    case NOT_SENT:
      return m.asso_refund_refused_not_sent();
    case REFUND_CORE_CODES.rejected:
      return m.asso_refund_refused_by_lydia();
    default:
      // Lydia's shared refusals (a refused signature, a rejected or blocked Business) arrive with
      // their own core code: for the person refunding they all mean "Lydia said no".
      return code?.startsWith('LYDIA_') ? m.asso_refund_refused_by_lydia() : null;
  }
}

/**
 * The sentence naming what a TOTAL refund withdraws, shown before it is confirmed. A partial refund
 * withdraws nothing, and says so.
 */
export function refundEffectMessage(
  kind: 'total' | 'partial',
  withdrawal: RefundWithdrawal | null,
  buyer: string
): string {
  if (kind === 'partial') return m.asso_refund_effect_partial({ buyer });
  switch (withdrawal) {
    case 'membership':
      return m.asso_refund_effect_membership({ buyer });
    case 'form':
      return m.asso_refund_effect_form({ buyer });
    case 'form-membership':
      return m.asso_refund_effect_form_membership({ buyer });
    case 'topup':
      return m.asso_refund_effect_topup({ buyer });
    case 'unidentified':
      return m.asso_refund_effect_unidentified();
    case 'shop':
    default:
      return m.asso_refund_effect_shop();
  }
}

/**
 * The short state a payment's row shows: refunded (in full or in part), or a refund Lydia has not
 * confirmed. Null when nothing was refunded and nothing waits.
 */
export function refundStateLabel(standing: RefundStanding | undefined): string | null {
  if (!standing) return null;
  if (standing.unconfirmedRefundId) return m.asso_refund_state_unconfirmed();
  if (standing.refundedCents <= 0) return null;
  return standing.refundedCents >= standing.paidCents
    ? m.asso_refund_state_refunded()
    : m.asso_refund_state_partly({ amount: formatAmount(standing.refundedCents) });
}

/**
 * Why a payment shows no "Refund" button, when the reason is worth a sentence: a payment Canari
 * cannot trace, or one received on another Lydia account. Cash, unpaid and already-refunded rows
 * just show no button.
 */
export function notRefundableHint(standing: RefundStanding | undefined): string | null {
  if (standing?.reason === 'untraceable') return m.asso_refund_untraceable();
  if (standing?.reason === 'other-business') return m.asso_refund_other_business();
  return null;
}

/** The refund still waiting for a manager's check on this payment, if any. */
export function unconfirmedRefund(
  standing: RefundStanding | undefined,
  refunds: AssociationRefund[]
): AssociationRefund | null {
  const id = standing?.unconfirmedRefundId;
  return id ? (refunds.find((r) => r.id === id) ?? null) : null;
}

/**
 * Euros typed in the amount field as whole cents, or null when it is not a positive amount with at
 * most two decimals. Accepts a comma as the decimal separator.
 */
export function eurosToCents(typed: string | number): number | null {
  const text = String(typed).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return cents > 0 ? cents : null;
}

/** The statement's words, in this client's language (the server has none of its own). */
export function statementLabels(): StatementLabels {
  return {
    date: m.asso_statement_col_date(),
    operation: m.asso_statement_col_operation(),
    item: m.asso_statement_col_item(),
    method: m.asso_statement_col_method(),
    amount: m.asso_statement_col_amount(),
    reason: m.asso_statement_col_reason(),
    payment: m.asso_statement_payment(),
    refundTotal: m.asso_statement_refund_total(),
    refundPartial: m.asso_statement_refund_partial(),
    cash: m.asso_statement_cash(),
    online: m.asso_statement_online(),
    totalReceived: m.asso_statement_total_received(),
    totalRefunded: m.asso_statement_total_refunded(),
    balance: m.asso_statement_balance(),
  };
}
