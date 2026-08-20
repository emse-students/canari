import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ChannelService } from './channel.service';
import { Workspace } from './entities/workspace.entity';
import { Channel } from './entities/channel.entity';
import { ChannelRole } from './entities/channel-role.entity';
import { ChannelMember } from './entities/channel-member.entity';
import { ChannelMessage } from './entities/channel-message.entity';
import { WorkspaceInvite } from './entities/workspace-invite.entity';
import { RedisService } from '../common/redis';
import { CHANNEL_PERMISSIONS } from './permissions';

/**
 * Two administrators editing one role, and the two lost updates it took to make that safe.
 *
 * MEASURED ON PRODUCTION TWICE, both times by COMM-20 on 2026-08-20.
 *
 * The first time, on the WIRE: clicking a cell in the permission grid IS a delta - "grant this one
 * key" - and it was sent as the role's ENTIRE list, computed from whatever the browser happened to
 * be holding. The second time, in MEMORY: the wire carried one key, and the server still did
 * read-modify-write in this process, so two requests arriving together each read the same row,
 * each computed their own next list from it, and each wrote the whole row back.
 *
 * THE SECOND ONE SURVIVED A GREEN TEST, and the reason is the point of this file. The first version
 * of the check below awaited one call and then the other: it arranged a SEQUENCE and asserted on it
 * as though it were a race. A sequence is the case that already worked. What follows interleaves
 * them, and models the database faithfully enough for the difference to show - a read hands out a
 * SNAPSHOT and a write stores it back, which is what a row actually does.
 */
