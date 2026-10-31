import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { formatAmount } from '$lib/forms/fillAnswers';
import {
  centsToEuros,
  defaultRiseSource,
  eurosToCents,
  mayCreateTier,
  riseGivesNoDiscount,
  riseSentence,
  riseSourceTier,
  riseSources,
  tierRankCents,
  tiersInPriceOrder,
  type TierLike,
} from './cotisationTiers';

/** A tier with a single price; `grid: true` makes it gridded (unrankable). */
function tier(id: string, name: string, cents: number | null, grid = false): TierLike {
  return {
    id,
    name,
    amountCents: cents,
    priceMatrix: grid
      ? ({ dimensions: [], cells: [] } as unknown as TierLike['priceMatrix'])
      : null,
    grantedTagName: `cotisant:cercle-${id}`,
    variantKey: id === 'base' ? null : id,
    allowCustomAmount: false,
  };
}

describe('tierRankCents - the shared rank vector', () => {
  const vector = JSON.parse(
    readFileSync(resolve(process.cwd(), '../tools/tier-rank-vector.json'), 'utf-8')
  ) as (TierLike & { rank: number | null })[];
  it.each(vector.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(tierRankCents(v)).toBe(v.rank);
  });
});

const sansAlcool = tier('sans', 'Cotisation', 1500);
const avecAlcool = tier('avec', 'Cotisation Alcool', 3000);

describe('mayCreateTier', () => {
  it('offers tier creation only to a server that says it derives the key from the label', () => {
    expect(mayCreateTier({ tierKeyFromLabel: true })).toBe(true);
  });

  it('offers nothing to an older server, or when the options could not be read', () => {
    expect(mayCreateTier({})).toBe(false);
    expect(mayCreateTier({ tierKeyFromLabel: false })).toBe(false);
    expect(mayCreateTier(null)).toBe(false);
    expect(mayCreateTier(undefined)).toBe(false);
  });
});

describe('tiersInPriceOrder', () => {
  it('reads cheapest first, whatever order the API answered in', () => {
    expect(tiersInPriceOrder([avecAlcool, sansAlcool]).map((t) => t.id)).toEqual(['sans', 'avec']);
  });

  it('puts a tier with no single price (grid or none) last, and breaks ties by label', () => {
    const grid = tier('grid', 'A grille', 500, true);
    const unpriced = tier('none', 'B sans prix', null);
    const twin = tier('twin', 'Abc', 1500);
    expect(
      tiersInPriceOrder([grid, avecAlcool, unpriced, sansAlcool, twin]).map((t) => t.id)
    ).toEqual(['twin', 'sans', 'avec', 'grid', 'none']);
  });

  it('ranks an unpriced BASE tier lowest, ahead of every priced tier', () => {
    const base = tier('base', 'Zzz base', null);
    const named = tier('none', 'A libre', null);
    expect(tiersInPriceOrder([avecAlcool, named, sansAlcool, base]).map((t) => t.id)).toEqual([
      'base',
      'sans',
      'avec',
      'none',
    ]);
  });

  it('does not reorder the array it was given', () => {
    const input = [avecAlcool, sansAlcool];
    tiersInPriceOrder(input);
    expect(input[0]).toBe(avecAlcool);
  });
});

