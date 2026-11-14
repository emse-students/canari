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
 * THE RESOLVER IS THE ONE DOOR A NICKNAME HAS. With the conversation's scope - the conversation on
 * screen, or the one a notification is about - it overrides the profile name; without one (a
 * profile, a picker) it does not exist.
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

  // Owner, 2026-11-14 ("comme sur Messenger, tous les pseudos"), reversing 2026-11-08.
  it('names the sender of a notification about ITS conversation, and of no other', () => {
    const group = { name: 'g1', contactName: '', conversationType: 'group' as const };
    expect(notificationSenderName('bob', 'g1', group)).toBe('Capitaine');
    expect(notificationSenderName('bob', 'g2', group)).toBe('Bob Martin');
  });
});
