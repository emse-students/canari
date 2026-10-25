import { ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import {
  CHANNEL_ACCESS_CHANGED,
  ChannelService,
  DEPARTURE_SUPERSEDED,
  isTransientFailure,
} from './channel.service';
import { fakeDepartureManager } from './departure-transaction.fake-spec';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import {
  CHANNEL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_MODERATOR_PERMISSIONS,
} from './permissions';

/**
 * REMOVALS ARE BOUNDED BY THE ACTOR'S OWN PERMISSIONS.
 *
 * Removing a member from the community (`kickFromWorkspace`) or from a private salon
 * (`removeMemberFromChannel`), taking a salon from members by rewriting its access list
 * (`updateChannelAccess`), and creating a salon private (`createChannel`) ask `member.kick`,
 * `channel.manage` or `workspace.manage` of the actor, and then - the same bound every role change
 * asks (`permissionsCover`) - that each target's roles grant nothing the actor does not hold.
 * `workspace.manage` holds everything.
 */
describe('removals bounded by the actor', () => {
  const WS = 'ws-1';
  const SALON = 'salon-1';
  const P = CHANNEL_PERMISSIONS;

  function makeService(
    salon: { isPrivate: boolean; allowedUsers?: string[] } = { isPrivate: true }
  ) {
    const roles = [
      {
        id: 'r-admin',
        name: 'Administrateur',
        priority: 100,
        permissions: DEFAULT_ADMIN_PERMISSIONS,
      },
      { id: 'r-mod', name: 'Modérateur', priority: 50, permissions: DEFAULT_MODERATOR_PERMISSIONS },
      { id: 'r-salons', name: 'Salons', priority: 30, permissions: [P.MANAGE_CHANNEL] },
      { id: 'r-member', name: 'Membre', priority: 10, permissions: [] },
    ].map((r) => ({ ...r, workspaceId: WS })) as ChannelRole[];
    const members = [
      { userId: 'u-admin', roleIds: ['r-admin'] },
      { userId: 'u-admin-2', roleIds: ['r-admin'] },
      { userId: 'u-mod', roleIds: ['r-mod'] },
      { userId: 'u-mod-2', roleIds: ['r-mod'] },
      { userId: 'u-salons', roleIds: ['r-salons'] },
      { userId: 'u-member', roleIds: ['r-member'] },
    ].map((m) => ({ ...m, workspaceId: WS })) as ChannelMember[];

    const workspaceRepo = { findOne: jest.fn().mockResolvedValue({ id: WS, slug: 'ws' }) };
    // ONE row, mutated by every save, so a sequence of edits reads its own previous result.
    const channel = {
      id: SALON,
      workspaceId: WS,
      name: 'prive',
      isPrivate: salon.isPrivate,
      allowedUsers: salon.allowedUsers ?? (salon.isPrivate ? members.map((m) => m.userId) : []),
      accessRevision: 0,
    };
    const channelRepo = {
      findOne: jest.fn(() =>
        Promise.resolve({ ...channel, allowedUsers: [...channel.allowedUsers] })
      ),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn((c: typeof channel) => {
        Object.assign(channel, c);
        return Promise.resolve(c);
      }),
      create: jest.fn((c: object) => ({ ...c })),
      maximum: jest.fn().mockResolvedValue(null),
    };
    const roleRepo = {
      find: jest.fn(
        ({ where }: { where: { id?: FindOperator<string[]>; workspaceId?: string } }) => {
          if (where.id) {
            const ids = where.id.value as unknown as string[];
            return Promise.resolve(roles.filter((r) => ids.includes(r.id)));
          }
          return Promise.resolve(roles);
        }
      ),
      findOne: jest.fn(),
    };
    const memberRepo = {
      findOne: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(members.find((m) => m.userId === where.userId) ?? null)
      ),
      find: jest.fn(() => Promise.resolve(members)),
      delete: jest.fn(() => Promise.resolve({ affected: 1 })),
      save: jest.fn((m: unknown) => Promise.resolve(m)),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const service = new ChannelService(
      workspaceRepo as unknown as Repository<Workspace>,
      channelRepo as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      { publishChannelEvent: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService
    );
    // The removal lock's transaction, for a private creation; and the one a departure runs its
    // roster write in.
    const manager = fakeDepartureManager(() => ({ channelRepo, memberRepo, roleRepo }));
    Object.assign(memberRepo, { manager });
    // A departure calls chat-delivery around its roster write; what is asserted here is only
    // whether the removal went through, so the departure runs its roster write under the lock and
    // nothing else.
    const rosterWrites = jest
      .spyOn(service as never, 'departDistributionGroups' as never)
      .mockImplementation((async (
        _cuts: unknown,
        _reason: string,
        _workspaceId: string,
        rosterWrite: (m: unknown) => Promise<void>
      ) => manager.transaction(rosterWrite)) as never);
    for (const name of [
      'hardDeleteWorkspace',
      'ensureChannelDistributionGroup',
      'announceChannelAccessGranted',
    ]) {
      jest.spyOn(service as never, name as never).mockResolvedValue(undefined as never);
    }
    jest.spyOn(service as never, 'channelAudience' as never).mockResolvedValue([] as never);
    jest
      .spyOn(service as never, 'writeDecisionsFor' as never)
      .mockResolvedValue(new Map() as never);
    return { service, memberRepo, channelRepo, channel, manager, rosterWrites };
  }

  beforeEach(() => {
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  /** The typed code of a refusal, or `'allowed'` when the call went through. */
  const outcome = async (call: Promise<unknown>): Promise<unknown> => {
    try {
      await call;
      return 'allowed';
    } catch (e) {
      return e instanceof ForbiddenException || e instanceof ConflictException
        ? (e.getResponse() as { code?: unknown }).code
        : String(e);
    }
  };
  const everyoneBut = (...out: string[]) =>
    ['u-admin', 'u-admin-2', 'u-mod', 'u-mod-2', 'u-salons', 'u-member'].filter(
      (u) => !out.includes(u)
    );
  const BOUND = 'REMOVAL_EXCEEDS_ACTOR';
  /** A membership read inside the removal lock's transaction, with a shared row lock. */
  const ROW_LOCKED = expect.objectContaining({ lock: { mode: 'pessimistic_read' } });

  describe('from the community', () => {
    it('refuses removing a member whose roles grant more than the actor holds', async () => {
      const { service, memberRepo } = makeService();
      expect(await outcome(service.kickFromWorkspace(WS, 'u-admin-2', 'u-mod'))).toBe(BOUND);
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });

    it('lets a moderator remove a peer or a plain member', async () => {
      const { service } = makeService();
      expect(await outcome(service.kickFromWorkspace(WS, 'u-mod-2', 'u-mod'))).toBe('allowed');
      expect(await outcome(service.kickFromWorkspace(WS, 'u-member', 'u-mod'))).toBe('allowed');
    });

    it('lets an administrator remove anyone', async () => {
      const { service } = makeService();
      expect(await outcome(service.kickFromWorkspace(WS, 'u-mod', 'u-admin'))).toBe('allowed');
    });
  });

  describe('from a private salon', () => {
    it('refuses removing a member whose roles grant more than the actor holds', async () => {
      // A salon manager holds `channel.manage` only; a moderator carries `member.kick` and more.
      const { service, channelRepo } = makeService();
      expect(await outcome(service.removeMemberFromChannel(SALON, 'u-mod', 'u-salons'))).toBe(
        BOUND
      );
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('lets a salon manager remove a plain member, and an administrator anyone', async () => {
      const { service } = makeService();
      expect(await outcome(service.removeMemberFromChannel(SALON, 'u-member', 'u-salons'))).toBe(
        'allowed'
      );
      expect(await outcome(service.removeMemberFromChannel(SALON, 'u-mod', 'u-admin'))).toBe(
        'allowed'
      );
    });

    it('asks the bound again in the roster write, on row-locked members', async () => {
      const { service, memberRepo } = makeService();
      await service.removeMemberFromChannel(SALON, 'u-member', 'u-salons');
      expect(memberRepo.findOne).toHaveBeenCalledWith(ROW_LOCKED);
    });
  });

  describe('by rewriting the access list of a private salon', () => {
    it('refuses dropping a member whose roles grant more than the actor holds', async () => {
      // The same removal, reached through the allowlist instead of the remove button.
      const { service, channelRepo, rosterWrites } = makeService();
      expect(
        await outcome(
          service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-mod'), undefined, 0)
        )
      ).toBe(BOUND);
      expect(channelRepo.save).not.toHaveBeenCalled();
      // Refused before the departure: nobody was cut off.
      expect(rosterWrites).not.toHaveBeenCalled();
    });

    it('lets a salon manager drop a plain member, asked again on row-locked members', async () => {
      const { service, channel, memberRepo } = makeService();
      expect(
        await outcome(
          service.updateChannelAccess(
            SALON,
            'u-salons',
            true,
            everyoneBut('u-member'),
            undefined,
            0
          )
        )
      ).toBe('allowed');
      expect(channel.allowedUsers).toEqual(everyoneBut('u-member'));
      expect(memberRepo.findOne).toHaveBeenCalledWith(ROW_LOCKED);
    });

    it('skips an allowlist entry who is no longer a member of the community', async () => {
      const { service, channel } = makeService({
        isPrivate: true,
        allowedUsers: ['u-salons', 'u-member', 'u-gone'],
      });
      expect(
        await outcome(
          service.updateChannelAccess(
            SALON,
            'u-salons',
            true,
            ['u-salons', 'u-member'],
            undefined,
            0
          )
        )
      ).toBe('allowed');
      expect(channel.allowedUsers).toEqual(['u-salons', 'u-member']);
    });

    it('refuses whole when the salon changed between its read and its row lock', async () => {
      // The copy the removals were computed from lists u-member; the row locked in the transaction
      // has gained u-mod since. Saving would erase that grant, and the cuts named the wrong people.
      const { service, channelRepo, channel } = makeService({
        isPrivate: true,
        allowedUsers: ['u-salons', 'u-member'],
      });
      channelRepo.findOne
        .mockImplementationOnce(() =>
          Promise.resolve({ ...channel, allowedUsers: ['u-salons', 'u-member'] })
        )
        .mockImplementationOnce(() =>
          Promise.resolve({
            ...channel,
            allowedUsers: ['u-salons', 'u-member', 'u-mod'],
            accessRevision: 1,
          })
        );
      expect(
        await outcome(
          service.updateChannelAccess(SALON, 'u-salons', true, ['u-salons'], undefined, 0)
        )
      ).toBe(CHANNEL_ACCESS_CHANGED);
      expect(channelRepo.save).not.toHaveBeenCalled();
    });
  });

  /**
   * THE PANEL'S LIST PREDATES A GRANT IT NEVER SAW. Admin A opened the access tab at revision 0; B
   * granted u-mod (revision 1); A then changes the write policy, sending the list it holds. Diffing
   * that list against the row read u-mod as a removal - cut from the key distribution, answered 200.
   */
  describe('the base revision the rewrite was edited at', () => {
    const grantedSince = () => {
      const made = makeService({ isPrivate: true, allowedUsers: ['u-salons', 'u-member'] });
      // B's grant, committed after A's panel read revision 0.
      made.channel.allowedUsers = ['u-salons', 'u-member', 'u-mod'];
      Object.assign(made.channel, { accessRevision: 1 });
      return made;
    };

    it('refuses a stale base with the current access, before anything is cut', async () => {
      const { service, channel, channelRepo, rosterWrites } = grantedSince();
      const refusal = await service
        .updateChannelAccess(SALON, 'u-salons', true, ['u-salons', 'u-member'], 'admins', 0)
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as ConflictException).getResponse()).toMatchObject({
        code: CHANNEL_ACCESS_CHANGED,
        current: {
          isPrivate: true,
          allowedUsers: ['u-salons', 'u-member', 'u-mod'],
          accessRevision: 1,
        },
      });
      expect(rosterWrites).not.toHaveBeenCalled();
      expect(channelRepo.save).not.toHaveBeenCalled();
      expect(channel.allowedUsers).toContain('u-mod');
    });

    it('saves a current base, raises the revision and answers it', async () => {
      const { service, channel } = grantedSince();
      const saved = await service.updateChannelAccess(
        SALON,
        'u-salons',
        true,
        ['u-salons', 'u-member', 'u-mod', 'u-admin'],
        'admins',
        1
      );
      expect(saved).toMatchObject({ ok: true, accessRevision: 2, writePolicy: 'admins' });
      expect(channel).toMatchObject({
        accessRevision: 2,
        allowedUsers: ['u-salons', 'u-member', 'u-mod', 'u-admin'],
      });
    });

    it('drops nobody on a baseless rewrite - an old panel grants, it never removes here', async () => {
      const { service, channel, rosterWrites } = grantedSince();
      const saved = await service.updateChannelAccess(
        SALON,
        'u-salons',
        true,
        ['u-salons', 'u-member', 'u-admin'],
        'admins'
      );
      // u-mod, absent from the stale list, is kept; u-admin, the old panel's grant, is added.
      expect(new Set(channel.allowedUsers)).toEqual(
        new Set(['u-salons', 'u-member', 'u-admin', 'u-mod'])
      );
      expect(saved).toMatchObject({ accessRevision: 2, writePolicy: 'admins' });
      // No departure cut anyone: the roster write ran with no cut to make.
      expect(rosterWrites).toHaveBeenCalledWith([], 'access_updated', WS, expect.any(Function));
    });

    it('raises the revision on a per-member removal and answers it', async () => {
      const { service, channel } = grantedSince();
      const removed = await service.removeMemberFromChannel(SALON, 'u-member', 'u-salons');
      expect(removed).toMatchObject({ success: true, accessRevision: 2 });
      expect(channel).toMatchObject({ accessRevision: 2, allowedUsers: ['u-salons', 'u-mod'] });
    });
  });

  describe('by making a public salon private', () => {
    it('refuses leaving out a member whose roles grant more than the actor holds', async () => {
      // Every community member sees a public salon; going private takes it from whoever is left off.
      const { service, channelRepo } = makeService({ isPrivate: false });
      expect(
        await outcome(service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-mod')))
      ).toBe(BOUND);
      expect(channelRepo.save).not.toHaveBeenCalled();
    });

    it('refuses it through a detour by public, from a private salon that listed them', async () => {
      const { service } = makeService();
      expect(await outcome(service.updateChannelAccess(SALON, 'u-salons', false, []))).toBe(
        'allowed'
      );
      expect(
        await outcome(service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-mod')))
      ).toBe(BOUND);
    });

    it('lets a salon manager leave out plain members, and an administrator anyone', async () => {
      const salonManager = makeService({ isPrivate: false });
      expect(
        await outcome(
          salonManager.service.updateChannelAccess(SALON, 'u-salons', true, everyoneBut('u-member'))
        )
      ).toBe('allowed');
      const admin = makeService({ isPrivate: false });
      expect(await outcome(admin.service.updateChannelAccess(SALON, 'u-admin', true, []))).toBe(
        'allowed'
      );
    });
  });

  describe('by creating a private salon', () => {
    const create = (service: ChannelService, actorUserId: string) =>
      service.createChannel({ workspaceId: WS, name: 'cache', visibility: 'private', actorUserId });

    it('refuses a creator who holds less than a member it leaves off', async () => {
      // A private salon is listed to its creator alone: a salon manager would hide it from the
      // administrators, which only high ranks may do.
      const { service, channelRepo, manager } = makeService({ isPrivate: false });
      expect(await outcome(create(service, 'u-salons'))).toBe(BOUND);
      expect(channelRepo.save).not.toHaveBeenCalled();
      expect(manager.locks).toEqual([`community_removal:${WS}`]);
    });

    it('lets an administrator create one, and anyone a public one', async () => {
      const admin = makeService({ isPrivate: false });
      expect(await outcome(create(admin.service, 'u-admin'))).toBe('allowed');
      const salonManager = makeService({ isPrivate: false });
      expect(
        await outcome(
          salonManager.service.createChannel({
            workspaceId: WS,
            name: 'ouvert',
            visibility: 'public',
            actorUserId: 'u-salons',
          })
        )
      ).toBe('allowed');
      expect(salonManager.manager.locks).toEqual([]);
    });
  });

  describe('a removal target who is not a member', () => {
    it('is refused as not found when removed from the community', async () => {
      const { service, memberRepo } = makeService();
      await expect(service.kickFromWorkspace(WS, 'u-ghost', 'u-admin')).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(memberRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('an account erasure meeting a departure race', () => {
    it('reads DEPARTURE_SUPERSEDED as transient, so the queue retries rather than gives up', () => {
      const race = new ConflictException({ code: DEPARTURE_SUPERSEDED, message: 'retry' });
      expect(isTransientFailure(race)).toBe(true);
      // Any other refusal stays a refusal.
      expect(isTransientFailure(new ConflictException({ code: 'SOMETHING_ELSE' }))).toBe(false);
    });
  });
});
