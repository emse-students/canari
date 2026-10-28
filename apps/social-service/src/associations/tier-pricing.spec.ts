import {
  fixedPriceFor,
  linkedTierKey,
  orphanTierTags,
  pickHeldTier,
  tierRefusal,
  settlementGrants,
  settlementVerdict,
  tierRelation,
  tierRelationOf,
} from './tier-pricing';

describe('tierRelation - a tier is ranked by its PRODUCT price, against the tier held', () => {
  const sans = { variantKey: 'sans-alcool', amountCents: 1500, priceMatrix: null };
  const avec = { variantKey: 'avec-alcool', amountCents: 3000, priceMatrix: null };
  const held = (t: {
    variantKey: string | null;
    amountCents: number | null;
    priceMatrix: unknown;
  }) => ({
    variantKey: t.variantKey,
    product: t,
  });

  it('is none when nothing is held', () => {
    expect(tierRelation(avec, null)).toBe('none');
  });

  it('is held for the very tier held', () => {
    expect(tierRelation(sans, held(sans))).toBe('held');
  });

  it('is higher only for a strictly dearer tier', () => {
    expect(tierRelation(avec, held(sans))).toBe('higher');
  });

  it('is lower for a cheaper tier, and for an EQUALLY priced one', () => {
    expect(tierRelation(sans, held(avec))).toBe('lower');
    expect(tierRelation({ ...sans, variantKey: 'autre' }, held(sans))).toBe('lower');
  });

  it('is unranked when either side has no fixed price: grid, free amount, or no product', () => {
    const grid = { variantKey: 'grille', amountCents: 9000, priceMatrix: { dimensions: [] } };
    const free = { variantKey: 'libre', amountCents: null, priceMatrix: null };
    expect(tierRelation(grid, held(sans))).toBe('unranked');
    expect(tierRelation(free, held(sans))).toBe('unranked');
    expect(tierRelation(sans, held(grid))).toBe('unranked');
    expect(tierRelation(sans, held(free))).toBe('unranked');
    expect(tierRelation(sans, { variantKey: 'gone', product: null })).toBe('unranked');
  });
});

describe('tierRelationOf - a tier among SEVERAL held is held, whichever one ranks', () => {
  const sans = { variantKey: 'sans-alcool', amountCents: 1500, priceMatrix: null };
  const avec = { variantKey: 'avec-alcool', amountCents: 3000, priceMatrix: null };

  it('answers held for the cheaper of two held tiers, not lower', () => {
    expect(
      tierRelationOf(sans, ['avec-alcool', 'sans-alcool'], {
        variantKey: 'avec-alcool',
        product: avec,
      })
    ).toBe('held');
  });

  it('ranks like tierRelation otherwise', () => {
    expect(
      tierRelationOf(avec, ['sans-alcool'], { variantKey: 'sans-alcool', product: sans })
    ).toBe('higher');
    expect(tierRelationOf(avec, [], null)).toBe('none');
  });
});

describe('pickHeldTier - one held tier, whatever order the tags were read in', () => {
  const t = (variantKey: string | null, amountCents: number | null) => ({
    variantKey,
    product: { variantKey, amountCents, priceMatrix: null },
  });

  it('is null when nothing is held', () => {
    expect(pickHeldTier([])).toBeNull();
  });

  it('ranks against the DEAREST held tier, in either input order', () => {
    expect(pickHeldTier([t('sans', 1500), t('avec', 3000)])?.variantKey).toBe('avec');
    expect(pickHeldTier([t('avec', 3000), t('sans', 1500)])?.variantKey).toBe('avec');
  });

  it('breaks a price tie by key, named before base', () => {
    expect(pickHeldTier([t(null, 1500), t('b', 1500), t('a', 1500)])?.variantKey).toBe('a');
    expect(pickHeldTier([t(null, 1500), t('b', 1500)])?.variantKey).toBe('b');
  });

  it('picks an unrankable held tier first, so the sale is refused rather than ranked', () => {
    expect(pickHeldTier([t('avec', 3000), t(null, null)])?.variantKey).toBeNull();
  });
});

describe('linkedTierKey - the sibling a stored memberPriceTag names, whatever its year', () => {
  const keys = ['sans-alcool', 'avec-alcool', null];

  it('reads a lifetime tag', () => {
    expect(linkedTierKey('cotisant:cercle-sans-alcool', 'cercle', keys)).toBe('sans-alcool');
    expect(linkedTierKey('cotisant:cercle', 'cercle', keys)).toBeNull();
  });

  it('reads a dated tag of ANY academic year, so the rollover keeps the link', () => {
    expect(linkedTierKey('cotisant:cercle-sans-alcool-2026-2027', 'cercle', keys)).toBe(
      'sans-alcool'
    );
    expect(linkedTierKey('cotisant:cercle-sans-alcool-2027-2028', 'cercle', keys)).toBe(
      'sans-alcool'
    );
    expect(linkedTierKey('cotisant:cercle-2026-2027', 'cercle', keys)).toBeNull();
  });

  it('names nothing for another association, a missing tier or a non-year suffix', () => {
    expect(linkedTierKey('cotisant:bde-sans-alcool', 'cercle', keys)).toBeUndefined();
    expect(linkedTierKey('cotisant:cercle-vip', 'cercle', keys)).toBeUndefined();
    expect(linkedTierKey('cotisant:cercle-sans-alcool-x', 'cercle', keys)).toBeUndefined();
  });
});

