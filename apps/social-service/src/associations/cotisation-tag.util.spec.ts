import { deriveCotisationTag, getAcademicYear, variantKeyFromLabel } from './cotisation-tag.util';

describe('variantKeyFromLabel', () => {
  it('lowercases, folds accents and ligatures to ASCII, and hyphenates', () => {
    expect(variantKeyFromLabel('Cotisation Alcoolisée', [])).toBe('cotisation-alcoolisee');
    expect(variantKeyFromLabel('  Œuvre & Café !! ', [])).toBe('oeuvre-cafe');
  });

  it('gives a label with no letter or digit a fixed key rather than an empty one', () => {
    expect(variantKeyFromLabel('\u{1F37A} !!', [])).toBe('palier');
  });

  it('suffixes the first free number on a collision, and ignores the base (null) key', () => {
    expect(variantKeyFromLabel('Avec alcool', [null, 'avec-alcool'])).toBe('avec-alcool-2');
    expect(variantKeyFromLabel('Avec alcool', ['avec-alcool', 'avec-alcool-2'])).toBe(
      'avec-alcool-3'
    );
    expect(variantKeyFromLabel('Avec alcool', [null])).toBe('avec-alcool');
  });

  it('caps the key length without leaving a trailing hyphen', () => {
    expect(variantKeyFromLabel(`${'a'.repeat(59)} b`, [])).toBe('a'.repeat(59));
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
