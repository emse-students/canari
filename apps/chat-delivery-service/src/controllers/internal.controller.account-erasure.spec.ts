/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { DeviceSignatureKey } from '../entities/device-signature-key.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { DELETED_ACCOUNT } from '../utils/account-erasure-coverage';

/**
 * THE CHAT-DELIVERY HALF OF AN ACCOUNT ERASURE, AS THE DURABLE QUEUE CALLS IT: MORE THAN ONCE.
 *
 * core-service retries this route until it answers 2xx, then calls it once more after every token
 * the account held has expired. So two things are pinned here: what it deletes (the four tables the
 * old hand-written list never named), and that a SECOND run - with the key packages already gone -
 * still finds and cleans what is left. The old version read the device ids off the key packages to
 * clean the Redis routes, so its retry cleaned nothing.
 */
describe('InternalController - DELETE internal/users/:userId (account erasure)', () => {
  const SECRET = 'erasure-secret';
  const USER = 'user-erased';

  function make(
    opts: {
      routed?: string[];
      deviceGroups?: string[];
      evictionGroups?: string[];
      /** Groups the device rows name that have no `dm_groups` row any more. */
      orphanGroups?: string[];
      /** Device rows the final transaction still finds and deletes. */
      leftRows?: number;
    } = {}
  ) {
    process.env.INTERNAL_SECRET = SECRET;
    /** Every step that matters to the order, as it happens. */
    const steps: string[] = [];
    const repo = () => ({
      find: jest.fn().mockResolvedValue([]),
      findBy: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    // The account's remaining device rows and its queue go in a transaction; its deletes are
    // recorded here.
    const txDeletes: Array<{ entity: unknown; where: unknown }> = [];
    const txManager = {
      getRepository: (entity: unknown) => ({
        delete: (where: unknown) => {
          txDeletes.push({ entity, where });
          return Promise.resolve({
            affected: entity === DeviceGroupMembership ? (opts.leftRows ?? 0) : 1,
          });
        },
      }),
    };
    const manager = {
      // The key packages, deleted on their own before anything is read.
      getRepository: (entity: unknown) => ({
        delete: (where: unknown) => {
          steps.push(entity === KeyPackage ? 'keyPackages' : 'other');
          txDeletes.push({ entity, where });
          return Promise.resolve({ affected: 2 });
        },
      }),
      // The account's eviction rows when asked for them; every other statement is a raw DELETE.
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('SELECT "groupId" FROM dm_seat_evictions')
            ? (opts.evictionGroups ?? []).map((groupId) => ({ groupId }))
            : [[], 2]
        )
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => cb(txManager)),
    };
    const repos = {
      pushToken: repo(),
      keyPackage: repo(),
      otp: repo(),
      group: { ...repo(), manager },
      groupMember: repo(),
      deviceGroup: repo(),
      queued: repo(),
      pin: repo(),
      revoked: repo(),
      invite: repo(),
      interval: repo(),
    };
    // A Graine distribution group: a device membership and NO dm_group_members row.
    repos.deviceGroup.find.mockImplementation(async () => {
      steps.push('discovery');
      return [...(opts.deviceGroups ?? []), ...(opts.orphanGroups ?? [])].map((groupId) => ({
        groupId,
      }));
    });
    repos.group.findBy.mockImplementation(async () =>
      [...(opts.deviceGroups ?? []), ...(opts.evictionGroups ?? [])].map((id) => ({
        id,
        isGroup: true,
      }))
    );
    const redis = {
      smembers: jest.fn().mockResolvedValue(opts.routed ?? []),
      srem: jest.fn().mockResolvedValue(1),
      del: jest.fn(),
    };
    // Each group's seats are cut through the one eviction, under that group's seat lock.
    const messagingService = {
      eraseSeats: jest.fn(async (groupId: string) => {
        steps.push(`cut ${groupId}`);
        return { memberships: 1, queued: 0, toRemove: 2 };
      }),
    };
    const controller = new InternalController(
      repos.pushToken as never,
      repos.keyPackage as never,
      repos.otp as never,
      repos.group as never,
      repos.groupMember as never,
      repos.deviceGroup as never,
      repos.queued as never,
      repos.pin as never,
      repos.revoked as never,
      repos.invite as never,
      repos.interval as never,
      redis as never,
      messagingService as never
    );
    return { controller, repos, manager, redis, txDeletes, messagingService, steps };
  }

  it('deletes the signature keys, the notification preferences and the dismissal markers', async () => {
    const { controller, manager } = make();
    await controller.deleteUserData(USER, SECRET);

    for (const entity of [DeviceSignatureKey, NotificationPreference, UserDismissedGroup]) {
      expect(manager.delete).toHaveBeenCalledWith(entity, { userId: USER });
    }
  });

  it('deletes the application messages the account SENT, and spares queued handshake frames', async () => {
    const { controller, manager, txDeletes } = make();
    await controller.deleteUserData(USER, SECRET);

    const [sql, params] = manager.query.mock.calls.find(([q]) =>
      String(q).includes('DELETE FROM queued_message')
    ) as unknown as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM queued_message/);
    expect(sql).toMatch(/"senderId" = \$1/);
    // A pending commit is the recipient's protocol state: deleting it forks their group.
    expect(sql).toMatch(/"isCommit" IS NOT TRUE/);
    expect(sql).toMatch(/"isWelcome" IS NOT TRUE/);
    expect(params).toEqual([USER]);
    // ...and what was queued FOR the account still goes - Welcomes included - with its device
    // rows, in one transaction (`endDeviceMemberships`). The key packages went before, on their own.
    expect(txDeletes).toEqual([
      { entity: KeyPackage, where: { userId: USER } },
      { entity: QueuedMessage, where: { recipientId: USER } },
      { entity: DeviceGroupMembership, where: { userId: USER } },
    ]);
  });

  it('anonymises the invite links the account minted instead of breaking them', async () => {
    const { controller, repos } = make();
    await controller.deleteUserData(USER, SECRET);

    expect(repos.invite.update).toHaveBeenCalledWith(
      { createdBy: USER },
      { createdBy: DELETED_ACCOUNT }
    );
  });

  it('cuts each group seat under its seat lock on a RETRY, when no key package is left to name a device', async () => {
    const { controller, redis, repos, messagingService } = make({
      deviceGroups: ['g-distribution'],
      routed: [`${USER}:dev-1`, `${USER}:dev-2`, 'someone-else:dev-9'],
    });
    // The first run already deleted them - the old code read its device list from here.
    repos.keyPackage.find.mockResolvedValue([]);

    await controller.deleteUserData(USER, SECRET);

    // The rows, the queue and the routes (by prefix) go in one seat-locked cut, which also
    // moves the group's seat generation - so a route restored from a read taken before cannot outlive the erasure.
    expect(messagingService.eraseSeats).toHaveBeenCalledWith('g-distribution', USER);
    expect(redis.srem).not.toHaveBeenCalled();
  });

  it("deletes the account's eviction records: a claim it took before is refused by the group's generation", async () => {
    const { controller, manager } = make({ deviceGroups: ['g-1'] });
    await controller.deleteUserData(USER, SECRET);

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM dm_seat_evictions WHERE "userId" = \$1/),
      [USER]
    );
  });

  it('cuts a group the account is named in only by an eviction row - a departure in progress', async () => {
    const { controller, messagingService } = make({ evictionGroups: ['g-departing'] });
    await controller.deleteUserData(USER, SECRET);

    // The cut moves that group's seat generation, the one thing left to refuse an earlier claim.
    expect(messagingService.eraseSeats).toHaveBeenCalledWith('g-departing', USER);
  });

  it('deletes the key packages before it reads which groups to cut, and cuts each before the last delete', async () => {
    // No seat can be inserted once the key packages are gone, so the discovery that follows reads
    // every row there will ever be; each group's rows then go with their routes, under the lock.
    const { controller, steps } = make({ deviceGroups: ['g-1', 'g-2'] });
    await controller.deleteUserData(USER, SECRET);

    expect(steps).toEqual(['keyPackages', 'discovery', 'cut g-1', 'cut g-2']);
  });

  it('cuts a group with no group row left through the same seat lock, rows and routes together', async () => {
    // Deleting its device rows in the final transaction would leave its routes named by nothing,
    // for good, if the run stopped before a sweep.
    const { controller, messagingService } = make({ orphanGroups: ['g-orphan'] });
    await controller.deleteUserData(USER, SECRET);

    expect(messagingService.eraseSeats).toHaveBeenCalledWith('g-orphan', USER);
  });

  it('says so when the final transaction still finds a device row', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { controller } = make({ leftRows: 1 });
    await controller.deleteUserData(USER, SECRET);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 device row\(s\).*written after/));
    warn.mockRestore();
  });

  it('answers ok on an account with nothing left, which is what the final pass meets', async () => {
    const { controller } = make();
    await expect(controller.deleteUserData(USER, SECRET)).resolves.toEqual({ ok: true });
  });
});
