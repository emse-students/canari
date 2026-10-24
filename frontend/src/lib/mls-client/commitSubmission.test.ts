import {
  composeSubmission,
  encodeIntent,
  isDefinitiveCommitRefusal,
  resubmissionVerdict,
  confirmationVerdict,
  mayBeOwnOverlap,
  COMMIT_LOCK_HOLD_BUDGET_MS,
  commitLockHoldEndsAt,
  mayStartCommitRequest,
  type StagedRecord,
} from './commitSubmission';
import { DEADLINE_MS } from '$lib/utils/requestDeadline';
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
    expect(resubmissionVerdict({ accepted: true }, 5)).toBe('accepted');
  });
  it('reads an epoch conflict two or more epochs past the base as refused', () => {
    expect(
      resubmissionVerdict({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 7 }, 5)
    ).toBe('refused');
  });
  it('reads `concurrent_commit` as UNKNOWN - the lock may be held by our own first request', () => {
    expect(resubmissionVerdict({ accepted: false, reason: 'concurrent_commit' }, 5)).toBe(
      'unknown'
    );
  });
  // The server's commit lock lives 5 s, the client waits 30 s: a resubmission can lose the advance
  // to our own first request, still inside its transaction, and read the epoch it made.
  it('reads an epoch conflict at exactly base + 1 as UNKNOWN - our own commit may have made it', () => {
    const answer = { accepted: false, reason: 'epoch_mismatch', currentEpoch: 6 };
    expect(mayBeOwnOverlap(answer, 5)).toBe(true);
    expect(resubmissionVerdict(answer, 5)).toBe('unknown');
  });
});

describe('confirmationVerdict - the resubmission after an overlap-shaped answer', () => {
  it('reads an epoch conflict at base + 1 as REFUSED - it can no longer overlap an advance', () => {
    expect(
      confirmationVerdict({ accepted: false, reason: 'epoch_mismatch', currentEpoch: 6 })
    ).toBe('refused');
  });
  it('reads the duplicate as accepted, and `concurrent_commit` as still unknown', () => {
    expect(confirmationVerdict({ accepted: true })).toBe('accepted');
    expect(confirmationVerdict({ accepted: false, reason: 'concurrent_commit' })).toBe('unknown');
  });
});

describe('the MLS lock-hold budget', () => {
  it('is three write deadlines: a first request, its resubmission, and a confirmation', () => {
    expect(COMMIT_LOCK_HOLD_BUDGET_MS).toBe(3 * DEADLINE_MS.write);
  });
  it('lets a request start only while its whole write deadline fits', () => {
    const ends = commitLockHoldEndsAt(0);
    expect(mayStartCommitRequest(ends, 0)).toBe(true);
    expect(mayStartCommitRequest(ends, ends - DEADLINE_MS.write)).toBe(true);
    expect(mayStartCommitRequest(ends, ends - DEADLINE_MS.write + 1)).toBe(false);
  });
});

describe('composeSubmission - the one spelling of a request, from the record its stage wrote', () => {
  const record = (intent: Uint8Array, addedIndices: number[] = []): StagedRecord => ({
    intent,
    baseEpoch: 5,
    commit: new Uint8Array([1]),
    groupInfo: new Uint8Array([2]),
    welcome: new Uint8Array([3]),
    addedIndices,
  });

  it('carries every field, and admits only the key packages the stage included', () => {
    const intent = encodeIntent({
      groupId: 'g-1',
      self: 'u-a:d-a',
      excludeDeviceIds: ['u-a:d-a', 'u-b:d-b1', 'u-b:d-b2'],
      keyPackageDevices: ['d-b1', 'd-b2'],
    });
    expect(composeSubmission(record(intent, [1]))).toEqual({
      groupId: 'g-1',
      baseEpoch: 5,
      commit: 'AQ==',
      groupInfo: 'Ag==',
      excludeDeviceIds: ['u-a:d-a', 'u-b:d-b1', 'u-b:d-b2'],
      admits: [{ userId: 'u-b', deviceId: 'd-b2' }],
      welcome: 'Aw==',
    });
  });

  it('is the same bytes every time it is asked - a resubmission equals the first request', () => {
    const r = record(encodeIntent({ groupId: 'g-1', self: 'u-a:d-a', removes: [{ userId: 'z' }] }));
    expect(JSON.stringify(composeSubmission(r))).toBe(JSON.stringify(composeSubmission(r)));
  });

  it('reads an intent that does not decode as null - unreadable, never absent', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(composeSubmission(record(new TextEncoder().encode('[1]')))).toBeNull();
    expect(composeSubmission(record(new Uint8Array([0xff])))).toBeNull();
    error.mockRestore();
  });
});
