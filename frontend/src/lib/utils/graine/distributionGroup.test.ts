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
    ...overrides,
  };
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
  it('asks nobody when the group is already registered and held', async () => {
    const mls = makeMls({
      distributionGroupFor: vi.fn().mockReturnValue('g-1'),
      getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    });
    const channels = makeChannels();

    expect(await run(mls, channels)).toBe(true);
    // The early return is derived from state that already exists rather than from a "done" flag,
    // so a state reload that dropped the group re-joins instead of being lied to.
    expect(channels.getDistributionGroup).not.toHaveBeenCalled();
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
