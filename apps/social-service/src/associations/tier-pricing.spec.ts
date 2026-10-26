import { fixedPriceFor, tierRelation } from './tier-pricing';

describe('tierRelation - a tier is ranked by its PRODUCT price, against the tier held', () => {
  const sans = { variantKey: 'sans-alcool', amountCents: 1500, priceMatrix: null };
  const avec = { variantKey: 'avec-alcool', amountCents: 3000, priceMatrix: null };
  const held = (t: typeof sans) => ({ variantKey: t.variantKey, product: t });

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

  it('does not rank a gridded or a free-amount tier, on either side', () => {
    const grid = { variantKey: 'grille', amountCents: 9000, priceMatrix: { dimensions: [] } };
    const free = { variantKey: 'libre', amountCents: null, priceMatrix: null };
    expect(tierRelation(grid, held(sans))).toBe('none');
    expect(tierRelation(free, held(sans))).toBe('none');
    expect(tierRelation(avec, { variantKey: 'grille', product: grid })).toBe('none');
  });

  it('is none when the held tag has no product left to rank it by', () => {
    expect(tierRelation(avec, { variantKey: null, product: null })).toBe('none');
    // ...but holding the base tag still makes the base tier `held`.
    expect(tierRelation({ ...sans, variantKey: null }, { variantKey: null, product: null })).toBe(
      'held'
    );
  });
});

describe("fixedPriceFor - the preferential price is the admin's, never computed", () => {
  const rise = { amountCents: 3000, amountCentsMember: 1500, memberPriceTag: 'cotisant:c-sans' };

  it('applies the preferential price to a holder of the linked tag', () => {
    expect(fixedPriceFor(rise, { isCotisant: true, holdsMemberPriceTag: true })).toEqual({
      amountCents: 1500,
      preferential: true,
    });
  });

  it('does not fall back to "any cotisant" when a linked tag is set', () => {
    expect(fixedPriceFor(rise, { isCotisant: true, holdsMemberPriceTag: false }).amountCents).toBe(
      3000
    );
  });

  it('applies a plain member price to any cotisant when no tag is linked', () => {
    const plain = { amountCents: 1000, amountCentsMember: 500, memberPriceTag: null };
    expect(fixedPriceFor(plain, { isCotisant: true, holdsMemberPriceTag: false }).amountCents).toBe(
      500
    );
    expect(
      fixedPriceFor(plain, { isCotisant: false, holdsMemberPriceTag: false }).amountCents
    ).toBe(1000);
  });

  it('charges in full when no preferential price is configured', () => {
    const bare = { amountCents: 3000, amountCentsMember: null, memberPriceTag: 'cotisant:c-sans' };
    expect(fixedPriceFor(bare, { isCotisant: true, holdsMemberPriceTag: true })).toEqual({
      amountCents: 3000,
      preferential: false,
    });
  });
});
