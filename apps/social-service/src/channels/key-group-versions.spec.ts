import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { ChannelService, COMMUNITY_BOOT_READS_MAX, keyGroupVersionOf } from './channel.service';

/**
 * The key-group version (`GET workspaces/key-group-versions`): a digest of the two answers a roster
 * pass reads. What is pinned: equal answers give equal versions whatever order the database returned
 * them in, and every field a pass decides on moves the version - so "unchanged version" may stand
 * for "nothing to learn from the two reads". Then the batch: per-item refusals, the bound.
 */
describe('keyGroupVersionOf', () => {
  const ref = {
    groupId: 'g1',
    groupInfo: 'AAAA',
    baseEpoch: 4,
    activeEpoch: 4,
    memberDevices: ['d2', 'd1'],
  };
  const roster = [
    {
      id: 'm2',
      userId: 'u2',
      role: 'member',
      joinedAt: new Date('2026-11-01T00:00:00Z'),
      isCreator: false,
      admissionVoucher: null,
    },
    {
      id: 'm1',
      userId: 'u1',
      role: 'owner',
      joinedAt: new Date('2026-10-01T00:00:00Z'),
      isCreator: true,
      admissionVoucher: null,
    },
  ];
  const base = keyGroupVersionOf(ref, roster);

  it('is the same for the same answers in another order', () => {
    expect(keyGroupVersionOf({ ...ref, memberDevices: ['d1', 'd2'] }, [...roster].reverse())).toBe(
      base
    );
    // Key order is not content either.
    const reordered = {
      activeEpoch: 4,
      memberDevices: ['d1', 'd2'],
      baseEpoch: 4,
      groupInfo: 'AAAA',
      groupId: 'g1',
    };
    expect(keyGroupVersionOf(reordered, roster)).toBe(base);
  });

  it.each([
    ['the active epoch (a commit on the key group)', { ...ref, activeEpoch: 5 }, roster],
    ['the published base', { ...ref, baseEpoch: 5, groupInfo: 'BBBB' }, roster],
    ['a device of this user evicted', { ...ref, memberDevices: ['d1'] }, roster],
    ['an unasked device roster', { ...ref, memberDevices: undefined }, roster],
    ['a member who left', ref, roster.slice(0, 1)],
    [
      'a member re-admitted (a new membership row)',
      ref,
      [{ ...roster[0], id: 'm3', joinedAt: new Date('2026-11-20T00:00:00Z') }, roster[1]],
    ],
    ['an admission voucher', ref, [{ ...roster[0], admissionVoucher: 'v' }, roster[1]]],
  ])('moves with %s', (_what, changedRef, changedRoster) => {
    expect(keyGroupVersionOf(changedRef, changedRoster)).not.toBe(base);
  });
});

describe('ChannelService.listKeyGroupVersions', () => {
  const USER = 'u1';

  function makeService() {
    const service = new ChannelService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const keyGroup = jest.spyOn(service, 'getDistributionGroupForMember');
    const members = jest.spyOn(service, 'listWorkspaceMembers');
    return { service, keyGroup, members, warn };
  }

  afterEach(() => jest.restoreAllMocks());

  it('answers each community with the digest of the two answers and the numbers the client compares', async () => {
    const { service, keyGroup, members } = makeService();
    keyGroup.mockImplementation((ws) =>
      Promise.resolve({ groupId: `g-${ws}`, groupInfo: 'X', baseEpoch: 2, activeEpoch: 3 })
    );
    members.mockResolvedValue([{ id: 'm1', userId: USER }] as never);

    const { items } = await service.listKeyGroupVersions(USER, ['a', 'b']);

    expect(items.map((i) => i.workspaceId)).toEqual(['a', 'b']);
    expect(items[0]).toMatchObject({ groupId: 'g-a', activeEpoch: 3, baseEpoch: 2, refusal: null });
    expect(items[0].version).toBe(
      keyGroupVersionOf({ groupId: 'g-a', groupInfo: 'X', baseEpoch: 2, activeEpoch: 3 }, [
        { id: 'm1', userId: USER },
      ] as never)
    );
    expect(items[0].version).not.toBe(items[1].version);
    // Read as the pass reads them: no device (no seat), no presence.
    expect(keyGroup).toHaveBeenCalledWith('a', USER);
    expect(members).toHaveBeenCalledWith('a', USER);
  });

  it('carries a refusal on its own item and answers the others', async () => {
    const { service, keyGroup, members } = makeService();
    keyGroup.mockImplementation((ws) =>
      ws === 'left'
        ? Promise.reject(new ForbiddenException('nope'))
        : ws === 'bare'
          ? Promise.reject(new NotFoundException({ code: 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP' }))
          : Promise.resolve({ groupId: 'g', groupInfo: null, baseEpoch: null, activeEpoch: 0 })
    );
    members.mockResolvedValue([] as never);

    const { items } = await service.listKeyGroupVersions(USER, ['ok', 'left', 'bare']);

    const byId = Object.fromEntries(items.map((i) => [i.workspaceId, i]));
    expect(byId.ok.version).toEqual(expect.any(String));
    expect(byId.left).toMatchObject({ version: null, refusal: { status: 403 } });
    expect(byId.bare).toMatchObject({
      version: null,
      refusal: { status: 404, code: 'WORKSPACE_HAS_NO_DISTRIBUTION_GROUP' },
    });
  });

  it('reads a repeated id once and answers no more than the bound', async () => {
    const { service, keyGroup, members } = makeService();
    keyGroup.mockResolvedValue({ groupId: 'g', groupInfo: null, baseEpoch: null, activeEpoch: 0 });
    members.mockResolvedValue([] as never);
    const many = Array.from({ length: COMMUNITY_BOOT_READS_MAX + 5 }, (_, i) => `w${i}`);

    const { items } = await service.listKeyGroupVersions(USER, ['w0', 'w0', ...many]);

    expect(items).toHaveLength(COMMUNITY_BOOT_READS_MAX);
    expect(keyGroup).toHaveBeenCalledTimes(COMMUNITY_BOOT_READS_MAX);
  });
});