describe('riseSources and defaultRiseSource', () => {
  it('offers every other tier that grants a tag, in reading order', () => {
    const tagless = { ...tier('x', 'Sans tag', 100), grantedTagName: null };
    expect(riseSources([avecAlcool, tagless, sansAlcool], 'avec').map((t) => t.id)).toEqual([
      'sans',
    ]);
  });

  it('starts from the dearest tier still cheaper than this one', () => {
    const mid = tier('mid', 'Moyen', 2000);
    const sources = riseSources([sansAlcool, mid, avecAlcool], 'avec');
    expect(defaultRiseSource(sources, 3000)?.id).toBe('mid');
  });

  it('falls to the first source when none is cheaper or the price is unknown', () => {
    expect(defaultRiseSource([avecAlcool], 1000)?.id).toBe('avec');
    expect(defaultRiseSource([sansAlcool, avecAlcool], null)?.id).toBe('sans');
    expect(defaultRiseSource([], 1000)).toBeNull();
  });

  it('finds the source tier by the tag it grants, and nothing for a stale tag', () => {
    expect(riseSourceTier([sansAlcool, avecAlcool], 'cotisant:cercle-sans')).toBe(sansAlcool);
    expect(riseSourceTier([sansAlcool], 'cotisant:cercle-gone')).toBeNull();
    expect(riseSourceTier([sansAlcool], null)).toBeNull();
  });
});

describe('euro fields', () => {
  it('reads a typed amount in cents, with a French decimal comma', () => {
    expect(eurosToCents(15)).toBe(1500);
    expect(eurosToCents('12,5')).toBe(1250);
    expect(eurosToCents('0.1')).toBe(10);
  });

  it('answers null for an empty or unreadable field', () => {
    expect(eurosToCents('')).toBeNull();
    expect(eurosToCents('  ')).toBeNull();
    expect(eurosToCents('abc')).toBeNull();
    expect(eurosToCents(null)).toBeNull();
  });

  it('shows stored cents back as euros, empty for none', () => {
    expect(centsToEuros(1550)).toBe(15.5);
    expect(centsToEuros(null)).toBe('');
  });
});

describe('riseSentence', () => {
  it('words the preferential price: what a holder pays instead of the full price', () => {
    const q = {
      fromName: 'Cotisation',
      toName: 'Cotisation Alcool',
      fullCents: 3000,
      riseCents: 1500,
    };
    expect(riseSentence(q)).toBe(
      m.asso_cotisations_rise_preview({
        from: 'Cotisation',
        to: 'Cotisation Alcool',
        due: formatAmount(1500),
        full: formatAmount(3000),
      })
    );
  });

  it('says a holder pays the FULL price when no preferential price is set', () => {
    const q = { fromName: null, toName: 'Cotisation Alcool', fullCents: 3000, riseCents: null };
    expect(riseSentence(q)).toBe(
      m.asso_cotisations_rise_preview_none({ to: 'Cotisation Alcool', full: formatAmount(3000) })
    );
  });

  it('says the full price is charged while the amount is still empty', () => {
    const q = { fromName: 'Cotisation', toName: 'Alcool', fullCents: 3000, riseCents: null };
    expect(riseSentence(q)).toBe(
      m.asso_cotisations_rise_preview_full({
        from: 'Cotisation',
        to: 'Alcool',
        full: formatAmount(3000),
      })
    );
  });

  it('names a missing full price rather than printing a zero', () => {
    const q = { fromName: null, toName: 'Alcool', fullCents: null, riseCents: null };
    expect(riseSentence(q)).toBe(
      m.asso_cotisations_rise_preview_none({
        to: 'Alcool',
        full: m.asso_cotisations_tier_price_free_label(),
      })
    );
  });
});

describe('riseGivesNoDiscount', () => {
  const base = { fromName: 'Cotisation', toName: 'Alcool', fullCents: 3000 };
  it('flags a preferential price at or above the full price', () => {
    expect(riseGivesNoDiscount({ ...base, riseCents: 3000 })).toBe(true);
    expect(riseGivesNoDiscount({ ...base, riseCents: 3500 })).toBe(true);
  });

  it('stays quiet for a real reduction, or when nothing is set', () => {
    expect(riseGivesNoDiscount({ ...base, riseCents: 1500 })).toBe(false);
    expect(riseGivesNoDiscount({ ...base, riseCents: null })).toBe(false);
    expect(riseGivesNoDiscount({ ...base, fromName: null, riseCents: 3500 })).toBe(false);
  });
});
