import { normalizeMatchKey } from './legacy-cotisation.util';

describe('normalizeMatchKey', () => {
  it('builds a lastName|firstName|promo key', () => {
    expect(normalizeMatchKey('ABID', 'Mohamed', 2025)).toBe('abid|mohamed|2025');
  });

  it('strips diacritics so the sheet and the identity provider agree', () => {
    // The BDE sheet writes "Clement"/"Clément" inconsistently; Authentik sends the accented form.
    expect(normalizeMatchKey('LESZCZAK', 'Clement', 2023)).toBe(
      normalizeMatchKey('Leszczak', 'Clément', 2023)
    );
  });

  it('treats spaces, hyphens and apostrophes in a surname as one separator', () => {
    const expected = 'ait lahcen|salwa|2025';
    expect(normalizeMatchKey('AIT LAHCEN', 'Salwa', 2025)).toBe(expected);
    expect(normalizeMatchKey('Ait-Lahcen', 'salwa', 2025)).toBe(expected);
    expect(normalizeMatchKey('  ait   lahcen  ', ' Salwa ', 2025)).toBe(expected);
  });

  it('keeps compound first names whole', () => {
    expect(normalizeMatchKey('ABDUL MASSIH', 'Anna Theresa', 2023)).toBe(
      'abdul massih|anna theresa|2023'
    );
  });

  it('separates the same person-name in two different year groups', () => {
    // CARAUD Augustin appears in both 1A and 3A of the BDE sheet: two people, not one.
    expect(normalizeMatchKey('CARAUD', 'Augustin', 2025)).not.toBe(
      normalizeMatchKey('CARAUD', 'Augustin', 2023)
    );
  });

  it('refuses a key with no promo rather than matching on the name alone', () => {
    expect(normalizeMatchKey('CARAUD', 'Augustin', null)).toBeNull();
    expect(normalizeMatchKey('CARAUD', 'Augustin', undefined)).toBeNull();
    expect(normalizeMatchKey('CARAUD', 'Augustin', 0)).toBeNull();
  });

  it('refuses a name whose accents were destroyed, rather than minting a key nothing matches', () => {
    // Le Cercle's legacy base stores "Clement" as "Cl??ment" - two '?' per accented letter.
    // Stripped as punctuation this would produce "cl ment", which looks fine and never matches.
    expect(normalizeMatchKey('DI BETTA', 'Cl??ment', 2018)).toBeNull();
    expect(normalizeMatchKey('GR??GOIRE', 'Lea', 2020)).toBeNull();
  });

  it('refuses a key with a missing or punctuation-only name part', () => {
    expect(normalizeMatchKey('', 'Augustin', 2025)).toBeNull();
    expect(normalizeMatchKey('CARAUD', '   ', 2025)).toBeNull();
    expect(normalizeMatchKey('CARAUD', '-', 2025)).toBeNull();
  });
});
