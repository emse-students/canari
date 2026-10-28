import { describe, expect, it } from 'vitest';
import type { AssociationProduct } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import {
  linkedTierName,
  preferentialDueCents,
  preferentialPriceLabel,
  tierNotOffered,
  tierNotOfferedText,
} from './viewerPrice';

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

  // The checkout refuses COTISATION_DISABLED whatever the tier's rank: the listing says so first.
  it('offers nothing when the association has disabled its cotisations, before any rank', () => {
    expect(tierNotOffered(tier({ cotisationDisabled: true, viewerTierRelation: 'none' }))).toBe(
      'disabled'
    );
    expect(
      tierNotOffered(tier({ cotisationDisabled: false, viewerTierRelation: 'none' }))
    ).toBeNull();
  });

  it('words each reason with the sentence of the refusal the checkout would answer', () => {
    expect(tierNotOfferedText('disabled')).toBe(m.shop_cotisation_disabled());
    expect(tierNotOfferedText('held')).toBe(m.shop_tier_held_hint());
    expect(tierNotOfferedText('lower')).toBe(m.shop_tier_not_a_rise());
    expect(tierNotOfferedText('unranked')).toBe(m.shop_tier_not_rankable());
  });
});

describe('linkedTierName', () => {
  const sans = tier({ id: 'prod-sans', variantKey: 'sans-alcool', name: 'Sans alcool' });
  const avec = tier({ id: 'prod-avec', variantKey: 'avec-alcool', name: 'Avec alcool' });

  // A viewer holding two tiers: the first one held is not always the one the price is linked to.
  it('names the tier the server read the tag as naming, not the first tier the viewer holds', () => {
    const product = tier({ memberPriceTierKey: 'sans-alcool', viewerActiveTier: 'avec-alcool' });
    expect(linkedTierName(product, [sans, avec])).toBe('Sans alcool');
  });

  it('names nothing for a cotisant price, or when the server named no tier', () => {
    expect(linkedTierName(tier({ memberPriceTag: null }), [sans, avec])).toBeNull();
    expect(linkedTierName(tier({ memberPriceTierKey: undefined }), [sans, avec])).toBeNull();
  });
});

describe('preferentialPriceLabel', () => {
  it('formats the preferential amount, and is null at the full price', () => {
    expect(preferentialPriceLabel(tier({ viewerDueCents: 1500 }))).toBe('15.00 EUR');
    expect(preferentialPriceLabel(tier({ viewerDueCents: 3000 }))).toBeNull();
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
