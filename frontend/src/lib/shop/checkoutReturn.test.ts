import { describe, expect, it } from 'vitest';
import { checkoutReturnTarget, checkoutReturnView, shopReturnPath } from './checkoutReturn';

describe('shopReturnPath', () => {
  it('carries the attempt from the app deep link into the shop, both ways back', () => {
    const deep = new URLSearchParams(
      'purchase_cancel=1&productId=p1&checkout_id=c1&association_id=a1&evil=x'
    );
    // The control: the deep link used to open `/shop?purchase_cancel=1`, naming no attempt.
    const path = shopReturnPath('purchase_cancel', deep);
    const back = new URLSearchParams(path.split('?')[1]);
    expect(path.startsWith('/shop?')).toBe(true);
    expect(checkoutReturnTarget(back)).toEqual({
      associationId: 'a1',
      productId: 'p1',
      checkoutId: 'c1',
    });
    expect(back.has('evil')).toBe(false);
    expect(shopReturnPath('purchase_success', deep)).toContain('purchase_success=1');
  });
});

describe('checkoutReturnView', () => {
  it('keeps asking only while the attempt is open', () => {
    expect(checkoutReturnView('open')).toBe('waiting');
    expect(checkoutReturnView('paid')).toBe('paid');
    expect(checkoutReturnView('declined')).toBe('declined');
    expect(checkoutReturnView('expired')).toBe('notCompleted');
    expect(checkoutReturnView('cancelled')).toBe('notCompleted');
  });
});

describe('checkoutReturnTarget', () => {
  it('reads the three ids the server put in the return URL', () => {
    const params = new URLSearchParams(
      'purchase_success=1&productId=p1&checkout_id=c1&association_id=a1'
    );
    expect(checkoutReturnTarget(params)).toEqual({
      associationId: 'a1',
      productId: 'p1',
      checkoutId: 'c1',
    });
  });

  it('names no attempt when one id is missing - a return of before the attempt existed', () => {
    // The control: the pre-attempt return carried `productId` alone and named nothing to ask about.
    expect(checkoutReturnTarget(new URLSearchParams('purchase_success=1&productId=p1'))).toBeNull();
    expect(checkoutReturnTarget(new URLSearchParams('checkout_id=c1&productId=p1'))).toBeNull();
  });
});
