import {
  decodeSubmission,
  encodeSubmission,
  isDefinitiveCommitRefusal,
  resubmissionVerdict,
  type CommitSubmission,
} from './commitSubmission';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';

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

describe('the submission kept in the MLS state', () => {
  it('round-trips every field, the Welcome included', () => {
    const s: CommitSubmission = {
      groupId: 'g-1',
      baseEpoch: 5,
      commit: 'AQ==',
      groupInfo: 'Ag==',
      admits: [{ userId: 'u-b', deviceId: 'd-b' }],
      excludeDeviceIds: ['u-b:d-b'],
      welcome: 'Aw==',
    };
    expect(decodeSubmission(encodeSubmission(s))).toEqual(s);
  });

  it('reads unreadable bytes as null', () => {
    expect(decodeSubmission(new TextEncoder().encode('[1]'))).toBeNull();
    expect(decodeSubmission(new Uint8Array([0xff]))).toBeNull();
  });
});
