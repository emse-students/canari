import { signLydiaParams } from './lydia-signature';

/**
 * LYDIA REFUNDS (enrolment chantier lot 4, docs/wiki/lydia-api.md "transaction/refund").
 *
 * The call is `POST /api/transaction/refund.json` with `vendor_token`, `order_ref` (the
 * transaction's identifier in Canari, the one `request/do` was sent with), `amount` and
 * `signature`. Measured on homologation 2026-10-31, on a throwaway Business:
 * - the signature is made with the BUSINESS private token, over `amount` and `order_ref`;
 * - the values are signed RAW: an `order_ref` carrying `:` signed raw passed the signature check
 *   (error 2, "no such transaction", on a made-up one), signed URL-encoded it answered `444`, as did
 *   the Provider private token and a deliberately wrong key (the control);
 * - with no signature Lydia answers error 1, "missing parameter".
 * Partial refunds are documented (the `amount` field, "amount to be refunded"); a refund of a real
 * payment was NOT measured: a fresh sandbox Business is not validated, so it cannot take a payment
 * (error 5 on `request/do`), and no validated sandbox Business was available.
 */

/** The `code` (409) when no Business private token is stored for the payment's Business: nothing is sent. */
export const LYDIA_REFUND_NO_KEY = 'LYDIA_REFUND_NO_KEY';
/** The `code` (409) of Lydia's error 2 on a refund: no such transaction, or one that cannot be refunded. */
export const LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE = 'LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE';
/** The `code` (409) of Lydia's errors 10 / 105: the Business may not refund (not authorised). */
export const LYDIA_REFUND_NOT_ALLOWED = 'LYDIA_REFUND_NOT_ALLOWED';
/** The `code` (409) of any other refusal Lydia ANSWERED: nothing was refunded, `providerCode` kept. */
export const LYDIA_REFUND_REJECTED = 'LYDIA_REFUND_REJECTED';
/**
 * The `code` (504) of a refund call with no usable answer (a timeout, a 5xx, a 4xx that does not say
 * refused): Lydia may have refunded. The caller keeps its refund `pending` and never retries it blind.
 */
export const LYDIA_REFUND_UNCONFIRMED = 'LYDIA_REFUND_UNCONFIRMED';

/**
 * Lydia's refund error codes and the typed code each one becomes. Every one of them is an ANSWER:
 * Lydia read the call and refunded nothing. `444` and `102`/`103`/`2701` reuse the codes the cashier
 * and request calls already answer (`LYDIA_SIGNATURE_REFUSED`, `LYDIA_BUSINESS_TOKEN_REJECTED`,
 * `LYDIA_BUSINESS_BLOCKED`), passed in by the caller so this file depends on no provider constant.
 */
export function lydiaRefundRefusalCode(
  providerCode: string,
  shared: { signatureRefused: string; businessTokenRejected: string; businessBlocked: string }
): string {
  switch (providerCode) {
    case '2':
      return LYDIA_REFUND_TRANSACTION_NOT_REFUNDABLE;
    case '10':
    case '105':
      return LYDIA_REFUND_NOT_ALLOWED;
    case '444':
      return shared.signatureRefused;
    case '102':
    case '103':
      return shared.businessTokenRejected;
    case '2701':
      return shared.businessBlocked;
    default:
      return LYDIA_REFUND_REJECTED;
  }
}

/** The fields `transaction/refund` signs, the amount written as `request/do` writes one (`"12.50"`). */
export function lydiaRefundSignedFields(orderRef: string, amount: string): Record<string, string> {
  return { amount, order_ref: orderRef };
}

/**
 * The `transaction/refund` signature: MD5 over the RAW `amount` and `order_ref` with the Business
 * private token (homologation 2026-10-31, see the top of this file) - `signLydiaParams`, NOT the
 * URL-encoded `signLydiaRequest` the cashier calls need.
 */
export function signLydiaRefund(orderRef: string, amount: string, businessKey: string): string {
  return signLydiaParams(lydiaRefundSignedFields(orderRef, amount), businessKey);
}
