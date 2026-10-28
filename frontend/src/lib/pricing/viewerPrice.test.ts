import { describe, expect, it } from 'vitest';
import type { AssociationProduct } from '$lib/associations/api';
import { preferentialDueCents, tierNotOffered } from './viewerPrice';

/** A fixed-price tier product; only the fields these helpers read matter. */
const tier = (overrides: Partial<AssociationProduct> = {}): AssociationProduct =>
  ({
    id: 'prod-avec',
    type: 'membership',
    amountCents: 3000,
    amountCentsMember: 1500,
    memberPriceTag: 'cotisant:cercle-sans-alcool',
    priceMatrix: null,
    currency: 'eur',
    ...overrides,
  }) as AssociationProduct;

describe('tierNotOffered', () => {
  it('offers nothing for a held, lower or unranked tier - the checkout refuses each', () => {
    for (const relation of ['held', 'lower', 'unranked'] as const) {
      expect(tierNotOffered(tier({ viewerTierRelation: relation }))).toBe(relation);
    }
  });

  it('offers a rise, a tier bought from nothing, and a product the server did not annotate', () => {
    expect(tierNotOffered(tier({ viewerTierRelation: 'higher' }))).toBeNull();
    expect(tierNotOffered(tier({ viewerTierRelation: 'none' }))).toBeNull();
    expect(tierNotOffered(tier())).toBeNull();
  });
});

describe('preferentialDueCents', () => {
  it('shows the amount the server says this viewer is charged when it is below the full price', () => {
    expect(preferentialDueCents(tier({ viewerDueCents: 1500 }))).toBe(1500);
  });

  it('shows no preferential price when the server charges the full price, whatever the columns say', () => {
    // The member-price columns are set, but the server decided this viewer does not qualify.
    expect(preferentialDueCents(tier({ viewerDueCents: 3000 }))).toBeNull();
  });

  it('shows none for a refused tier, a grid, or a free amount', () => {
    expect(preferentialDueCents(tier({ viewerDueCents: null }))).toBeNull();
    expect(
      preferentialDueCents(
        tier({ viewerDueCents: 1000, priceMatrix: {} as AssociationProduct['priceMatrix'] })
      )
    ).toBeNull();
    expect(preferentialDueCents(tier({ amountCents: null, viewerDueCents: null }))).toBeNull();
  });
});
