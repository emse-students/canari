/**
 * The typed codes of the refund routes (lot 4), equal to `libs/contracts/lydia-refusal-codes.json`'s
 * `refund` section - `refunds.service.spec.ts` asserts it, and so do core-service and the frontend.
 */

/** 409: the payment cannot be refunded from Canari; `reason` says why (`NotRefundableReason`). */
export const LYDIA_REFUND_NOT_REFUNDABLE = 'LYDIA_REFUND_NOT_REFUNDABLE';
/** 409: the refund would take the payment's refunds past the amount paid. */
export const LYDIA_REFUND_EXCEEDS_PAID = 'LYDIA_REFUND_EXCEEDS_PAID';
/** 409: a refund of this payment is still unconfirmed; a manager settles it first. */
export const LYDIA_REFUND_IN_FLIGHT = 'LYDIA_REFUND_IN_FLIGHT';
/** 400: the request is not one a refund can be made of (an amount, a reason, a key). */
export const LYDIA_REFUND_INVALID = 'LYDIA_REFUND_INVALID';
/** 409: a settlement asked of a refund that is no longer unconfirmed. */
export const LYDIA_REFUND_NOT_PENDING = 'LYDIA_REFUND_NOT_PENDING';

/** core-service's codes this service reads (the contract's `refund.core`), never its message. */
export const CORE_REFUND_CODES = {
  noKey: 'LYDIA_REFUND_NO_KEY',
  notRefundableAtLydia: 'LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE',
  notAllowed: 'LYDIA_REFUND_NOT_ALLOWED',
  rejected: 'LYDIA_REFUND_REJECTED',
  unconfirmed: 'LYDIA_REFUND_UNCONFIRMED',
} as const;

/** The bell row's type the payer gets once a refund is confirmed. */
export const LYDIA_REFUND_ISSUED_TYPE = 'lydia_refund_issued';

/**
 * Why a payment cannot be refunded from Canari:
 * - `not-online`: paid in cash, or before Lydia (nothing at Lydia to refund);
 * - `not-received`: not money kept (already refunded in full, cancelled, waiting for cash);
 * - `untraceable`: Canari never kept which Lydia transaction it was (a form answer paid before
 *   migration 120, a boutique purchase before migration 101);
 * - `other-business`: the payment went to a Lydia Business this association does not hold now.
 */
export type NotRefundableReason = 'not-online' | 'not-received' | 'untraceable' | 'other-business';

/**
 * What a TOTAL refund of the payment withdraws, so the confirmation names it:
 * - `membership`: a boutique membership - the tier it granted is revoked;
 * - `form`: a form answer - its seat is freed; `form-membership`: and the tier it granted revoked;
 * - `shop`: another boutique product - the purchase is marked refunded;
 * - `topup`: a Cercle top-up - the money only, the balance at the Cercle is NOT touched;
 * - `unidentified`: the product is gone, so what it was cannot be told - nothing is withdrawn.
 */
export type RefundWithdrawal =
  | 'membership'
  | 'form'
  | 'form-membership'
  | 'shop'
  | 'topup'
  | 'unidentified';

/**
 * What a confirmed TOTAL refund did, recorded on its row (`sideEffect`).
 */
export type RefundSideEffect =
  | 'cotisation-revoked'
  | 'cotisation-not-held'
  | 'seat-freed'
  | 'seat-freed-cotisation-revoked'
  | 'seat-freed-cotisation-not-held'
  | 'purchase-refunded'
  | 'topup-balance-unchanged'
  | 'not-applied-unidentified'
  | 'not-applied-already-withdrawn';
