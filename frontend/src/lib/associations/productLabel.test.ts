import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { productLabel, purchaseItemLabel } from './productLabel';

describe('productLabel', () => {
  it('names a Cercle top-up by its type, never by its stored technical name', () => {
    expect(productLabel({ type: 'balance_topup', name: 'balance_topup' })).toBe(
      m.admin_cercle_product_name()
    );
  });

  it('keeps the name an admin gave any other product', () => {
    expect(productLabel({ type: 'other', name: 'Sweat' })).toBe('Sweat');
    expect(productLabel({ type: 'membership', name: 'Cotisation' })).toBe('Cotisation');
  });
});

describe('purchaseItemLabel', () => {
  const products = new Map([
    ['topup', { type: 'balance_topup' as const, name: 'balance_topup' }],
    ['sweat', { type: 'other' as const, name: 'Sweat (renamed)' }],
  ]);

  it('names a top-up line by its product type', () => {
    expect(purchaseItemLabel({ productId: 'topup', productName: 'balance_topup' }, products)).toBe(
      m.admin_cercle_product_name()
    );
  });

  it('keeps the name snapshot taken at payment for any other line', () => {
    expect(purchaseItemLabel({ productId: 'sweat', productName: 'Sweat' }, products)).toBe('Sweat');
    expect(purchaseItemLabel({ productId: null, productName: 'Gala' }, products)).toBe('Gala');
    expect(purchaseItemLabel({ productId: 'gone', productName: 'Old' }, products)).toBe('Old');
  });
});
