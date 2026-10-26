// @vitest-environment happy-dom
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { claimAddLockMarkers, clearAddLockMarker, markAddLock } from './addLockMarkers';

const U = 'user-1';
const G = 'group-1';

/**
 * ONE MARKER PER ACQUISITION: an owed release put back after a concurrent acquire marked its own
 * token must not erase that token - with one slot per group it did, and that acquisition's lost
 * release then waited out the whole TTL.
 */
describe('addLockMarkers', () => {
  beforeEach(() => localStorage.clear());

  it('a put-back lands BESIDE an acquisition marked meanwhile, never over it', () => {
    markAddLock(U, G, 't1');
    const owed = claimAddLockMarkers(U, G); // an acquire claims t1 and sends its release...
    markAddLock(U, G, 't2'); // ...a concurrent acquire is granted t2...
    markAddLock(U, G, owed[0].token); // ...and the unanswered t1 is put back.
    expect(claimAddLockMarkers(U, G)).toEqual([{ token: 't2' }, { token: 't1' }]);
  });

  it('a claim takes every marker of the group at once, and only that group', () => {
    markAddLock(U, G, 't1');
    markAddLock(U, G, 't2');
    markAddLock(U, 'other', 't3');
    expect(claimAddLockMarkers(U, G)).toEqual([{ token: 't1' }, { token: 't2' }]);
    expect(claimAddLockMarkers(U, G)).toEqual([]);
    expect(claimAddLockMarkers(U, 'other')).toEqual([{ token: 't3' }]);
  });

  it('an answered release clears its own marker and no other', () => {
    markAddLock(U, G, 't1');
    markAddLock(U, G, 't2');
    clearAddLockMarker(U, G, 't1');
    expect(claimAddLockMarkers(U, G)).toEqual([{ token: 't2' }]);
  });

  it('marks one acquisition once, and keeps a token-less one (a server that returned none)', () => {
    markAddLock(U, G, 't1');
    markAddLock(U, G, 't1');
    markAddLock(U, G, undefined);
    expect(claimAddLockMarkers(U, G)).toEqual([{ token: 't1' }, {}]);
  });

  it('reads the one-marker-per-group shape an earlier build wrote', () => {
    localStorage.setItem(ACCOUNT_KEY.addLockMarkers(U), JSON.stringify({ [G]: { token: 'old' } }));
    expect(claimAddLockMarkers(U, G)).toEqual([{ token: 'old' }]);
  });

  it('the last marker cleared removes the stored entry', () => {
    markAddLock(U, G, 't1');
    clearAddLockMarker(U, G, 't1');
    expect(localStorage.getItem(ACCOUNT_KEY.addLockMarkers(U))).toBeNull();
  });
});
