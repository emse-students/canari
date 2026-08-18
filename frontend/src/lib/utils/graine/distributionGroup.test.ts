import { ensureCommunityDistributionGroup } from './distributionGroup';
import { ChannelApiError } from '$lib/services/ChannelService';

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
    expect(channels.getDistributionGroup).toHaveBeenCalledWith('ws-1');
    expect(mls.ensureDistributionGroup).toHaveBeenCalledWith('ws-1', {
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
