import {
  composeSubmission,
  encodeIntent,
  isDefinitiveCommitRefusal,
  resubmissionVerdict,
  type StagedRecord,
} from './commitSubmission';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';
import backgroundWelcomeIntent from './test/fixtures/background-welcome-intent.json';

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

  it('settles an Add the BACKGROUND staged: its Welcome is owed to the device it admits', () => {
    // The intent the Android background Welcome writes beside its staged Add
    // (`settle_background_welcome`'s tests pin the same file on the Rust side). A settle that merges
    // it must name carol in `admits`, or nobody is left to send her the Welcome.
    const intent = new TextEncoder().encode(JSON.stringify(backgroundWelcomeIntent));
    expect(composeSubmission(record(intent, [0]))).toEqual({
      groupId: 'g-fixture',
      baseEpoch: 5,
      commit: 'AQ==',
      groupInfo: 'Ag==',
      excludeDeviceIds: ['carol:dev-c'],
      admits: [{ userId: 'carol', deviceId: 'dev-c' }],
      welcome: 'Aw==',
    });
  });

  it('reads an intent that does not decode as null - unreadable, never absent', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(composeSubmission(record(new TextEncoder().encode('[1]')))).toBeNull();
    expect(composeSubmission(record(new Uint8Array([0xff])))).toBeNull();
    error.mockRestore();
  });
});
