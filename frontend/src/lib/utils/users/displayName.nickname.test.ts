// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
  m: { user_unknown_label: () => 'Utilisateur inconnu', user_deleted_label: () => 'Supprime' },
}));
vi.mock('$lib/stores/user', async () => {
  const actual = await vi.importActual<typeof import('$lib/stores/user')>('$lib/stores/user');
  return {
    ...actual,
    currentUserId: vi.fn(() => null),
    getSavedDisplayName: vi.fn(() => null),
    fetchUserProfile: vi.fn(),
  };
});
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'viewer' }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import {
  getUserDisplayNameSync,
  getUserFirstNameSync,
  notificationSenderName,
  seedUserDisplayName,
} from './displayName';
import { applyNickname, resetConversationNicknamesForTests } from './conversationNicknames.svelte';

/**
 * THE RESOLVER IS THE ONE DOOR A NICKNAME HAS. With the conversation's scope it overrides the
 * profile name; without one - a profile, a picker, and above all a NOTIFICATION - it does not exist.
 */
describe('a nickname enters the name resolver through its scope only', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConversationNicknamesForTests();
    seedUserDisplayName('bob', 'Bob Martin', 'Bob');
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 1 });
  });

  it('overrides the full and the first name inside its conversation', () => {
    expect(getUserDisplayNameSync('bob', undefined, 'g1')).toBe('Capitaine');
    expect(getUserFirstNameSync('bob', 'bob', 'g1')).toBe('Capitaine');
  });

  it('is absent outside it, and without a scope', () => {
    expect(getUserDisplayNameSync('bob', undefined, 'g2')).toBe('Bob Martin');
    expect(getUserDisplayNameSync('bob')).toBe('Bob Martin');
    expect(getUserFirstNameSync('bob', 'bob')).toBe('Bob');
  });

  it('never reaches a notification - the push path names the profile', () => {
    expect(
      notificationSenderName('bob', { name: 'g1', contactName: '', conversationType: 'group' })
    ).toBe('Bob Martin');
  });
});
