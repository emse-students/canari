import { markGroupNotReady, clearGroupNotReady, enumerateNotReadyGroups } from './notReadyRegistry';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

describe('notReadyRegistry', () => {
  it('marks a group not-ready, idempotently', () => {
    markGroupNotReady('user-a', 'g1');
    markGroupNotReady('user-a', 'g1');
    expect(enumerateNotReadyGroups('user-a')).toEqual(['g1']);
  });

  it('clears the marker', () => {
    markGroupNotReady('user-a', 'g1');
    clearGroupNotReady('user-a', 'g1');
    expect(enumerateNotReadyGroups('user-a')).toEqual([]);
  });

  it('enumerates only the current user groups, decoded back to bare groupIds', () => {
    markGroupNotReady('user-a', 'g1');
    markGroupNotReady('user-a', 'g2');
    markGroupNotReady('user-b', 'g3'); // other user - must be excluded

    const groups = enumerateNotReadyGroups('user-a').sort();
    expect(groups).toEqual(['g1', 'g2']);
    expect(enumerateNotReadyGroups('user-b')).toEqual(['g3']);
  });

  it('returns an empty list when nothing is marked', () => {
    expect(enumerateNotReadyGroups('user-a')).toEqual([]);
  });
});
