/// <reference types="jest" />

import { COMMUNITY_OWNED_MAX_DEFAULT, communityOwnedMax } from './community-limits';

describe('communityOwnedMax', () => {
  it('is twenty when nothing is set', () => {
    expect(COMMUNITY_OWNED_MAX_DEFAULT).toBe(20);
    expect(communityOwnedMax(undefined)).toBe(20);
    expect(communityOwnedMax('  ')).toBe(20);
  });

  it('reads a positive integer', () => {
    expect(communityOwnedMax('5')).toBe(5);
  });

  it.each(['0', '-3', '2.5', 'twenty', 'Infinity'])(
    'stops the boot on %p rather than meaning no limit',
    (bad) => {
      expect(() => communityOwnedMax(bad)).toThrow(/COMMUNITY_OWNED_MAX/);
    }
  );
});
