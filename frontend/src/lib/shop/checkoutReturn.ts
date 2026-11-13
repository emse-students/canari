import type { AppPath } from '$lib/utils/internalPath';
import {
  confirmProductCheckout,
  type AssociationProduct,
  type ProductCheckoutStatus,
} from '$lib/associations/api';
import { createOnceReader, readUnlessThrottled, type OnceReader } from '$lib/forms/checkoutReturn';
import { refusalStatus } from '$lib/utils/apiRefusal';
import { checkoutDeepLink, formPaymentReturnDeepLink } from '$lib/utils/checkoutCallbacks';
import { paymentReturnSubmissionId } from '$lib/forms/checkoutReturn';
import { m } from '$lib/paraglide/messages';

/**
 * What the shop page says once a payer comes back from Lydia for one checkout attempt. `checking`
 * while the first read is out, `waiting` while the attempt is still open after the last read,
 * `unknown` when the attempt is not found (or not the reader's); the rest map a final status.
 */
export type CheckoutReturnView =
  | 'checking'
  | 'paid'
  | 'waiting'
  | 'declined'
  | 'notCompleted'
  | 'unknown';

/**
 * The view of a status read from the server. `open` can still change (the payment may be
 * confirmed a moment after the redirect), so it is `waiting` and the page keeps asking; every other
 * status is final. `expired` and `cancelled` read the same to the payer: nothing was charged.
 */
export function checkoutReturnView(status: ProductCheckoutStatus): CheckoutReturnView {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'open':
      return 'waiting';
    case 'declined':
      return 'declined';
    case 'expired':
    case 'cancelled':
      return 'notCompleted';
  }
}

/**
 * What a paid return says. The confirm answer carries only the attempt's STATUS - no amount and no
 * Cercle delivery state - so a top-up says the payment was received and the credit follows, never
 * that it already landed. The shop page's banner and the purchase button's own read both word it.
 */
export function checkoutReturnText(
  view: CheckoutReturnView,
  productType: AssociationProduct['type'] | null
): string {
  switch (view) {
    case 'checking':
      return m.shop_return_checking();
    case 'paid':
      if (productType === 'balance_topup') return m.shop_return_topup_paid();
      if (productType === 'membership') return m.shop_return_membership_paid();
      return m.shop_return_paid();
    case 'waiting':
      return m.shop_return_waiting();
    case 'declined':
      return m.shop_return_declined();
    case 'notCompleted':
      return m.shop_return_not_completed();
    case 'unknown':
      return m.shop_return_unknown();
  }
}

/**
 * The reads of ONE boutique checkout the payer was handed to Lydia for (the purchase button keeps
 * one per attempt): each asks the server about the attempt's own request, once, and ends on the
 * view the shop page words. A throttled read stays `waiting`; a 404 is `unknown`; any other failure
 * is thrown - a failed read decides nothing, the next return asks again.
 */
export function createShopCheckoutReader(target: {
  associationId: string;
  productId: string;
  checkoutId: string;
}): OnceReader<CheckoutReturnView> {
  return createOnceReader(() =>
    readUnlessThrottled<CheckoutReturnView>(async () => {
      try {
        const answer = await confirmProductCheckout(
          target.associationId,
          target.productId,
          target.checkoutId
        );
        return checkoutReturnView(answer.status);
      } catch (err) {
        // An attempt that is not the reader's, or unknown: an ANSWER, said as such.
        if (refusalStatus(err) === 404) return 'unknown';
        throw err;
      }
    }, 'waiting')
  );
}

/**
 * The attempt a return URL names, or null when it names none: the three ids the server put there
 * (`withCheckoutReturnKey`), all required, since the confirm route is addressed by all three.
 */
export function checkoutReturnTarget(
  params: Pick<URLSearchParams, 'get'>
): { associationId: string; productId: string; checkoutId: string } | null {
  const checkoutId = params.get('checkout_id');
  const associationId = params.get('association_id');
  const productId = params.get('productId');
  if (!checkoutId || !associationId || !productId) return null;
  return { associationId, productId, checkoutId };
}

/**
 * The in-app shop path a checkout deep link (`fr.emse.canari://payment/success|cancel?...`) opens:
 * its marker, plus the attempt it names when it names one - which is what lets the page ask about
 * THAT attempt. Only the known parameters are carried over, never the whole query.
 */
export function shopReturnPath(
  marker: 'purchase_success' | 'purchase_cancel',
  params: URLSearchParams
): AppPath {
  const q = new URLSearchParams({ [marker]: '1' });
  const productId = params.get('productId') ?? params.get('product_id');
  if (productId) q.set('productId', productId);
  for (const name of ['checkout_id', 'association_id'] as const) {
    const value = params.get(name);
    if (value) q.set(name, value);
  }
  return `/shop?${q}`;
}

/** The query parameters a checkout return carries, consumed once on arrival. */
export const CHECKOUT_RETURN_PARAMS = [
  'purchase_success',
  'purchase_cancel',
  'productId',
  'checkout_id',
  'association_id',
] as const;

/**
 * The app's own link to a shop purchase's return (`fr.emse.canari://payment/success?purchase_success=1&...`),
 * for the page in a BROWSER offering "Ouvrir Canari": a tap is a gesture, which a redirect is not.
 * Only the attempt's own parameters are carried (`shopReturnPath` filters them).
 */
export function shopPaymentReturnDeepLink(params: URLSearchParams): string {
  return checkoutDeepLink('success', shopReturnPath('purchase_success', params).split('?')[1]);
}

/**
 * The app's link to the payment a login's `returnTo` is the return of - a paid form
 * (`/forms/success?submission_id=...`) or a shop purchase (`/shop?purchase_success=1&...` naming its
 * attempt) - or null. The browser a payer was left in has no session: the page says where the
 * payment went and offers the app.
 */
export function paymentReturnAppLink(returnTo: string): string | null {
  const submissionId = paymentReturnSubmissionId(returnTo);
  if (submissionId) return formPaymentReturnDeepLink(submissionId);
  try {
    const url = new URL(returnTo, 'https://canari.invalid');
    if (url.pathname.replace(/\/$/, '') !== '/shop' || !url.searchParams.has('purchase_success'))
      return null;
    return checkoutReturnTarget(url.searchParams)
      ? shopPaymentReturnDeepLink(url.searchParams)
      : null;
  } catch {
    return null;
  }
}
