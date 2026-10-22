import {
  forgetUnresolvedCommit,
  isDefinitiveCommitRefusal,
  readUnresolvedCommits,
  recordUnresolvedCommit,
  resubmissionVerdict,
  unresolvedCommitFor,
} from './unresolvedCommits';
import { ACCOUNT_KEY, accountLocalStorageKeysIn } from '$lib/utils/accountLocalKeys';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';

const U = 'user-a';
const D = 'web-a';

beforeEach(() => localStorage.clear());

describe('isDefinitiveCommitRefusal - did the gate answer, and refuse?', () => {
  it.each([
    ['a 400 (malformed)', new ApiRefusalError(400, null, 'x'), true],
    ['a 403 (committer not allowed)', new ApiRefusalError(403, null, 'x'), true],
    ['a 429 (rate limited)', new ApiRefusalError(429, null, 'x'), true],
    // The advance may have committed before the failure that produced these.
    ['a 500', new ApiRefusalError(500, null, 'x'), false],
    ['a 502 from the edge', new ApiRefusalError(502, null, 'x'), false],
    ['a transport failure', new TransportFailureError('offline'), false],
    ['a programming error', new TypeError('x is undefined'), false],
  ] as const)('%s', (_n, error, definitive) => {
    expect(isDefinitiveCommitRefusal(error)).toBe(definitive);
  });
});

describe('resubmissionVerdict', () => {
  it('reads an accept, first or duplicate, as accepted', () => {
    expect(resubmissionVerdict({ accepted: true })).toBe('accepted');
  });
  it('reads an epoch conflict as refused', () => {
    expect(resubmissionVerdict({ accepted: false, reason: 'epoch_mismatch' })).toBe('refused');
  });
  it('reads `concurrent_commit` as UNKNOWN - the lock may be held by our own first request', () => {
    expect(resubmissionVerdict({ accepted: false, reason: 'concurrent_commit' })).toBe('unknown');
  });
});

describe('the unresolved-commit record', () => {
  const rec = { groupId: 'g-1', baseEpoch: 5, commit: 'AQ==', groupInfo: 'Ag==', at: 1 };

  it('round-trips per group and is forgotten per group', () => {
    expect(recordUnresolvedCommit(U, D, rec)).toBe(true);
    recordUnresolvedCommit(U, D, { ...rec, groupId: 'g-2' });
    expect(unresolvedCommitFor(U, D, 'g-1')).toEqual(rec);
    forgetUnresolvedCommit(U, D, 'g-1', 'test');
    expect(Object.keys(readUnresolvedCommits(U, D))).toEqual(['g-2']);
    forgetUnresolvedCommit(U, D, 'g-2', 'test');
    expect(localStorage.getItem(ACCOUNT_KEY.unresolvedCommits(U, D))).toBeNull();
  });

  it('reads an unreadable record as empty', () => {
    localStorage.setItem(ACCOUNT_KEY.unresolvedCommits(U, D), '[1]');
    expect(readUnresolvedCommits(U, D)).toEqual({});
  });

  it('is one of the keys an account deletion sweeps', () => {
    recordUnresolvedCommit(U, D, rec);
    expect(accountLocalStorageKeysIn(localStorage, U)).toContain(
      ACCOUNT_KEY.unresolvedCommits(U, D)
    );
  });
});
