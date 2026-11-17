// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The native ledger, as the two commands edit it. */
const ledger = vi.hoisted(() => ({ groups: [] as string[] }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: { groupId: string }) => {
    if (command === 'forget_background_join') {
      ledger.groups = ledger.groups.filter((g) => g !== args?.groupId);
      return undefined;
    }
    if (command === 'take_background_joins') {
      const taken = ledger.groups;
      ledger.groups = [];
      return taken;
    }
    throw new Error(`unexpected command ${command}`);
  }),
}));

import {
  adoptBackgroundJoins,
  forgetBackgroundJoin,
  takeBackgroundJoined,
  takeBackgroundJoins,
} from './backgroundJoins';
import {
  clearRegisterOwed,
  isRegisterOwed,
  noteRegisterOwed,
  registerNeverTaken,
} from './registerOwed';

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

/**
 * P2-2 of the re-review of #3777: a background note whose install was refused (or erased) while the
 * page installed the same Welcome itself must not re-owe, at the next start, the register the page
 * then took - this device would decline newcomers it can answer.
 */
describe('a background note the page installed over', () => {
  it('is forgotten by the install, so the next start does not owe the register again', async () => {
    localStorage.clear();
    ledger.groups = ['g-stale'];
    // The page installs the Welcome itself (`handleWelcome`): owed, the note forgotten, then taken.
    noteRegisterOwed('me', 'g-stale');
    await forgetBackgroundJoin('g-stale');
    clearRegisterOwed('me', 'g-stale', 'register answer');

    const mls = { isDistributionGroup: () => false, getLocalGroups: () => ['g-stale'] };
    await takeBackgroundJoins(mls as never, 'me', () => {});

    expect(registerNeverTaken('me', 'g-stale')).toBe(false);
    expect(takeBackgroundJoined('g-stale')).toBe(false);
  });
});
