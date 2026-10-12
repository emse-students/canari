import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { workspaceScope } from '$lib/mls-client/distributionScope';
import { distributionEpochFor, readDistributionEpoch } from './seedDistribution';
import { markEpochGap, resetEpochGapRegistry } from '$lib/utils/chat/epochGapRegistry';

/**
 * Which epoch a scope's seeds may be minted against - and, above all, when the answer is NONE.
 *
 * Three states hide behind one lookup, and two of them used to share an answer. A group this
 * device has not joined is invisible; a group it holds and has settled is usable at its epoch; a
 * group it CREATED moments ago is held, answers epoch 0, and may still be discarded for having
 * lost the first-publish race. Reading the third as the second is what left a salon message
 * sealed under a session that died with the group - unreadable for ever, by its author included
 * (COMM rung, 2026-08-27).
 */

const WS = workspaceScope('ws-1');
const GROUP = 'dist-group';

const stub = (overrides: Record<string, unknown> = {}) =>
  createMlsServiceStub({
    distributionGroupFor: vi.fn().mockReturnValue(GROUP),
    getLocalGroups: vi.fn().mockReturnValue([GROUP]),
    getEpoch: vi.fn().mockReturnValue(4),
    ...overrides,
  });

describe('the epoch a scope may mint against', () => {
  it('answers the group epoch once the group is held and its base settled', () => {
    expect(distributionEpochFor(stub(), WS)).toBe(4);
  });

  it('answers null when no group is registered for the scope', () => {
    expect(
      distributionEpochFor(stub({ distributionGroupFor: vi.fn().mockReturnValue(null) }), WS)
    ).toBeNull();
  });

  it('answers null when the group is registered but this device does not hold it', () => {
    expect(
      distributionEpochFor(stub({ getLocalGroups: vi.fn().mockReturnValue([]) }), WS)
    ).toBeNull();
  });

  it('answers null while the group is held but its base is NOT settled yet', () => {
    const mls = stub({ isDistributionBaseSettled: vi.fn().mockReturnValue(false) });

    // Not zero. Zero is a settled group that has committed nothing, and a caller may mint against
    // it; this is a group that may cease to exist, and a caller must wait instead.
    expect(distributionEpochFor(mls, WS)).toBeNull();
  });

  it('distinguishes an unsettled group from a settled one at epoch 0', () => {
    const atZero = { getEpoch: vi.fn().mockReturnValue(0) };

    expect(distributionEpochFor(stub(atZero), WS)).toBe(0);
    expect(
      distributionEpochFor(
        stub({ ...atZero, isDistributionBaseSettled: vi.fn().mockReturnValue(false) }),
        WS
      )
    ).toBeNull();
  });
});

describe('a key group behind its server', () => {
  afterEach(() => resetEpochGapRegistry());

  it('answers null while the group is in an epoch gap - held is not current', () => {
    // Production 2026-09-28: a device at epoch 5 of a key group every member had at 13 sealed
    // there, and not one member could read it.
    markEpochGap(GROUP);

    expect(distributionEpochFor(stub(), WS)).toBeNull();
  });
});

/**
 * WHICH fact is missing, kept rather than folded into one null. The seal's refusal is shown to a
 * member and logged, and on production 2026-10-09 the one sentence it had - "has no distribution
 * group on this device" - was false for the case that actually fired: a group held, whose catch-up
 * gap stood armed.
 */
describe('the reason a scope cannot mint', () => {
  afterEach(() => resetEpochGapRegistry());

  it.each([
    ['key-group-unregistered', { distributionGroupFor: vi.fn().mockReturnValue(null) }],
    ['key-group-not-held', { getLocalGroups: vi.fn().mockReturnValue([]) }],
    ['key-group-unsettled', { isDistributionBaseSettled: vi.fn().mockReturnValue(false) }],
  ] as const)('names %s', (reason, overrides) => {
    expect(readDistributionEpoch(stub(overrides), WS)).toEqual({ unavailable: reason });
  });

  it('names key-group-catching-up while the gap is armed', () => {
    markEpochGap(GROUP);
    expect(readDistributionEpoch(stub(), WS)).toEqual({ unavailable: 'key-group-catching-up' });
  });

  it('answers the epoch when nothing is missing', () => {
    expect(readDistributionEpoch(stub(), WS)).toEqual({ epoch: 4 });
  });
});
