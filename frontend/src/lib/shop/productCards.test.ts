import { describe, expect, it } from 'vitest';
import type { AssociationProduct } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import {
  cotisationDisabledForAssociation,
  hasUnrankedTier,
  nonTierProducts,
  offeredTiers,
  productDisplayName,
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

  it('is empty for the holder of the highest tier: no membership card at all', () => {
    expect(offeredTiers([low, held])).toEqual([]);
  });

  it('offers NO row on an unranked tier, and hints only when a membership is held', () => {
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

  it("offers a tier the listing did not annotate, same as viewerPrice.ts's own canonical call", () => {
    // `tierNotOffered` (viewerPrice.ts, the ONE decision) buckets an unset `viewerTierRelation`
    // with 'none'/'higher', not with 'held'/'lower'/'unranked' - this wrapper adds no second
    // opinion on top of it, so an old listing with no relation at all is offered, not hidden.
    const unknown = product({ id: 'u', type: 'membership', variantKey: 'u' });
    expect(offeredTiers([unknown]).map((t) => t.id)).toEqual(['u']);
  });

  it('offers no row once the association disables cotisations, even on an otherwise-rising tier', () => {
    const disabled = product({
      id: 'd',
      type: 'membership',
      variantKey: 'd',
      viewerTierRelation: 'higher',
      cotisationDisabled: true,
    });
    expect(offeredTiers([disabled])).toEqual([]);
  });

  it('never lists a non-membership product, and nonTierProducts is its complement', () => {
    const topup = product({ id: 't', type: 'balance_topup' });
    expect(offeredTiers([topup, rise]).map((t) => t.id)).toEqual(['rise']);
    expect(nonTierProducts([topup, rise]).map((t) => t.id)).toEqual(['t']);
  });
});

describe('cotisationDisabledForAssociation', () => {
  it('reads the flag off any membership product of the association', () => {
    const a = product({ type: 'membership', cotisationDisabled: true });
    const b = product({
      type: 'membership',
      cotisationDisabled: false,
      viewerTierRelation: 'none',
    });
    expect(cotisationDisabledForAssociation([b, a])).toBe(true);
    expect(cotisationDisabledForAssociation([b])).toBe(false);
  });

  it('ignores a non-membership product carrying no such flag', () => {
    expect(cotisationDisabledForAssociation([product({ type: 'balance_topup' })])).toBe(false);
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
