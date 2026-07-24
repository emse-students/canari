import { formatCotisationTag } from './cotisationTag';

describe('formatCotisationTag', () => {
  it('upper-cases short acronyms and strips the cotisant: prefix', () => {
    expect(formatCotisationTag('cotisant:bde')).toEqual({
      acronym: 'BDE',
      period: null,
      raw: 'cotisant:bde',
    });
  });

  it('extracts a trailing academic-year range', () => {
    expect(formatCotisationTag('cotisant:bde-2026-2027')).toEqual({
      acronym: 'BDE',
      period: '2026-2027',
      raw: 'cotisant:bde-2026-2027',
    });
  });

  it('extracts a single trailing year', () => {
    const r = formatCotisationTag('cotisant:alumni-2025');
    expect(r.acronym).toBe('Alumni');
    expect(r.period).toBe('2025');
  });

  it('capitalizes long words and upper-cases short ones per word', () => {
    expect(formatCotisationTag('cotisant:bde-partenaires').acronym).toBe('BDE Partenaires');
  });

  it('is case-insensitive on the prefix and trims whitespace', () => {
    expect(formatCotisationTag('  COTISANT:bds  ').acronym).toBe('BDS');
  });

  it('handles tags without the cotisant: prefix', () => {
    expect(formatCotisationTag('staff').acronym).toBe('Staff');
  });

  it('falls back to the raw value when no label can be derived', () => {
    expect(formatCotisationTag('').acronym).toBe('');
  });
});
