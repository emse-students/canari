import { deriveCotisationTag, getAcademicYear } from './cotisation-tag.util';

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
