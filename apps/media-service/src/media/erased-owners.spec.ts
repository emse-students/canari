/// <reference types="jest" />

/**
 * The window the erased-owner record is kept is DERIVED from two numbers this service does not own
 * alone: core-service's access-token lifetime (and its skew), and the upload session's window. The
 * first is mirrored here, so this spec reads core's own file and fails the day it moves.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CORE_ACCESS_TOKEN_TTL_SECONDS,
  CORE_CREDENTIAL_SKEW_SECONDS,
  ERASED_OWNER_KEY_REGEX,
  datesFromBeforeTheErasure,
  erasedOwnerKey,
  openedBeforeTheErasure,
  erasedOwnerKeptMs,
} from './erased-owners';

process.env.JWT_SECRET ??= 'test-erasure-key';

/** Evaluates `export const NAME = <arithmetic>;` from core's source - digits, spaces and `*` only. */
function coreConstant(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([0-9 *]+);`).exec(source);
  if (!match) throw new Error(`${name} not found in core-service's token-lifetimes.ts`);
  return match[1].split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
}

describe('the erased-owner record', () => {
  it("mirrors core-service's access-token lifetime and skew exactly", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../core-service/src/auth/token-lifetimes.ts'),
      'utf8'
    );
    expect(coreConstant(source, 'ACCESS_TOKEN_TTL_SECONDS')).toBe(CORE_ACCESS_TOKEN_TTL_SECONDS);
    expect(coreConstant(source, 'CREDENTIAL_SKEW_SECONDS')).toBe(CORE_CREDENTIAL_SKEW_SECONDS);
  });

  it('is kept at least as long as a token, and at least as long as an upload session', () => {
    const prev = process.env.MEDIA_UPLOAD_SESSION_TTL_MS;
    try {
      delete process.env.MEDIA_UPLOAD_SESSION_TTL_MS;
      expect(erasedOwnerKeptMs()).toBe(24 * 60 * 60 * 1000);
      process.env.MEDIA_UPLOAD_SESSION_TTL_MS = String(48 * 60 * 60 * 1000);
      expect(erasedOwnerKeptMs()).toBe(48 * 60 * 60 * 1000);
      // A session window shorter than a token never shortens the record below the token.
      process.env.MEDIA_UPLOAD_SESSION_TTL_MS = '1000';
      expect(erasedOwnerKeptMs()).toBe(
        (CORE_ACCESS_TOKEN_TTL_SECONDS + CORE_CREDENTIAL_SKEW_SECONDS) * 1000
      );
    } finally {
      if (prev === undefined) delete process.env.MEDIA_UPLOAD_SESSION_TTL_MS;
      else process.env.MEDIA_UPLOAD_SESSION_TTL_MS = prev;
    }
  });

  it('is keyed by an HMAC under JWT_SECRET the loader accepts, never by the id', () => {
    const key = erasedOwnerKey('alice');
    expect(key).toMatch(ERASED_OWNER_KEY_REGEX);
    expect(key).not.toContain('alice');
    expect(erasedOwnerKey('alice')).toBe(key);
    // KEYED: another secret, another pseudonym - a plain digest of a guessable id would not differ.
    const prev = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = 'another-secret';
      expect(erasedOwnerKey('alice')).not.toBe(key);
      delete process.env.JWT_SECRET;
      expect(() => erasedOwnerKey('alice')).toThrow(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = prev;
    }
  });

  it('refuses only what dates from before the latest call, judged at the second of `iat`', () => {
    const erasedAt = 1_800_000_000_500; // .5 s into a second
    expect(datesFromBeforeTheErasure(erasedAt - 1_000, erasedAt)).toBe(true); // the second before
    expect(datesFromBeforeTheErasure(1_800_000_000_000, erasedAt)).toBe(false); // the same second
    expect(datesFromBeforeTheErasure(erasedAt + 2_000, erasedAt)).toBe(false); // the person came back
    expect(datesFromBeforeTheErasure(undefined, erasedAt)).toBe(true); // cannot be dated: old
  });

  it("judges a session's opening to the MILLISECOND: one opened in the call's second, before it, is old", () => {
    const erasedAt = 1_800_000_000_500;
    expect(openedBeforeTheErasure(erasedAt - 200, erasedAt)).toBe(true); // same second, before
    expect(openedBeforeTheErasure(erasedAt, erasedAt)).toBe(false);
    expect(openedBeforeTheErasure(erasedAt + 1, erasedAt)).toBe(false);
  });
});
