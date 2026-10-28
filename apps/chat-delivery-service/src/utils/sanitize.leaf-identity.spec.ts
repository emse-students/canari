/**
 * A LEAF IDENTITY IS TWO VALUES, AND ITS SPEC USES REAL-LENGTH ONES.
 *
 * `POST mls/groups/:groupId/revoked-leaves` ran the whole `userId:deviceId` through the generic
 * 128-character allowlist. A real identity is 147 (web) or 149 (Tauri) characters, so the route
 * answered 400 to every request it ever received - and its specs, written with `bob:phone-1`, were
 * green throughout. These tests build identities in the CLIENT GENERATOR's own shape, and the last
 * block reads that generator's source, so a change to it fails here rather than in the field.
 */
import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  parseLeafIdentity,
  sanitizeLeafIdentity,
  sanitizeLogValue,
  SAFE_QUERY_VALUE_REGEX,
} from './sanitize';

/** A user id as the estate mints them in practice: a 64-hex digest. */
const USER = 'a3f1c9e07b2d4856a3f1c9e07b2d4856a3f1c9e07b2d4856a3f1c9e07b2d4856';

/**
 * The device id `BaseMlsService.generateDeviceId` builds - `${platform}-${userId}-${time36}-${rand}`
 * - with its two variable parts given, so a test chooses the worst case instead of drawing it.
 */
function deviceIdLike(platform: string, userId: string, nowMs: number, rand = 'zzzz'): string {
  return `${platform}-${userId}-${nowMs.toString(36)}-${rand}`;
}

/** The latest millisecond a JS clock can name: the longest `Date.now().toString(36)` there is. */
const LAST_MS = 8.64e15;

describe('parseLeafIdentity / sanitizeLeafIdentity - real identities', () => {
  it.each(['web', 'tauri'])('accepts a real %s identity, longer than 128 characters', (p) => {
    const identity = `${USER}:${deviceIdLike(p, USER, 1_761_600_000_000)}`;
    // The premise of the defect: the generic allowlist refuses it whole.
    expect(identity.length).toBeGreaterThan(128);
    expect(SAFE_QUERY_VALUE_REGEX.test(identity)).toBe(false);

    expect(sanitizeLeafIdentity(identity, 'identity')).toEqual({
      identity,
      userId: USER,
      deviceId: deviceIdLike(p, USER, 1_761_600_000_000),
    });
  });

  it('accepts the worst case the generator can produce, on the last date a clock can hold', () => {
    const identity = `${USER}:${deviceIdLike('tauri', USER, LAST_MS)}`;
    expect(parseLeafIdentity(identity)?.identity).toBe(identity);
  });

  it('keeps an upper-case user half as sent - the route compares it without case itself', () => {
    const identity = `${USER.toUpperCase()}:${deviceIdLike('web', USER, 1)}`;
    expect(parseLeafIdentity(identity)?.userId).toBe(USER.toUpperCase());
  });

  it('accepts each half at exactly 128 characters - the bound each is stored under', () => {
    const half = 'a'.repeat(128);
    expect(parseLeafIdentity(`${half}:${half}`)).not.toBeNull();
  });
});

describe('parseLeafIdentity / sanitizeLeafIdentity - near misses, one rule each', () => {
  const device = deviceIdLike('web', USER, 1_761_600_000_000);

  it.each([
    ['no colon', `${USER}${device}`],
    // Short enough that only the colon rule can refuse it: a legacy bare leaf.
    ['no colon, a bare user', USER],
    ['two colons', `${USER}:${device}:x`],
    ['an empty user half', `:${device}`],
    ['an empty device half', `${USER}:`],
    ['a user half over 128', `${'a'.repeat(129)}:${device}`],
    ['a device half over 128', `${USER}:${'d'.repeat(129)}`],
    ['a space in the device half', `${USER}:web- 1`],
    ['a newline in the user half', `${USER}\n:${device}`],
    ['a quote in the device half', `${USER}:web-'1`],
    ['a slash in the user half', `a/b:${device}`],
    ['leading whitespace', ` ${USER}:${device}`],
    ['a non-ASCII letter', `${USER}:web-é`],
  ])('refuses %s', (_rule, value) => {
    expect(parseLeafIdentity(value)).toBeNull();
    expect(() => sanitizeLeafIdentity(value, 'identity')).toThrow(BadRequestException);
  });

  it.each([42, null, undefined, {}, [USER]])('refuses a non-string %p', (value) => {
    expect(parseLeafIdentity(value)).toBeNull();
  });

  it('names the field and the shape in the refusal', () => {
    expect(() => sanitizeLeafIdentity('nope', 'identity')).toThrow(
      /identity must be userId:deviceId/
    );
  });
});

describe('sanitizeLogValue - a leaf identity is evidence, not `invalid`', () => {
  it.each(['web', 'tauri'])('prints a real %s identity', (p) => {
    const identity = `${USER}:${deviceIdLike(p, USER, 1_761_600_000_000)}`;
    expect(sanitizeLogValue(identity)).toBe(identity);
  });

  it('still refuses a forged line shaped like an identity', () => {
    expect(sanitizeLogValue(`${USER}:web-1\n[HISTORY] forged`)).toBe('invalid');
    expect(sanitizeLogValue(`${'a'.repeat(129)}:${'b'.repeat(10)}`)).toBe('invalid');
  });
});

/**
 * THE CONTRACT WITH THE GENERATOR. The device id is minted by the client, in one function, and the
 * bound above is derived from its shape: a platform tag, the user id, a base36 time and up to four
 * base36 characters. If that function or its platform tags change, this fails - re-derive the
 * worst case here (and in `parseLeafIdentity`'s doc) before changing the expectation.
 */
describe('the device-id generator this bound is derived from', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../../frontend/src/lib/services/BaseMlsService.ts'),
    'utf8'
  );

  it('is still `${platform}-${userId}-${time36}-${rand4}`', () => {
    const body = source.match(
      /protected generateDeviceId\(userId: string\): string \{([\s\S]*?)\n {2}\}/
    );
    expect(body).not.toBeNull();
    expect((body as RegExpMatchArray)[1].replace(/\s+/g, '')).toBe(
      'return`${this.platform}-${userId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;'
    );
  });

  it('still tags only the platforms the worst case was computed over', () => {
    const union = source.match(/protected readonly platform: ([^;]+);/);
    const tags = [...((union as RegExpMatchArray)[1] ?? '').matchAll(/'([^']+)'/g)].map(
      (m) => m[1]
    );
    expect(tags).toEqual(['web', 'tauri']);
    for (const tag of tags) {
      // The longest tag, on a 64-hex user, on the last date a clock can hold, with a full rand.
      const identity = `${USER}:${deviceIdLike(tag, USER, LAST_MS)}`;
      expect(parseLeafIdentity(identity)).not.toBeNull();
    }
  });
});
