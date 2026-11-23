import { ForbiddenException, Logger } from '@nestjs/common';
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

  function makeService(privateSalons: { id: string }[] = []) {
    const channelRepo = { find: jest.fn().mockResolvedValue(privateSalons) };
    const service = new ChannelService(
      {} as never,
      channelRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // The route's reader without its lines (private): what the route serves, read for a digest.
    const keyGroup = jest.spyOn(
      service as unknown as {
        readMemberDistributionGroup: (ws: string, user: string) => Promise<unknown>;
      },
      'readMemberDistributionGroup'
    );
    const members = jest.spyOn(service, 'listWorkspaceMembers');
    const internals = service as unknown as {
      readSalonDistributionGroup: (channelId: string, user: string) => Promise<unknown>;
      isChannelReader: (channel: { id: string }, user: string) => Promise<boolean>;
    };
    const salonKeyGroup = jest.spyOn(internals, 'readSalonDistributionGroup');
    const reader = jest.spyOn(internals, 'isChannelReader').mockResolvedValue(true);
    const salonMembers = jest.spyOn(service, 'listChannelMembers');
    return {
      service,
      channelRepo,
      keyGroup,
      members,
      salonKeyGroup,
      reader,
      salonMembers,
      warn,
      error,
    };
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
    const { service, keyGroup, members, warn, error } = makeService();
    keyGroup.mockImplementation((ws) =>
      ws === 'left'
        ? Promise.reject(new ForbiddenException('nope'))
        : ws === 'bare'
          ? Promise.resolve(null)
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
    // A community with no key group is NOT said here: the route the full pass then reads says it,
    // once, at error. Only the 403 is warned.
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('workspace=left');
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

  // The salons were what a resume still read once the communities skipped (1.8.0-alpha.1, Mi 9T).
  it('carries each private salon this user reads, with the digest of ITS two answers', async () => {
    const { service, keyGroup, members, salonKeyGroup, reader, salonMembers } = makeService([
      { id: 's-read' },
      { id: 's-not-read' },
      { id: 's-bare' },
    ]);
    keyGroup.mockResolvedValue({ groupId: 'g', groupInfo: 'X', baseEpoch: 1, activeEpoch: 1 });
    members.mockResolvedValue([] as never);
    reader.mockImplementation((channel) => Promise.resolve(channel.id !== 's-not-read'));
    const salonRef = { groupId: 'gs', groupInfo: 'Y', baseEpoch: 7, activeEpoch: 7 };
    salonKeyGroup.mockImplementation((channelId) =>
      Promise.resolve(channelId === 's-bare' ? null : salonRef)
    );
    const salonRoster = [{ id: 'm1', userId: USER, role: 'member', joinedAt: new Date(0) }];
    salonMembers.mockResolvedValue(salonRoster as never);

    const { items } = await service.listKeyGroupVersions(USER, ['a']);

    // Only the salon whose GroupInfo the route would serve; a salon with no key group is left to
    // its full pass, whose route says so.
    expect(items[0].salons).toEqual([
      {
        channelId: 's-read',
        version: keyGroupVersionOf(salonRef, salonRoster),
        groupId: 'gs',
        activeEpoch: 7,
        baseEpoch: 7,
      },
    ]);
    // Read as the salon's pass reads them: no device (no seat), the channel roster, no presence.
    expect(salonKeyGroup).toHaveBeenCalledWith('s-read', USER);
    expect(salonMembers).toHaveBeenCalledWith('s-read', USER, 'channel');
    expect(salonKeyGroup).not.toHaveBeenCalledWith('s-not-read', USER);
  });

  it('leaves out a salon whose read failed, says so, and still answers the community', async () => {
    const { service, keyGroup, members, salonKeyGroup, salonMembers, warn } = makeService([
      { id: 's-down' },
    ]);
    keyGroup.mockResolvedValue({ groupId: 'g', groupInfo: 'X', baseEpoch: 1, activeEpoch: 1 });
    members.mockResolvedValue([] as never);
    salonKeyGroup.mockRejectedValue(new Error('delivery down'));
    salonMembers.mockResolvedValue([] as never);

    const { items } = await service.listKeyGroupVersions(USER, ['a']);

    expect(items[0]).toMatchObject({ version: expect.any(String), refusal: null, salons: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('channel=s-down');
  });

  it('moves a salon version when its roster loses a reader', () => {
    const salonRef = { groupId: 'gs', groupInfo: 'Y', baseEpoch: 7, activeEpoch: 7 };
    const two = [
      { id: 'm1', userId: 'u1' },
      { id: 'm2', userId: 'u2' },
    ];
    expect(keyGroupVersionOf(salonRef, two.slice(0, 1))).not.toBe(keyGroupVersionOf(salonRef, two));
  });
});
