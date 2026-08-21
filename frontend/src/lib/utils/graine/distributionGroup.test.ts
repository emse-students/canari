import { ensureCommunityDistributionGroup } from './distributionGroup';
import { ChannelApiError } from '$lib/services/ChannelService';
import { workspaceScope } from '$lib/mls-client/distributionScope';

const reconcile = vi.fn().mockResolvedValue([]);
vi.mock('./rosterReconcile', () => ({
  reconcileDistributionGroupRoster: (...args: unknown[]) => reconcile(...args),
}));

beforeEach(() => reconcile.mockClear());

/**
 * The seam between the two services, on the client.
 *
 * What matters here is that the three ways this can fail stay three: a community with no
 * distribution group at all (a server-side gap somebody has to fix), a refusal (this user is not a
 * member any more), and transport. They are told apart by the server's `code`, never by the
 * sentence in the message - a distinction carried in prose is one exactly one call site ever makes.
 */

function makeMls(overrides: Record<string, unknown> = {}) {
  return {
    distributionGroupFor: vi.fn().mockReturnValue(null),
    getLocalGroups: vi.fn().mockReturnValue([]),
    ensureDistributionGroup: vi.fn().mockResolvedValue(true),
    forgetDistributionGroup: vi.fn().mockReturnValue('g-1'),
    forgetDistributionGroupById: vi.fn().mockReturnValue(true),
    registerDistributionGroup: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue('dev-me'),
    ...overrides,
  };
}

/** A device that holds the group locally - the state a re-grant used to strand for ever. */
function makeHeldMls(overrides: Record<string, unknown> = {}) {
  return makeMls({
    distributionGroupFor: vi.fn().mockReturnValue('g-1'),
    getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    ...overrides,
  });
}

function makeChannels(overrides: Record<string, unknown> = {}) {
  return {
    getDistributionGroup: vi
      .fn()
      .mockResolvedValue({ groupId: 'g-1', groupInfo: 'c29j', baseEpoch: 7 }),
    ...overrides,
  };
}

const run = (mls: unknown, channels: unknown, log: (m: string) => void = () => {}) =>
  ensureCommunityDistributionGroup(mls as never, channels as never, 'ws-1', log);

