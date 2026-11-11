// @vitest-environment happy-dom
/**
 * A row is named from the device's own directory BEFORE any profile round trip (slow-link chantier,
 * 2026-11-11): the first frame of a cold start on a 250 kbps link must not read "Utilisateur inconnu".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const absent = vi.hoisted(() => ({ answer: false }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'me',
  fetchUserProfile: vi.fn(() => new Promise(() => {})),
  getSavedDisplayName: () => null,
  isAbsentUserError: () => absent.answer,
  isDeletedAccountError: () => absent.answer,
}));
vi.mock('$lib/paraglide/messages', () => ({
  m: { user_unknown_label: () => 'Utilisateur inconnu', user_deleted_label: () => 'Supprime' },
}));

import { notePeerName, openDirectory, forgetPeerNames, readPeerName } from './peerNameDirectory';
import { getUserDisplayNameSync, peekUserDisplayName, resolveUserDisplayName } from './displayName';
import * as userStore from '$lib/stores/user';

describe('display name, local source first', () => {
  beforeEach(() => {
    forgetPeerNames();
    openDirectory('me');
    vi.mocked(userStore.fetchUserProfile).mockClear();
  });

  it('names a peer from the directory with zero round trip', () => {
    notePeerName('me', 'peer-9', 'Alice Martin');
    expect(peekUserDisplayName('peer-9')).toBe('Alice Martin');
    expect(getUserDisplayNameSync('peer-9')).toBe('Alice Martin');
    expect(userStore.fetchUserProfile).not.toHaveBeenCalled();
  });

  it('forgets a name from the directory when the server answers the account is gone', async () => {
    notePeerName('me', 'peer-gone', 'Old Name');
    expect(peekUserDisplayName('peer-gone')).toBe('Old Name');
    absent.answer = true;
    vi.mocked(userStore.fetchUserProfile).mockRejectedValueOnce(new Error('404'));
    await resolveUserDisplayName('peer-gone');
    absent.answer = false;
    expect(readPeerName('me', 'peer-gone')).toBeNull();
  });

  it('prefers the remembered name to a caller fallback and to the placeholder', () => {
    expect(getUserDisplayNameSync('peer-8', 'fb')).toBe('fb');
    expect(getUserDisplayNameSync('peer-7')).toBe('Utilisateur inconnu');
    notePeerName('me', 'peer-8', 'Bob Durand');
    expect(getUserDisplayNameSync('peer-8', 'fb')).toBe('Bob Durand');
  });
});
