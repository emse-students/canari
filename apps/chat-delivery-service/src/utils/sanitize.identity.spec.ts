/**
 * AN IDENTITY IS AN ALLOWLIST, NOT A SHAPE - the server half of the placeholder that became a member.
 *
 * On 2026-08-27 this service stored `userId = 'unknown'`, `deviceId = 'pending'` as an ACTIVE
 * member of a real conversation. Both literals are the CLIENT's own "not resolved yet" values, both
 * pass `SAFE_QUERY_VALUE_REGEX` perfectly, and the addressability gate that exists for exactly this
 * class of ghost (WP-GHOST-1) passed too - because the placeholder had registered a KeyPackage
 * under the same pair, which is all that gate reads.
 *
 * So the only thing separating a member from a non-identity on a WRITING path is the value itself,
 * and these are the tests that say so. The pairing with the client is deliberate and must stay:
 * `BaseMlsService.unresolvedIdentity.test.ts` asserts the sender never emits them, this file
 * asserts the receiver never stores them, and neither is allowed to be the only one - a client of
 * any version reaches this endpoint.
 */
import { BadRequestException } from '@nestjs/common';
import { sanitizeIdentityValue, sanitizeQueryValue, UNRESOLVED_IDENTITY_VALUES } from './sanitize';

describe('sanitizeIdentityValue', () => {
  it.each([...UNRESOLVED_IDENTITY_VALUES])(
    'refuses the client placeholder %p, which the shape allowlist accepts',
    (placeholder) => {
      // The premise of the whole guard: the generic sanitizer is happy with it.
      expect(sanitizeQueryValue(placeholder, 'deviceId')).toBe(placeholder);

      expect(() => sanitizeIdentityValue(placeholder, 'deviceId')).toThrow(BadRequestException);
    }
  );

  it('names the field and quotes the value, so the log accuses a caller and not a shape', () => {
    expect(() => sanitizeIdentityValue('unknown', 'userId')).toThrow(
      /userId .*placeholder \('unknown'\)/
    );
  });

  it('refuses the placeholder after trimming - whitespace must not buy a way through', () => {
    expect(() => sanitizeIdentityValue('  pending  ', 'deviceId')).toThrow(BadRequestException);
  });

  it('accepts a real identifier unchanged, trimmed exactly as the generic sanitizer does', () => {
    const real = 'web-8b8abb7a7d95e9c9813b89a3c131f953-mqgfwnmi-q62s';
    expect(sanitizeIdentityValue(` ${real} `, 'deviceId')).toBe(real);
  });

  it('accepts an identifier that merely CONTAINS a placeholder word', () => {
    // The check is equality, never a substring: a device id may legitimately carry the word, and a
    // substring test would refuse a real member - the opposite failure, and a silent one.
    expect(sanitizeIdentityValue('web-pending-42', 'deviceId')).toBe('web-pending-42');
    expect(sanitizeIdentityValue('unknown-user-7', 'userId')).toBe('unknown-user-7');
  });

  it('still refuses what the shape allowlist refuses - it is a narrowing, not a replacement', () => {
    expect(() => sanitizeIdentityValue('', 'userId')).toThrow(BadRequestException);
    expect(() => sanitizeIdentityValue('a/b', 'userId')).toThrow(BadRequestException);
    expect(() => sanitizeIdentityValue(undefined, 'userId')).toThrow(BadRequestException);
  });
});
