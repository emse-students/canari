import { describe, expect, it } from 'vitest';
import type { AssociationProduct } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import {
  dueCents,
  hasUnrankedTier,
  nonTierProducts,
  offeredTiers,
  productDisplayName,
  struckCents,
} from './productCards';

const product = (over: Partial<AssociationProduct>): AssociationProduct =>
  ({
    id: 'p',
    associationId: 'a',
    name: 'Product',
    description: null,
    amountCents: 1500,
    currency: 'eur',
    type: 'other',
    allowCustomAmount: false,
    variantKey: null,
    variantLevel: null,
    ...over,
  }) as AssociationProduct;

describe('offeredTiers', () => {
  const low = product({
    id: 'low',
    type: 'membership',
    variantKey: 'sans',
    viewerTierRelation: 'lower',
  });
  const held = product({
    id: 'held',
    type: 'membership',
    variantKey: 'mid',
    viewerTierRelation: 'held',
  });
  const rise = product({
    id: 'rise',
    type: 'membership',
    variantKey: 'avec',
    viewerTierRelation: 'higher',
  });
  const none = product({
    id: 'none',
    type: 'membership',
    variantKey: 'x',
    viewerTierRelation: 'none',
  });

  it('offers neither the held tier nor a lower one', () => {
    expect(offeredTiers([low, held, rise, none]).map((t) => t.id)).toEqual(['rise', 'none']);
  });

  it('offers no action when the listing does not say where a tier stands (old server)', () => {
    const unknown = product({ id: 'u', type: 'membership', variantKey: 'u' });
    expect(offeredTiers([unknown])).toEqual([]);
  });

  it('offers NO action on an unranked tier, and hints only when a membership is held', () => {
    const unranked = product({
      id: 'un',
      type: 'membership',
      variantKey: 'un',
      viewerTierRelation: 'unranked',
    });
    expect(offeredTiers([unranked, rise]).map((t) => t.id)).toEqual(['rise']);
    expect(hasUnrankedTier([unranked])).toBe(false);
    expect(hasUnrankedTier([unranked, product({ viewerIsCotisant: true })])).toBe(true);
  });

  it('is empty for the holder of the highest tier: no membership card at all', () => {
    expect(offeredTiers([low, held])).toEqual([]);
  });

  it('never lists a non-membership product, and nonTierProducts is its complement', () => {
    const topup = product({ id: 't', type: 'balance_topup' });
    expect(offeredTiers([topup, rise]).map((t) => t.id)).toEqual(['rise']);
    expect(nonTierProducts([topup, rise]).map((t) => t.id)).toEqual(['t']);
  });
});

describe('dueCents and struckCents', () => {
  it('shows the server due amount with the full price struck when it is a rise', () => {
    const rise = product({ type: 'membership', amountCents: 3000, viewerDueCents: 1500 });
    expect(dueCents(rise)).toBe(1500);
    expect(struckCents(rise)).toBe(3000);
  });

  it('strikes nothing when the viewer pays the full price', () => {
    const full = product({ amountCents: 3000, viewerDueCents: 3000 });
    expect(struckCents(full)).toBeNull();
  });

  it('is null for a free amount', () => {
    expect(
      dueCents(product({ amountCents: null, allowCustomAmount: true, viewerDueCents: null }))
    ).toBeNull();
  });
});

describe('productDisplayName', () => {
  it('never prints a snake_case key: the type label stands in', () => {
    const name = productDisplayName(product({ name: 'balance_topup', type: 'balance_topup' }));
    expect(name).toBe(m.shop_label_topup());
    expect(name).not.toMatch(/_/);
  });

  it('keeps a human name, and labels an empty one', () => {
    expect(productDisplayName(product({ name: 'Cotisation BDE' }))).toBe('Cotisation BDE');
    expect(productDisplayName(product({ name: ' ', type: 'membership' }))).toBe(
      m.shop_label_membership()
    );
  });
});
