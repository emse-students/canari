// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { adoptBackgroundJoins, takeBackgroundJoined } from './backgroundJoins';
import { isRegisterOwed } from './registerOwed';

/**
 * P2-a of the review of #3777: a conversation the push service joined while the app was shut is
 * owed its register like one the page joined, and its redelivered Welcome is its admission - on the
 * native ledger's word, believed only for a group the loaded state holds.
 */
describe('the conversations joined in the background', () => {
  const mls = { isDistributionGroup: (g: string) => g === 'key-group' };

  beforeEach(() => {
    localStorage.clear();
    for (const g of ['joined', 'not-held', 'key-group']) takeBackgroundJoined(g);
  });

  it('owe their register and are taken as admitted once', () => {
    const lines: string[] = [];
    const result = adoptBackgroundJoins(
      mls,
      'me',
      ['joined'],
      () => true,
      (l) => lines.push(l)
    );

    expect(result).toEqual({ owed: 1, ignored: 0 });
    expect(isRegisterOwed('me', 'joined')).toBe(true);
    expect(takeBackgroundJoined('joined')).toBe(true);
    expect(takeBackgroundJoined('joined')).toBe(false);
  });

  it('a note naming a group the loaded state does not hold is a claim, and the tree wins', () => {
    const lines: string[] = [];
    const result = adoptBackgroundJoins(
      mls,
      'me',
      ['not-held'],
      () => false,
      (l) => lines.push(l)
    );

    expect(result).toEqual({ owed: 0, ignored: 1 });
    expect(isRegisterOwed('me', 'not-held')).toBe(false);
    expect(takeBackgroundJoined('not-held')).toBe(false);
    expect(lines.join(' ')).toContain('NOT in the loaded state');
  });

  it('a key group owes no register', () => {
    const result = adoptBackgroundJoins(
      mls,
      'me',
      ['key-group'],
      () => true,
      () => {}
    );

    expect(result).toEqual({ owed: 0, ignored: 1 });
    expect(isRegisterOwed('me', 'key-group')).toBe(false);
  });
});
