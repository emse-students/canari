/**
 * HOW A PAID FORM IS PAID, AND WHEN IT MAY BE PUBLISHED (owner, 2026-11-08).
 *
 * A paid form takes ONLINE payment (Lydia, "Paiement Canari") and/or CASH. Each is the editor's
 * choice: `allowOnlinePayment` (migration 145, true for every form before it - online was the only
 * way, and not a choice) and `allowCashPayment`.
 *
 * - A paid form is always SAVED, whatever the association's readiness: a draft is built before Lydia.
 * - It is PUBLISHED when the respondents have a way to pay NOW: cash is accepted, or online is
 *   accepted and the association can collect online. Cash needs no account, so it alone suffices.
 * - Once published, online is OFFERED to a respondent only while it is accepted AND the association
 *   can collect (`paymentsPaused` is the opposite, served on every read): while it cannot, a form
 *   that takes cash is answered in cash, and online comes back by itself when the association
 *   becomes ready. An online attempt meanwhile is refused by the existing readiness refusal.
 */

/** The 409 refusing to publish a paid, online-only form whose association cannot collect yet. */
export const FORM_PAYMENTS_NOT_READY = 'FORM_PAYMENTS_NOT_READY';

/** The 400 refusing to publish a paid form that accepts neither online nor cash. */
export const FORM_NO_PAYMENT_METHOD = 'FORM_NO_PAYMENT_METHOD';

/** The 409 refusing an ONLINE payment on a form whose editor took online payment off. */
export const FORM_ONLINE_PAYMENT_NOT_OFFERED = 'FORM_ONLINE_PAYMENT_NOT_OFFERED';

/** The two payment switches of a form, as stored or as an edit will save them. */
export interface PaymentOfferState {
  allowCashPayment?: boolean | null;
  allowOnlinePayment?: boolean | null;
}

/** Whether the editor accepts online payment: absent is a form or a client before the choice. */
export function acceptsOnline(form: PaymentOfferState): boolean {
  return form.allowOnlinePayment !== false;
}

/** Whether the editor accepts cash. */
export function acceptsCash(form: PaymentOfferState): boolean {
  return form.allowCashPayment === true;
}

/**
 * Why a PAID form may not be published now, as its typed code, or null when it may. `onlineReady`
 * is asked lazily, and only when cash does not already answer the question.
 */
export async function publishPaymentRefusal(
  form: PaymentOfferState,
  onlineReady: () => Promise<boolean>
): Promise<string | null> {
  if (acceptsCash(form)) return null;
  if (!acceptsOnline(form)) return FORM_NO_PAYMENT_METHOD;
  return (await onlineReady()) ? null : FORM_PAYMENTS_NOT_READY;
}

/**
 * Whether a respondent of a PAID form is offered online payment now: accepted by the editor and the
 * association can collect. Its negation is the `paymentsPaused` every read serves.
 */
export async function onlineOffered(
  form: PaymentOfferState,
  collectsNow: () => Promise<boolean>
): Promise<boolean> {
  return acceptsOnline(form) && (await collectsNow());
}