describe('ChannelService.setRoleBasePermission - one key at a time', () => {
  const WORKSPACE = 'ws-1';
  const ROLE = 'r-moderator';
  const ADMIN = 'u-admin';
  const OTHER_ADMIN = 'u-admin-2';

  const ADMIN_ROLE = {
    id: 'r-admin',
    workspaceId: WORKSPACE,
    name: 'Administrateur',
    permissions: [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE, CHANNEL_PERMISSIONS.MANAGE_ROLES],
  };

  /**
   * A stand-in for the row, not for the repository.
   *
   * `stored` is the only copy anything is allowed to keep. Every read returns a COPY of it and every
   * write replaces it - so an edit computed from a stale snapshot loses, here as in Postgres. A
   * double that handed out the same object twice would make every version of this code pass.
   */
  function makeService() {
    const stored = {
      id: ROLE,
      workspaceId: WORKSPACE,
      name: 'Moderateur',
      priority: 50,
      permissions: [
        CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
        CHANNEL_PERMISSIONS.INVITE_MEMBERS,
        CHANNEL_PERMISSIONS.KICK_MEMBERS,
      ] as string[],
    };
    const snapshot = () => ({ ...stored, permissions: [...stored.permissions] });
    const write = (row: { permissions: string[] }) => {
      stored.permissions = [...row.permissions];
      return snapshot();
    };

    /**
     * The row lock, modelled as the only thing that can serialise two callbacks.
     *
     * `em.findOne` REFUSES an unlocked read, so the serialisation below is the service asking for
     * `pessimistic_write` and not this double being helpful. Without that refusal the test would
     * pass against a version that never took the lock, and would be measuring itself.
     */
    let queue: Promise<unknown> = Promise.resolve();
    const em = {
      findOne: jest.fn(
        (_entity: unknown, opts: { where: { id: string }; lock?: { mode?: string } }) => {
          if (opts.lock?.mode !== 'pessimistic_write') {
            throw new Error('read inside the transaction without a row lock');
          }
          return Promise.resolve(opts.where.id === ROLE ? snapshot() : null);
        }
      ),
      save: jest.fn((_entity: unknown, row: { permissions: string[] }) =>
        Promise.resolve(write(row))
      ),
    };
    const manager = {
      transaction: jest.fn((fn: (m: typeof em) => Promise<unknown>) => {
        const run = queue.then(() => fn(em));
        queue = run.then(
          () => undefined,
          () => undefined
        );
        return run;
      }),
    };

    const roleRepo = {
      manager,
      findOne: jest.fn((opts: { where: { id: string } }) =>
        Promise.resolve(opts.where.id === ROLE ? snapshot() : ADMIN_ROLE)
      ),
      find: jest.fn().mockResolvedValue([ADMIN_ROLE]),
      save: jest.fn((r: { permissions: string[] }) => Promise.resolve(write(r))),
    };
    const memberRepo = {
      findOne: jest.fn((opts: { where: { userId: string } }) =>
        Promise.resolve({
          workspaceId: WORKSPACE,
          userId: opts.where.userId,
          roleIds: [ADMIN_ROLE.id],
        })
      ),
      find: jest.fn().mockResolvedValue([
        { workspaceId: WORKSPACE, userId: ADMIN, roleIds: [ADMIN_ROLE.id] },
        { workspaceId: WORKSPACE, userId: OTHER_ADMIN, roleIds: [ADMIN_ROLE.id] },
      ]),
      save: jest.fn(),
    };
    const noop = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const redis = { publishChannelEvent: jest.fn().mockResolvedValue(undefined) };

    const service = new ChannelService(
      noop as unknown as Repository<Workspace>,
      noop as unknown as Repository<Channel>,
      roleRepo as unknown as Repository<ChannelRole>,
      memberRepo as unknown as Repository<ChannelMember>,
      noop as unknown as Repository<ChannelMessage>,
      noop as unknown as Repository<WorkspaceInvite>,
      redis as unknown as RedisService
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, redis, stored, em };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /**
   * THE CASE BOTH LOST UPDATES LOST, and it is a race or it is nothing.
   *
   * The two calls are STARTED and only then awaited, so both authorisations complete before either
   * write - which is exactly what two HTTP requests do. One administrator revokes, the other grants,
   * and the row afterwards carries both decisions.
   */
  it('keeps both edits when two administrators change one role at once', async () => {
    const { service, stored } = makeService();

    const [first, second] = await Promise.all([
      service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_MESSAGES, false),
      service.setRoleBasePermission(ROLE, OTHER_ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, true),
    ]);

    // The row itself, which is the only thing either administrator will ever read back.
    expect([...stored.permissions].sort()).toEqual(
      [
        CHANNEL_PERMISSIONS.INVITE_MEMBERS,
        CHANNEL_PERMISSIONS.KICK_MEMBERS,
        CHANNEL_PERMISSIONS.MANAGE_ROLES,
      ].sort()
    );
    // And what each caller was ANSWERED: whoever went second must be told the settled state, since
    // that answer is what their grid draws.
    expect(first.permissions).not.toContain(CHANNEL_PERMISSIONS.MANAGE_MESSAGES);
    expect(second.permissions).not.toContain(CHANNEL_PERMISSIONS.MANAGE_MESSAGES);
    expect(second.permissions).toContain(CHANNEL_PERMISSIONS.MANAGE_ROLES);
  });

  /** The lock is the mechanism, so it is asserted rather than inferred from the outcome. */
  it('reads the row for update, never for information', async () => {
    const { service, em } = makeService();

    await service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, true);

    expect(em.findOne).toHaveBeenCalledTimes(1);
    expect(em.findOne.mock.calls[0][1]).toMatchObject({
      where: { id: ROLE },
      lock: { mode: 'pessimistic_write' },
    });
  });

  /** Granting twice is granting once - a click that arrives twice must not double the key. */
  it('is idempotent in both directions', async () => {
    const { service } = makeService();

    await service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, true);
    const twice = await service.setRoleBasePermission(
      ROLE,
      ADMIN,
      CHANNEL_PERMISSIONS.MANAGE_ROLES,
      true
    );
    expect(twice.permissions.filter((p) => p === CHANNEL_PERMISSIONS.MANAGE_ROLES).length).toBe(1);

    await service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, false);
    const off = await service.setRoleBasePermission(
      ROLE,
      ADMIN,
      CHANNEL_PERMISSIONS.MANAGE_ROLES,
      false
    );
    expect(off.permissions).not.toContain(CHANNEL_PERMISSIONS.MANAGE_ROLES);
  });

  /**
   * EVERY OPEN GRID IN THE COMMUNITY IS DRAWING THIS ROW, so the change is announced to the
   * membership - not to the editor, and not only to administrators: the workspace listing already
   * hands every member the full `roles` array, so this discloses nothing new.
   *
   * Announced from what the transaction SAVED, never from the copy this process started with: the
   * whole point of the lock is that those two can differ.
   */
  it('tells the community what the role now grants, as the row now stands', async () => {
    const { service, redis } = makeService();

    await service.setRoleBasePermission(ROLE, ADMIN, CHANNEL_PERMISSIONS.MANAGE_ROLES, true);

    const sent = redis.publishChannelEvent.mock.calls.filter(
      ([type]: [string]) => type === 'workspace.role.permissions'
    );
    expect(sent.length).toBe(1);
    expect(sent[0][1]).toMatchObject({ workspaceId: WORKSPACE, roleId: ROLE });
    expect(sent[0][1].permissions).toContain(CHANNEL_PERMISSIONS.MANAGE_ROLES);
    expect(sent[0][2]).toEqual([ADMIN, OTHER_ADMIN]);
  });

  /**
   * A key the server cannot name is a client asking for a capability that does not exist - and it is
   * refused BEFORE the transaction, so a bad request never takes a lock on the row.
   */
  it('refuses a permission that is not one of the six', async () => {
    const { service, em } = makeService();
    await expect(
      service.setRoleBasePermission(ROLE, ADMIN, 'channel.access', true)
    ).rejects.toThrow(/Invalid permission/);
    expect(em.findOne).not.toHaveBeenCalled();
  });
});
