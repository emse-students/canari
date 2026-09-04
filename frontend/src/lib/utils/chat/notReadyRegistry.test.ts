import {
  markGroupNotReady,
  clearGroupNotReady,
  enumerateNotReadyGroups,
  readNotReadySince,
} from './notReadyRegistry';

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

  // THE INSTANT IS EVIDENCE AND HAD NO READER, so these pin the one thing that made it different
  // from a `'1'`: it answers "since when", and a second mark must not move it.
  describe('readNotReadySince', () => {
    it('returns the first instant, and a later mark does not move it', () => {
      markGroupNotReady('user-a', 'g1');
      const first = readNotReadySince('user-a', 'g1');
      expect(first).toBeGreaterThan(0);
      markGroupNotReady('user-a', 'g1');
      expect(readNotReadySince('user-a', 'g1')).toBe(first);
    });

    it('is undefined for an unmarked group and after the marker is cleared', () => {
      expect(readNotReadySince('user-a', 'never')).toBeUndefined();
      markGroupNotReady('user-a', 'g1');
      clearGroupNotReady('user-a', 'g1');
      expect(readNotReadySince('user-a', 'g1')).toBeUndefined();
    });

    // A marker from an older build, or a corrupted one: presence still SELECTS the group, so only
    // the age may be lost. Reading the age as 0 would make it look five decades stale.
    it('loses only the age when the stored value is not a usable instant', () => {
      localStorage.setItem('mls_not_ready_since:user-a:g1', 'not-a-number');
      expect(enumerateNotReadyGroups('user-a')).toEqual(['g1']);
      expect(readNotReadySince('user-a', 'g1')).toBeUndefined();
    });
  });
});
