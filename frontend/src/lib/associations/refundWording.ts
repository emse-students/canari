import { m } from '$lib/paraglide/messages';
import type {
  AssociationRefund,
  AssociationStatement,
  RefundStanding,
  RefundWithdrawal,
  StatementLine,
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
 * - `in-progress`: the same refund is still being asked of Lydia (a resent request);
 * - `unconfirmed`: Lydia did not answer - the refund waits for a manager's check;
 * - `unrecorded`: Lydia confirmed, Canari failed to save it - a manager saves it from the list;
 * - `refused`: nothing was refunded, `message` says why;
 * - `unknown`: no answer reached this screen at all - the list is re-read before anything else.
 */
export type RefundAttempt =
  | { kind: 'refunded' }
  | { kind: 'in-progress' }
  | { kind: 'unconfirmed' }
  | { kind: 'unrecorded' }
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

/**
 * What an ANSWERED refund came to, read from its `state` - never from the HTTP status: a resent
 * request answers 200 with the first refund, refused or unconfirmed as it may be.
 */
export function refundAttemptOfView(
  refund: Pick<AssociationRefund, 'state' | 'refusal'>
): RefundAttempt {
  switch (refund.state) {
    case 'refunded':
      return { kind: 'refunded' };
    case 'in-progress':
      return { kind: 'in-progress' };
    case 'unconfirmed':
      return { kind: 'unconfirmed' };
    case 'unrecorded':
      return { kind: 'unrecorded' };
    case 'refused':
      return {
        kind: 'refused',
        message: refundRefusalMessage(refund.refusal) ?? m.asso_refund_refused_by_lydia(),
      };
    default:
      return { kind: 'unknown' };
  }
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

/** The short words of a refund not settled yet, by where it stands. */
const OPEN_REFUND_LABEL: Record<NonNullable<RefundStanding['openRefund']>['state'], () => string> =
  {
    'in-progress': () => m.asso_refund_state_in_progress(),
    unconfirmed: () => m.asso_refund_state_unconfirmed(),
    unrecorded: () => m.asso_refund_state_unrecorded(),
  };

/**
 * The short state a payment's row shows: a refund not settled yet (in progress, not confirmed by
 * Lydia, or confirmed and not saved), else refunded in full or in part. Null when nothing was
 * refunded and nothing waits.
 */
export function refundStateLabel(standing: RefundStanding | undefined): string | null {
  if (!standing) return null;
  if (standing.openRefund) return OPEN_REFUND_LABEL[standing.openRefund.state]();
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

/**
 * The refund on this payment waiting for a manager - to CHECK against Lydia (`unconfirmed`) or to
 * SAVE (`unrecorded`) - with what is asked of them; null when none. A refund still in progress asks
 * nothing: its result is coming.
 */
export function refundAwaitingManager(
  standing: RefundStanding | undefined,
  refunds: AssociationRefund[]
): { refund: AssociationRefund; action: 'check' | 'record' } | null {
  const open = standing?.openRefund;
  if (!open || open.state === 'in-progress') return null;
  const refund = refunds.find((r) => r.id === open.id);
  if (!refund) return null;
  return { refund, action: open.state === 'unrecorded' ? 'record' : 'check' };
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

/** The byte-order mark a spreadsheet needs to read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** Cents as a decimal with a comma (`12,50`, `-3,00`): what a spreadsheet in French reads as a number. */
function euros(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * One CSV cell: quoted when it carries `;`, a quote or a line break. A TEXT cell starting with a
 * character a spreadsheet reads as a formula (`= + - @`, tab, carriage return) is prefixed with `'`
 * - a product name or a typed reason is data, never a formula. Amounts (`euros`) are never
 * neutralised: a refund is a negative number.
 */
export function csvCell(value: string): string {
  const numeric = /^-?\d+,\d{2}$/.test(value);
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The operation cell of a statement line, in this client's words. */
function operationLabel(operation: StatementLine['operation']): string {
  if (operation === 'refund-total') return m.asso_statement_refund_total();
  if (operation === 'refund-partial') return m.asso_statement_refund_partial();
  return m.asso_statement_payment();
}

/**
 * The association's statement as a CSV file's text (`;`, UTF-8 with a BOM, CRLF), every header and
 * word in this client's language - the server sends data only. Payments and refunds, then the
 * three totals.
 */
export function statementCsv(statement: AssociationStatement): string {
  const rows: string[][] = [
    [
      m.asso_statement_col_date(),
      m.asso_statement_col_operation(),
      m.asso_statement_col_item(),
      m.asso_statement_col_method(),
      m.asso_statement_col_amount(),
      m.asso_statement_col_reason(),
    ],
    ...statement.lines.map((line) => [
      line.date,
      operationLabel(line.operation),
      line.item,
      line.method === 'cash' ? m.asso_statement_cash() : m.asso_statement_online(),
      euros(line.amountCents),
      line.reason ?? '',
    ]),
    [],
    ['', m.asso_statement_total_received(), '', '', euros(statement.receivedCents), ''],
    ['', m.asso_statement_total_refunded(), '', '', euros(-statement.refundedCents), ''],
    [
      '',
      m.asso_statement_balance(),
      '',
      '',
      euros(statement.receivedCents - statement.refundedCents),
      '',
    ],
  ];
  return BOM + rows.map((cells) => cells.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