describe('ensureCommunityDistributionGroup', () => {
  it('re-joins nothing when the group is held AND the server routes to this device', async () => {
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: 7,
        memberDevices: ['dev-me'],
      }),
    });

    expect(await run(mls, channels)).toBe(true);
    // Held is a MEMORY of having joined; the rows are the fact. Asking is what tells them apart, so
    // the ask happens on this branch too - it just changes nothing when the two agree.
    expect(channels.getDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'));
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
  });

  it('records the scope-group pair on the branch that joins nothing', async () => {
    // The join used to be the only thing that registered it, and the join is reached only when one
    // is owed - so a device holding the group with a registration that did not name it returned
    // true while every scope-keyed reader saw nothing. Measured on production 2026-08-21 as
    // `no distribution group held for ... - roster not reconciled`, on every community, every load.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: null,
        baseEpoch: 7,
        memberDevices: ['dev-me'],
      }),
    });

    expect(await run(mls, channels)).toBe(true);
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
    expect(mls.registerDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), 'g-1');
  });

  it('re-joins when the group is registered but no longer held locally', async () => {
    const mls = makeMls({ distributionGroupFor: vi.fn().mockReturnValue('g-1') });
    const channels = makeChannels();

    expect(await run(mls, channels)).toBe(true);
    expect(channels.getDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'));
    expect(mls.ensureDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), {
      groupId: 'g-1',
      groupInfo: 'c29j',
      baseEpoch: 7,
    });
  });

  it('names a community that has no distribution group at all', async () => {
    const log = vi.fn();
    const channels = makeChannels({
      getDistributionGroup: vi
        .fn()
        .mockRejectedValue(
          new ChannelApiError(404, 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP', 'no group')
        ),
    });
    const mls = makeMls();

    expect(await run(mls, channels, log)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toMatch(/NO distribution group/);
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
  });

  it('reports a refusal and a transport failure differently from that', async () => {
    const log = vi.fn();
    const channels = makeChannels({
      getDistributionGroup: vi
        .fn()
        .mockRejectedValue(new ChannelApiError(403, null, 'Not a member of this workspace')),
    });

    expect(await run(makeMls(), channels, log)).toBe(false);
    // Not the "no group" line: this community has one and this user may not have it.
    expect(log.mock.calls.flat().join(' ')).toMatch(/could not read/);
  });

  it('reports a join that failed, rather than returning success', async () => {
    const log = vi.fn();
    const mls = makeMls({ ensureDistributionGroup: vi.fn().mockResolvedValue(false) });

    expect(await run(mls, makeChannels(), log)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toMatch(/could not join/);
  });
});

/**
 * WP-REGRANT-1, measured on production 2026-08-21: a member removed from a private salon and then
 * let back in was never routed again. The eviction deletes the delivery rows at once while the MLS
 * removal is committed later by a remaining member - published to a group the leaver is no longer
 * routed from - so the leaver never learns it was removed and keeps a live local group for ever.
 * Held-therefore-member then took the early return on every subsequent load, and the join, which is
 * the ONLY writer of delivery rows, never ran again.
 */
describe('ensureCommunityDistributionGroup - a held group the server routes nothing to', () => {
  const heldButUnrouted = () =>
    makeChannels({
      getDistributionGroup: vi
        .fn()
        .mockResolvedValue({ groupId: 'g-1', groupInfo: 'c29j', baseEpoch: 7, memberDevices: [] }),
    });

  it('forgets it and re-joins, so the rows are written back', async () => {
    const mls = makeHeldMls();

    expect(await run(mls, heldButUnrouted())).toBe(true);
    // In this order, and the order is the fix: `ensureDistributionGroup` returns early on a group
    // it already holds, so re-joining without forgetting first would be a no-op.
    // BY GROUP ID: the scope registration is the layer that may be wrong, and resolving through it
    // would forget nothing and leave the join to early-return on the tree it left standing.
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-1');
    expect(mls.ensureDistributionGroup).toHaveBeenCalledWith(workspaceScope('ws-1'), {
      groupId: 'g-1',
      groupInfo: 'c29j',
      baseEpoch: 7,
      memberDevices: [],
    });
  });

  it('accuses, because a repair with no report is a defect nobody counts', async () => {
    const log = vi.fn();

    expect(await run(makeHeldMls(), heldButUnrouted(), log)).toBe(true);
    expect(log.mock.calls.flat().join(' ')).toMatch(/holds NO row for it/);
  });

  it('keeps another device of the same user from counting as this one', async () => {
    // The server answers with THIS user's devices in the group. A second, still-routed device of
    // the same user says nothing about whether this one is routed.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockResolvedValue({
        groupId: 'g-1',
        groupInfo: 'c29j',
        baseEpoch: 7,
        memberDevices: ['dev-other'],
      }),
    });

    expect(await run(mls, channels)).toBe(true);
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-1');
  });

  it('changes nothing when the server did not answer the question, and SAYS so', async () => {
    // `undefined` is "nobody asked" and never "no devices" - an older server, or a caller that did
    // not pass the reader. Reading it as an eviction would forget a healthy group on every load.
    // Unchanged is not the same as unremarked: without the line, "the roster agreed" and "nobody
    // asked" reach a run log looking identical, which is how the first version of this fix shipped
    // and measured as a no-op on production.
    const mls = makeHeldMls();
    const log = vi.fn();

    expect(await run(mls, makeChannels(), log)).toBe(true);
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(mls.ensureDistributionGroup).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/named no devices for this user/);
  });

  it('checks the group the SERVER names, not the one the scope registration remembers', async () => {
    // The registration is a second copy of the same fact and it can lag. Here it names nothing at
    // all while the tree is held - the exact state that made the first version of this fix a no-op
    // on production, because it read `distributionGroupFor(scope)` and concluded "not held", while
    // `ensureDistributionGroup` early-returns on the GROUP ID and concluded "already in".
    const mls = makeMls({
      distributionGroupFor: vi.fn().mockReturnValue(null),
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    });

    expect(await run(mls, heldButUnrouted())).toBe(true);
    expect(mls.forgetDistributionGroupById).toHaveBeenCalledWith('g-1');
    expect(mls.ensureDistributionGroup).toHaveBeenCalled();
  });

  it('keeps a held group when the read itself failed', async () => {
    // A transport failure is not the server saying this device is out. The fetch used to happen
    // only when the group was NOT held, so it could never break a healthy load; now that it always
    // happens, a throw has to leave that path exactly as it was.
    const mls = makeHeldMls();
    const channels = makeChannels({
      getDistributionGroup: vi.fn().mockRejectedValue(new Error('network')),
    });
    const log = vi.fn();

    expect(await run(mls, channels, log)).toBe(true);
    expect(mls.forgetDistributionGroupById).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/keeping the one this device holds/);
  });
});

describe('ensureCommunityDistributionGroup - reconciling the tree with the roster', () => {
  it('reconciles on the branch that was already in the group', async () => {
    const mls = makeMls({
      distributionGroupFor: vi.fn().mockReturnValue('g-1'),
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    });

    expect(await run(mls, makeChannels())).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles on the branch that has just joined', async () => {
    // The device that just joined can carry a departure as well as one that has been in the group
    // for a week; a pass that only ran on the other branch would leave a community whose members
    // all reconnect fresh with a tree nobody ever prunes.
    expect(await run(makeMls(), makeChannels())).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reconciles nothing when the group could not be joined', async () => {
    const mls = makeMls({ ensureDistributionGroup: vi.fn().mockResolvedValue(false) });

    expect(await run(mls, makeChannels())).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('still loads the community when the reconciliation fails', async () => {
    // A tree still holding a departed leaf works for every message from now on, badly. Refusing to
    // load the community over it would only mean nobody ever prunes it.
    reconcile.mockRejectedValueOnce(new Error('commit rejected'));
    const lines: string[] = [];

    expect(await run(makeMls(), makeChannels(), (m) => lines.push(m))).toBe(true);
    expect(lines.some((l) => l.includes('roster reconciliation failed'))).toBe(true);
  });
});
