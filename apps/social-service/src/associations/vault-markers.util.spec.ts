import { isPasswordProtected, parseVaultMarkers } from './vault-markers.util';

/**
 * These strings are what `buildVaultMarkers` in
 * `frontend/src/lib/associations/vaultCrypto.ts` actually emits. They are pinned literally,
 * because the defect this file exists to prevent was precisely a server parser that no longer
 * matched the client writer: no test compared the two, and an empty `/documents` page was the
 * only symptom. If the client's format changes, THIS is the test that must change with it.
 */
const CLIENT_SALT = 'a8f1c0de-1234-4bcd-89ef-0123456789ab';
const CLIENT_PW_SALT = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
/** `buildVaultMarkers(CLIENT_SALT)` - the ordinary, shareable document. */
const CURRENT = `(s:${CLIENT_SALT})`;
/** `buildVaultMarkers(CLIENT_SALT, CLIENT_PW_SALT)` - the password-protected one. */
const CURRENT_PW = `(s:${CLIENT_SALT})(pw:${CLIENT_PW_SALT})`;

describe('parseVaultMarkers', () => {
  it('reads the CEK salt the current client writes', () => {
    // The regression: every document uploaded since 2026-07-24 carries this shape, and a
    // server that returns null here silently withholds it from every reviewer.
    expect(parseVaultMarkers(CURRENT).cekSalt).toBe(CLIENT_SALT);
  });

  it('reads both salts when the document is password-protected', () => {
    expect(parseVaultMarkers(CURRENT_PW)).toEqual({
      cekSalt: CLIENT_SALT,
      pwSalt: CLIENT_PW_SALT,
    });
  });

  it('still reads the legacy bracket syntax written before 2026-07-24', () => {
    // Rows from that era are live in production and must keep opening.
    expect(parseVaultMarkers(`[s:${CLIENT_SALT}][pw:${CLIENT_PW_SALT}]`)).toEqual({
      cekSalt: CLIENT_SALT,
      pwSalt: CLIENT_PW_SALT,
    });
  });

  it('reports no salt for a description that carries no marker', () => {
    expect(parseVaultMarkers('Statuts de l association')).toEqual({
      cekSalt: null,
      pwSalt: null,
    });
  });

  it('reports no salt for a null or empty description', () => {
    expect(parseVaultMarkers(null)).toEqual({ cekSalt: null, pwSalt: null });
    expect(parseVaultMarkers('')).toEqual({ cekSalt: null, pwSalt: null });
  });

  it('does not accept a CEK salt that is not at the very start', () => {
    // The client writes the marker as the description's prefix. Anything else is user prose
    // that happens to look like a marker, and deriving a key from it would be wrong.
    expect(parseVaultMarkers(`Statuts (s:${CLIENT_SALT})`).cekSalt).toBeNull();
  });
});

describe('isPasswordProtected', () => {
  it('recognises the marker in both syntaxes', () => {
    // The bracket-only version of this predicate left `updateDocument`'s refusal dead: a
    // password-protected document could be marked public, and no reviewer could ever open it.
    expect(isPasswordProtected(CURRENT_PW)).toBe(true);
    expect(isPasswordProtected(`[s:${CLIENT_SALT}][pw:${CLIENT_PW_SALT}]`)).toBe(true);
  });

  it('is false for an unprotected document and for no description at all', () => {
    expect(isPasswordProtected(CURRENT)).toBe(false);
    expect(isPasswordProtected(null)).toBe(false);
  });
});
