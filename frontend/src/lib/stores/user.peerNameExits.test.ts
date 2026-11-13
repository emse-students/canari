// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearUserLocally, saveUserLocally } from './user';
import { openDirectory, notePeerName, readPeerName } from '$lib/utils/users/peerNameDirectory';

/**
 * THE EXITS OF THE PEER-NAME DIRECTORY (slow-link chantier, 2026-11-11): a sign-out and a change of
 * account forget it, in memory, in the same call that ends the feed's stored pages. A switch to the
 * SAME account keeps it.
 */
describe('the peer-name directory and the account exits', () => {
  beforeEach(() => {
    localStorage.clear();
    saveUserLocally({ id: 'alpha' });
    openDirectory('alpha');
    notePeerName('alpha', 'peer-1', 'Alice Martin');
  });

  it('keeps the names when the same account is saved again', () => {
    saveUserLocally({ id: 'alpha' });
    expect(readPeerName('alpha', 'peer-1')).toBe('Alice Martin');
  });

  it('forgets them on a change of account', () => {
    saveUserLocally({ id: 'beta' });
    expect(readPeerName('alpha', 'peer-1')).toBeNull();
  });

  it('forgets them on a sign-out', () => {
    clearUserLocally();
    expect(readPeerName('alpha', 'peer-1')).toBeNull();
  });
});
