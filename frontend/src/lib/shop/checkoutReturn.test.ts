import { describe, expect, it, vi } from 'vitest';
import { ApiRefusalError } from '$lib/utils/apiRefusal';

const confirm = vi.hoisted(() => ({ read: null as unknown as () => Promise<{ status: string }> }));
vi.mock('$lib/associations/api', () => ({ confirmProductCheckout: () => confirm.read() }));

import {
  checkoutReturnTarget,
  checkoutReturnView,
  createShopCheckoutReader,
  paymentReturnAppLink,
  shopReturnPath,
} from './checkoutReturn';

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

describe('createShopCheckoutReader', () => {
  const target = { associationId: 'a1', productId: 'p1', checkoutId: 'c1' };

  function readerOver(read: () => Promise<{ status: string }>) {
    confirm.read = read;
    return createShopCheckoutReader(target);
  }

  it('words each status as the shop page does, and one read answers one question', async () => {
    const reader = readerOver(() => Promise.resolve({ status: 'paid' }));
    await expect(reader.readOnce()).resolves.toBe('paid');
  });

  it('leaves an open attempt waiting, and a throttled read waiting too', async () => {
    const open = readerOver(() => Promise.resolve({ status: 'open' }));
    await expect(open.readOnce()).resolves.toBe('waiting');
    const throttled = readerOver(() => Promise.reject(new ApiRefusalError(429, null, 'too many')));
    await expect(throttled.readOnce()).resolves.toBe('waiting');
  });

  it('says an attempt that is not the reader is unknown, and throws any other failure', async () => {
    const missing = readerOver(() => Promise.reject(new ApiRefusalError(404, null, 'not found')));
    await expect(missing.readOnce()).resolves.toBe('unknown');
    const down = readerOver(() => Promise.reject(new Error('offline')));
    await expect(down.readOnce()).rejects.toThrow('offline');
  });

  it('does not ask twice at once', async () => {
    let calls = 0;
    let release: (v: { status: string }) => void = () => {};
    const reader = readerOver(() => {
      calls++;
      return new Promise((r) => (release = r));
    });
    const first = reader.readOnce();
    await expect(reader.readOnce()).resolves.toBeNull();
    release({ status: 'declined' });
    await expect(first).resolves.toBe('declined');
    expect(calls).toBe(1);
  });
});

describe('paymentReturnAppLink', () => {
  it('links the app to a shop return that names its attempt, and to a form return', () => {
    const shop = paymentReturnAppLink(
      '/shop?purchase_success=1&productId=p1&checkout_id=c1&association_id=a1&evil=x'
    )!;
    expect(shop).toContain('payment/success?');
    expect(shop).toContain('checkout_id=c1');
    expect(shop).not.toContain('evil');
    expect(paymentReturnAppLink('/forms/success?submission_id=s1')).toContain('submission_id=s1');
  });

  it('is null for a shop path naming no attempt, a cancel, or any other page', () => {
    expect(paymentReturnAppLink('/shop?purchase_success=1&productId=p1')).toBeNull();
    expect(
      paymentReturnAppLink('/shop?purchase_cancel=1&checkout_id=c&association_id=a&productId=p')
    ).toBeNull();
    expect(paymentReturnAppLink('/posts')).toBeNull();
  });
});
