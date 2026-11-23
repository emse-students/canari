import { ForbiddenException, Logger } from '@nestjs/common';
import {
  ChannelService,
  COMMUNITY_BOOT_READS_MAX,
  keyGroupVersionOf,
  SALON_KEY_GROUP_READS_CONCURRENCY,
} from './channel.service';

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

  /** A salon row as the repository holds it: only what the reader check and the roster read. */
  type SalonRow = { id: string; workspaceId: string; isPrivate: boolean; allowedUsers: string[] };
  /** A community member row: what the roster derivation reads. */
  type MemberRow = { id: string; userId: string; roleIds: string[]; createdAt: Date };
  /** A community role: what decides a manager's place on a private salon's roster. */
  type RoleRow = { id: string; name: string; priority: number; permissions: string[] };

  /**
   * The service on fake repositories. The salon half runs on REAL rows: the reader selection, the
   * roster derivation and the route `listChannelMembers` are the service's own code, only the
   * community read and chat-delivery's salon reference are stubbed.
   */
  function makeService(db: { salons?: SalonRow[]; members?: MemberRow[]; roles?: RoleRow[] } = {}) {
    const salons = db.salons ?? [];
    const memberRows = db.members ?? [];
    const channelRepo = {
      find: jest.fn().mockResolvedValue(salons),
      findOne: jest.fn(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(salons.find((c) => c.id === id) ?? null)
      ),
    };
    const memberRepo = {
      find: jest.fn().mockResolvedValue(memberRows),
      findOne: jest.fn(({ where: { userId } }: { where: { userId: string } }) =>
        Promise.resolve(memberRows.find((m) => m.userId === userId) ?? null)
      ),
      // The review-cohort query of the real `isChannelReader`: no creator row, so nobody is across.
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    const roleRepo = { find: jest.fn().mockResolvedValue(db.roles ?? []) };
    const service = new ChannelService(
      {} as never,
      channelRepo as never,
      roleRepo as never,
      memberRepo as never,
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
      isChannelReader: (channel: SalonRow, user: string) => Promise<boolean>;
    };
    const salonKeyGroup = jest.spyOn(internals, 'readSalonDistributionGroup');
    return {
      service,
      internals,
      channelRepo,
      memberRepo,
      roleRepo,
      keyGroup,
      members,
      salonKeyGroup,
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
  const salonDb = () => ({
    salons: [
      { id: 's-read', workspaceId: 'a', isPrivate: true, allowedUsers: [USER, 'u2'] },
      { id: 's-not-read', workspaceId: 'a', isPrivate: true, allowedUsers: ['u2'] },
      { id: 's-bare', workspaceId: 'a', isPrivate: true, allowedUsers: [USER] },
    ],
    members: [
      { id: 'm1', userId: USER, roleIds: [], createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'm2', userId: 'u2', roleIds: ['r-mod'], createdAt: new Date('2026-10-02T00:00:00Z') },
      // A manager: on every private salon's roster without being in `allowedUsers`.
      { id: 'm3', userId: 'u3', roleIds: ['r-admin'], createdAt: new Date('2026-10-03T00:00:00Z') },
      // Neither: on no private salon's roster.
      { id: 'm4', userId: 'u4', roleIds: [], createdAt: new Date('2026-10-04T00:00:00Z') },
    ],
    roles: [
      { id: 'r-mod', name: 'Moderator', priority: 50, permissions: [] },
      { id: 'r-admin', name: 'Admin', priority: 100, permissions: ['workspace.manage'] },
    ],
  });
  const communityRef = { groupId: 'g', groupInfo: 'X', baseEpoch: 1, activeEpoch: 1 };
  const salonRef = { groupId: 'gs', groupInfo: 'Y', baseEpoch: 7, activeEpoch: 7 };

  it('carries each private salon this user reads - the real reader predicate leaves the others out', async () => {
    const db = salonDb();
    const { service, internals, keyGroup, members, salonKeyGroup } = makeService(db);
    keyGroup.mockResolvedValue(communityRef);
    members.mockResolvedValue([] as never);
    salonKeyGroup.mockImplementation((channelId) =>
      Promise.resolve(channelId === 's-bare' ? null : salonRef)
    );

    const { items } = await service.listKeyGroupVersions(USER, ['a']);

    // A salon with no key group is left to its full pass, whose route says so.
    expect(items[0].salons.map((s) => s.channelId)).toEqual(['s-read']);
    expect(items[0].salons[0]).toMatchObject({ groupId: 'gs', activeEpoch: 7, baseEpoch: 7 });
    expect(salonKeyGroup).not.toHaveBeenCalledWith('s-not-read', USER);
    // The selection is the route's own: the REAL `isChannelReader` on the same rows.
    const readers: string[] = [];
    for (const salon of db.salons) {
      if (await internals.isChannelReader(salon, USER)) readers.push(salon.id);
    }
    expect(readers).toEqual(['s-read', 's-bare']);
  });

  it('digests exactly what the two salon routes serve - the shared reads cannot drift from them', async () => {
    const { service, keyGroup, members, salonKeyGroup } = makeService(salonDb());
    keyGroup.mockResolvedValue(communityRef);
    members.mockResolvedValue([] as never);
    salonKeyGroup.mockResolvedValue(salonRef);

    const { items } = await service.listKeyGroupVersions(USER, ['a']);
    // What the client's salon pass reads: the reference with no device, the channel roster with no
    // presence - through the route's own method.
    const routeRoster = await service.listChannelMembers('s-read', USER, 'channel');

    expect(routeRoster.map((r) => r.userId)).toEqual([USER, 'u2', 'u3']);
    const version = items[0].salons.find((s) => s.channelId === 's-read')?.version;
    expect(version).toBe(keyGroupVersionOf(salonRef, routeRoster));
  });

  it('reads the community members and roles once, not per salon, and no cohort line per salon', async () => {
    const db = salonDb();
    db.salons = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      workspaceId: 'a',
      isPrivate: true,
      allowedUsers: [USER],
    }));
    const { service, memberRepo, roleRepo, keyGroup, members, salonKeyGroup, warn } =
      makeService(db);
    keyGroup.mockResolvedValue(communityRef);
    members.mockResolvedValue([] as never);
    let inFlight = 0;
    let most = 0;
    salonKeyGroup.mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return salonRef;
    });

    const { items } = await service.listKeyGroupVersions(USER, ['a']);

    expect(items[0].salons).toHaveLength(9);
    expect(memberRepo.find).toHaveBeenCalledTimes(1);
    expect(roleRepo.find).toHaveBeenCalledTimes(1);
    expect(memberRepo.findOne).not.toHaveBeenCalled();
    expect(memberRepo.manager.query).not.toHaveBeenCalled();
    // In parallel, under the bound.
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(SALON_KEY_GROUP_READS_CONCURRENCY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves out a salon whose read failed, says so, and still answers the community', async () => {
    const db = salonDb();
    db.salons = [{ id: 's-down', workspaceId: 'a', isPrivate: true, allowedUsers: [USER] }];
    const { service, keyGroup, members, salonKeyGroup, warn } = makeService(db);
    keyGroup.mockResolvedValue(communityRef);
    members.mockResolvedValue([] as never);
    salonKeyGroup.mockRejectedValue(new Error('delivery down'));

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
