import { describe, it, expect, beforeEach } from 'vitest';
import {
  markGroupNotReady,
  clearGroupNotReady,
  groupNotReadyForMs,
  enumerateNotReadyGroups,
} from './rebootDeadline';

beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

describe('rebootDeadline registry', () => {
  it('marks a group not-ready and reports elapsed time, idempotently keeping the earliest instant', () => {
    markGroupNotReady('user-a', 'g1');
    const first = groupNotReadyForMs('user-a', 'g1');
    expect(first).not.toBeNull();
    // A second mark must not reset the wall-clock deadline.
    markGroupNotReady('user-a', 'g1');
    expect(groupNotReadyForMs('user-a', 'g1')).toBeGreaterThanOrEqual(first as number);
  });

  it('clears the marker', () => {
    markGroupNotReady('user-a', 'g1');
    clearGroupNotReady('user-a', 'g1');
    expect(groupNotReadyForMs('user-a', 'g1')).toBeNull();
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