describe("fixedPriceFor - the preferential price is the admin's, never computed", () => {
  const rise = { amountCents: 3000, amountCentsMember: 1500, memberPriceTag: 'cotisant:c-sans' };

  it('applies the preferential price to a holder of the linked tier', () => {
    expect(fixedPriceFor(rise, { isCotisant: true, holdsLinkedTier: true })).toEqual({
      amountCents: 1500,
      preferential: true,
    });
  });

  it('does not fall back to "any cotisant" when a linked tier is set', () => {
    expect(fixedPriceFor(rise, { isCotisant: true, holdsLinkedTier: false }).amountCents).toBe(
      3000
    );
  });

  it('applies a plain member price to any cotisant when no tier is linked', () => {
    const plain = { amountCents: 1000, amountCentsMember: 500, memberPriceTag: null };
    expect(fixedPriceFor(plain, { isCotisant: true, holdsLinkedTier: false }).amountCents).toBe(
      500
    );
    expect(fixedPriceFor(plain, { isCotisant: false, holdsLinkedTier: false }).amountCents).toBe(
      1000
    );
  });

  it('charges in full when no preferential price is configured', () => {
    const bare = { amountCents: 3000, amountCentsMember: null, memberPriceTag: 'cotisant:c-sans' };
    expect(fixedPriceFor(bare, { isCotisant: true, holdsLinkedTier: true })).toEqual({
      amountCents: 3000,
      preferential: false,
    });
  });
});

describe('tierRefusal - one mapping from a relation to the typed 409, for the shop and the forms', () => {
  it('sells none and higher', () => {
    expect(tierRefusal('none')).toBeNull();
    expect(tierRefusal('higher')).toBeNull();
  });

  it('answers each refused relation with the code the client words', () => {
    expect(tierRefusal('held')?.code).toBe('PRODUCT_ALREADY_PURCHASED');
    expect(tierRefusal('lower')?.code).toBe('TIER_NOT_A_RISE');
    expect(tierRefusal('unranked')?.code).toBe('TIER_NOT_RANKABLE');
  });
});

describe('settlementVerdict - a settlement grants on what the opening froze, never on a price', () => {
  it.each([
    ['nothing held now, nothing frozen', 'avec', [], [], false, 'nothing-held', true],
    [
      'nothing held now, a tier frozen (it expired since)',
      'avec',
      [],
      ['sans'],
      true,
      'frozen-gone',
      false,
    ],
    [
      'nothing held now, a tier frozen whose product is deleted since',
      'avec',
      [],
      [],
      true,
      'frozen-gone',
      false,
    ],
    ['the frozen tier is still the one held', 'avec', ['sans'], ['sans'], true, 'as-opened', true],
    ['the frozen tier is the base tier', 'avec', [null], [null], true, 'as-opened', true],
    ['the target itself was obtained since', 'avec', ['avec'], ['sans'], true, 'held', false],
    [
      'another tier replaced the frozen one',
      'avec',
      ['autre'],
      ['sans'],
      true,
      'held-changed',
      false,
    ],
    [
      'a tier is held where the opening saw none',
      'avec',
      ['sans'],
      [],
      false,
      'held-changed',
      false,
    ],
    [
      'a second tier beside the frozen one',
      'avec',
      ['sans', null],
      ['sans'],
      true,
      'held-changed',
      false,
    ],
  ] as const)('%s', (_name, target, held, frozen, froze, verdict, grants) => {
    const v = settlementVerdict(target, held, frozen, froze);
    expect(v).toBe(verdict);
    expect(settlementGrants(v)).toBe(grants);
  });
});

describe('orphanTierTags - a tag of a tier that no longer exists', () => {
  const keys = ['avec', null];

  it('names a deleted named tier, lifetime or dated, by the key read back from the tag', () => {
    expect(
      orphanTierTags(['cotisant:bde-premium', 'cotisant:bde-gold-2026-2027'], 'bde', keys)
    ).toEqual([
      { tagName: 'cotisant:bde-gold-2026-2027', variantKey: 'gold' },
      { tagName: 'cotisant:bde-premium', variantKey: 'premium' },
    ]);
  });

  it('names a deleted BASE tier with a null key, lifetime or dated', () => {
    expect(orphanTierTags(['cotisant:bde', 'cotisant:bde-2026-2027'], 'bde', ['avec'])).toEqual([
      { tagName: 'cotisant:bde', variantKey: null },
      { tagName: 'cotisant:bde-2026-2027', variantKey: null },
    ]);
  });

  it('CONTROL: a tag of an existing tier, in any year, is not an orphan', () => {
    expect(
      orphanTierTags(
        [
          'cotisant:bde',
          'cotisant:bde-2025-2026',
          'cotisant:bde-avec',
          'cotisant:bde-avec-2026-2027',
        ],
        'bde',
        keys
      )
    ).toEqual([]);
  });

  it('ignores a tag outside the association namespace, and a slug it merely prefixes', () => {
    expect(orphanTierTags(['cotisant:bdex', 'staff:bde', 'cotisant:other'], 'bde', keys)).toEqual(
      []
    );
  });
});
