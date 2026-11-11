// @vitest-environment happy-dom
/**
 * A row is named from the device's own directory BEFORE any profile round trip (slow-link chantier,
 * 2026-11-11): the first frame of a cold start on a 250 kbps link must not read "Utilisateur inconnu".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'me',
  fetchUserProfile: vi.fn(() => new Promise(() => {})),
  getSavedDisplayName: () => null,
  isAbsentUserError: () => false,
  isDeletedAccountError: () => false,
}));
vi.mock('$lib/paraglide/messages', () => ({
  m: { user_unknown_label: () => 'Utilisateur inconnu', user_deleted_label: () => 'Supprime' },
}));

import { notePeerName, clearPeerNames } from './peerNameDirectory';
import { getUserDisplayNameSync, peekUserDisplayName } from './displayName';
import * as userStore from '$lib/stores/user';

describe('display name, local source first', () => {
  beforeEach(() => {
    clearPeerNames();
    vi.mocked(userStore.fetchUserProfile).mockClear();
  });

  it('names a peer from the directory with zero round trip', () => {
    notePeerName('me', 'peer-9', 'Alice Martin');
    expect(peekUserDisplayName('peer-9')).toBe('Alice Martin');
    expect(getUserDisplayNameSync('peer-9')).toBe('Alice Martin');
    expect(userStore.fetchUserProfile).not.toHaveBeenCalled();
  });

  it('prefers the remembered name to a caller fallback and to the placeholder', () => {
    expect(getUserDisplayNameSync('peer-8', 'fb')).toBe('fb');
    expect(getUserDisplayNameSync('peer-7')).toBe('Utilisateur inconnu');
    notePeerName('me', 'peer-8', 'Bob Durand');
    expect(getUserDisplayNameSync('peer-8', 'fb')).toBe('Bob Durand');
  });
});
