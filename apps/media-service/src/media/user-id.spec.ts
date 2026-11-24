/// <reference types="jest" />

/**
 * media-service's copy of core's account-id rule (`user-id.ts`), read at the account erasure route.
 * The file is core's, byte for byte: `.github/scripts/lib/declared-duplicates.mjs` fails the build
 * when the two copies differ.
 */
import { userIdRuleBroken } from './user-id';

describe('the account-id rule', () => {
  it.each([
    ['', 'empty'],
    [42, 'empty'],
    ['a b', 'not-visible-ascii'],
    [`caf${String.fromCharCode(0xe9)}`, 'not-visible-ascii'],
    ['user:device', 'colon'],
    ['a11ce9f0c4d2b6e8a11ce9f0c4d2b6e8', null],
  ])('%j breaks %s', (id, rule) => {
    expect(userIdRuleBroken(id)).toBe(rule);
  });
});
