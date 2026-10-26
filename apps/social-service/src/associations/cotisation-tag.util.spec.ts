import {
  deriveCotisationTag,
  getAcademicYear,
  variantKeyCap,
  variantKeyFromLabel,
} from './cotisation-tag.util';

/** Builds a label from code points, so this file stays ASCII. */
const chars = (...codes: number[]) => String.fromCharCode(...codes);
const E_ACUTE = chars(0xe9);
const OE = chars(0x152);

describe('variantKeyFromLabel', () => {
  it('lowercases, folds accents and ligatures to ASCII, and hyphenates', () => {
    expect(variantKeyFromLabel(`Cotisation Alcoolis${E_ACUTE}e`, [])).toBe('cotisation-alcoolisee');
    expect(variantKeyFromLabel(`  ${OE}uvre & Caf${E_ACUTE} !! `, [])).toBe('oeuvre-cafe');
  });

  it('gives a label with no letter or digit a fixed key rather than an empty one', () => {
    expect(variantKeyFromLabel(`${chars(0xd83c, 0xdf7a)} !!`, [])).toBe('palier');
  });

  it('suffixes the first free number on a collision, and ignores the base (null) key', () => {
    expect(variantKeyFromLabel('Avec alcool', [null, 'avec-alcool'])).toBe('avec-alcool-2');
    expect(variantKeyFromLabel('Avec alcool', ['avec-alcool', 'avec-alcool-2'])).toBe(
      'avec-alcool-3'
    );
    expect(variantKeyFromLabel('Avec alcool', [null])).toBe('avec-alcool');
  });

  it('drops a year-shaped tail, so a key never reads like the dated tag of another tier', () => {
    expect(variantKeyFromLabel('Cotisation 2026-2027', [])).toBe('cotisation');
    expect(variantKeyFromLabel('Cotisation 2026', [])).toBe('cotisation');
    expect(variantKeyFromLabel('Cotisation 2026-2027', ['cotisation'])).toBe('cotisation-2');
    expect(variantKeyFromLabel('2026-2027', [])).toBe('palier');
    // Only a TAIL: a year inside the label is part of its name.
    expect(variantKeyFromLabel('Gala 2026 VIP', [])).toBe('gala-2026-vip');
  });

  it('cannot produce the dated tag of a sibling tier', () => {
    const now = new Date(Date.UTC(2026, 9, 1));
    const sibling = deriveCotisationTag('bde', 'dated', now, 'cotisation').tagName;
    const key = variantKeyFromLabel(`Cotisation ${getAcademicYear(now)}`, ['cotisation']);
    expect(deriveCotisationTag('bde', 'lifetime', now, key).tagName).not.toBe(sibling);
  });

  it('caps the key length without leaving a trailing hyphen', () => {
    expect(variantKeyFromLabel(`${'a'.repeat(59)} b`, [])).toBe('a'.repeat(59));
    expect(variantKeyFromLabel('abcdef ghi', [], 7)).toBe('abcdef');
  });

  it('refuses a cap with no room for a key', () => {
    expect(() => variantKeyFromLabel('Avec alcool', [], 0)).toThrow(RangeError);
  });
});

describe('variantKeyCap', () => {
  it('keeps the longest dated tag of a suffixed key within the 100-char tag column', () => {
    const now = new Date(Date.UTC(2026, 9, 1));
    const slug = 'association-des-eleves-ingenieurs-du-campus-long'; // 48 chars
    const cap = variantKeyCap(slug);
    const label = 'x'.repeat(60);
    const key = variantKeyFromLabel(label, ['x'.repeat(cap)], cap);
    expect(key).toBe(`${'x'.repeat(cap)}-2`);
    expect(deriveCotisationTag(slug, 'dated', now, key).tagName.length).toBeLessThanOrEqual(100);
    // And a 999th collision still fits.
    expect(
      deriveCotisationTag(slug, 'dated', now, `${'x'.repeat(cap)}-999`).tagName.length
    ).toBeLessThanOrEqual(100);
  });

  it('allows the full 60 characters for a short slug', () => {
    expect(variantKeyCap('bde')).toBe(60);
  });

  it('falls below 1 for a slug that leaves no room for any named tier', () => {
    expect(variantKeyCap('s'.repeat(80))).toBeLessThan(1);
  });
});

describe('cotisation-tag util', () => {
  describe('getAcademicYear', () => {
    it('returns <year>-<year+1> from September onward', () => {
      expect(getAcademicYear(new Date(Date.UTC(2026, 8, 1)))).toBe('2026-2027');
      expect(getAcademicYear(new Date(Date.UTC(2026, 11, 15)))).toBe('2026-2027');
    });

    it('returns <year-1>-<year> before September', () => {
      expect(getAcademicYear(new Date(Date.UTC(2027, 0, 15)))).toBe('2026-2027');
      expect(getAcademicYear(new Date(Date.UTC(2027, 7, 31)))).toBe('2026-2027');
    });
  });

  describe('deriveCotisationTag', () => {
    it('lifetime mode: tag never expires and has no variant suffix by default', () => {
      const tag = deriveCotisationTag('bde', 'lifetime');
      expect(tag).toEqual({ tagName: 'cotisant:bde', expiresAt: null });
    });

    it('dated mode: tag is suffixed with the academic year and expires 31 Aug end of day UTC', () => {
      const now = new Date(Date.UTC(2026, 8, 15));
      const tag = deriveCotisationTag('bde', 'dated', now);
      expect(tag.tagName).toBe('cotisant:bde-2026-2027');
      expect(tag.expiresAt).toEqual(new Date(Date.UTC(2027, 7, 31, 23, 59, 59)));
    });

    it('lifetime mode with a variant: suffixes the slug, not the tag as a whole', () => {
      const tag = deriveCotisationTag('cercle', 'lifetime', new Date(), 'avec-alcool');
      expect(tag).toEqual({ tagName: 'cotisant:cercle-avec-alcool', expiresAt: null });
    });

    it('dated mode with a variant: variant comes before the academic year suffix', () => {
      const now = new Date(Date.UTC(2026, 8, 15));
      const tag = deriveCotisationTag('cercle', 'dated', now, 'sans-alcool');
      expect(tag.tagName).toBe('cotisant:cercle-sans-alcool-2026-2027');
      expect(tag.expiresAt).toEqual(new Date(Date.UTC(2027, 7, 31, 23, 59, 59)));
    });

    it('omitting the variant is identical to the pre-existing single-tier form (back-compat)', () => {
      const now = new Date(Date.UTC(2026, 8, 15));
      expect(deriveCotisationTag('bde', 'dated', now)).toEqual(
        deriveCotisationTag('bde', 'dated', now, undefined)
      );
      expect(deriveCotisationTag('bde', 'dated', now, null)).toEqual(
        deriveCotisationTag('bde', 'dated', now)
      );
    });
  });
});
