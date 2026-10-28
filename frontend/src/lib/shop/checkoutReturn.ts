import type { ProductCheckoutStatus } from '$lib/associations/api';

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
): string {
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
