import { productOrderRef, withCheckoutReturnKey } from './product-checkout';

describe('product checkout attempt helpers', () => {
  const attempt = {
    checkoutId: '33333333-3333-4333-8333-333333333333',
    associationId: '22222222-2222-4222-8222-222222222222',
    productId: '11111111-1111-4111-8111-111111111111',
  };

  it('writes one order_ref per attempt, in the grammar core-service parses, naming no buyer', () => {
    const ref = productOrderRef(attempt.productId, attempt.checkoutId);
    expect(ref).toBe(`product:${attempt.productId}:${attempt.checkoutId}`);
    // Inside the 109 characters Lydia was measured to accept (the old two-part form, hex user id).
    expect(ref.length).toBe(81);
    expect(productOrderRef(attempt.productId, 'other')).not.toBe(ref);
  });

  it('names the attempt on the web return, keeping the markers already there', () => {
    const url = withCheckoutReturnKey('https://canari.emse.fr/shop?purchase_success=1', attempt);
    const u = new URL(url);
    expect(u.pathname).toBe('/shop');
    expect(u.searchParams.get('purchase_success')).toBe('1');
    expect(u.searchParams.get('checkout_id')).toBe(attempt.checkoutId);
    expect(u.searchParams.get('association_id')).toBe(attempt.associationId);
    expect(u.searchParams.get('productId')).toBe(attempt.productId);
  });

  it('names the attempt on the app deep link too', () => {
    const url = withCheckoutReturnKey('fr.emse.canari://payment/cancel?purchase_cancel=1', attempt);
    expect(url.startsWith('fr.emse.canari://payment/cancel?')).toBe(true);
    expect(new URL(url).searchParams.get('checkout_id')).toBe(attempt.checkoutId);
  });
});
