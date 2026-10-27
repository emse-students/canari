/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { InternalController } from './internal.controller';
import { DeviceSignatureKey } from '../entities/device-signature-key.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
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
      /** The routing sets (`group:members:<g>`) Redis holds, by key, whatever a row says. */
      routed?: Record<string, string[]>;
      deviceGroups?: string[];
      evictionGroups?: string[];
      /** Groups the device rows name that have no `dm_groups` row any more. */
      orphanGroups?: string[];
      /** Device rows still standing after the sweep, left for the final pass. */
      leftRows?: number;
      /** Groups a device row names when the sweep reads them: a seat a republished key package let in. */
      lateGroups?: string[];
      /** Key packages the sweep's second delete still finds: the account reconnected meanwhile. */
      lateKeyPackages?: number;
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
      count: jest.fn().mockResolvedValue(0),
    });
    let keyPackageDeletes = 0;
    const manager = {
      // The key packages, deleted on their own before anything is read, and again by the sweep.
      getRepository: (entity: unknown) => ({
        delete: () => {
          steps.push(entity === KeyPackage ? 'keyPackages' : 'other');
          keyPackageDeletes += 1;
          return Promise.resolve({
            affected: keyPackageDeletes === 1 ? 2 : (opts.lateKeyPackages ?? 0),
          });
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
    // A Graine distribution group: a device membership and NO dm_group_members row. The first read
    // is the discovery; the second is the sweep's, after every discovered group was cut.
    repos.deviceGroup.find.mockImplementation(async () => {
      const sweep = steps.includes('discovery');
      steps.push(sweep ? 'sweep' : 'discovery');
      const groups = sweep
        ? (opts.lateGroups ?? [])
        : [...(opts.deviceGroups ?? []), ...(opts.orphanGroups ?? [])];
      return groups.map((groupId) => ({ groupId }));
    });
    // The roster goes before the sweep; the queue for the account and the count of the rows left
    // (never deleted here) come last.
    repos.groupMember.delete.mockImplementation(async () => {
      steps.push('roster');
      return { affected: 1 };
    });
    repos.queued.delete.mockImplementation(async () => {
      steps.push('queuedFor');
      return { affected: 1 };
    });
    repos.deviceGroup.count.mockImplementation(async () => {
      steps.push('rowsLeft');
      return opts.leftRows ?? 0;
    });
    repos.group.findBy.mockImplementation(async () =>
      [...(opts.deviceGroups ?? []), ...(opts.evictionGroups ?? [])].map((id) => ({
        id,
        isGroup: true,
      }))
    );
    // The keys come back in one SCAN page; the route sweep is the step that walks them.
    const redis = {
      scan: jest.fn(async () => {
        steps.push('routes');
        return ['0', Object.keys(opts.routed ?? {})];
      }),
      smembers: jest.fn(async (key: string) => opts.routed?.[key] ?? []),
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
    return { controller, repos, manager, redis, messagingService, steps };
  }

  it('deletes the signature keys, the notification preferences and the dismissal markers', async () => {
    const { controller, manager } = make();
    await controller.deleteUserData(USER, SECRET);

    for (const entity of [DeviceSignatureKey, NotificationPreference, UserDismissedGroup]) {
      expect(manager.delete).toHaveBeenCalledWith(entity, { userId: USER });
    }
  });

  it('deletes the application messages the account SENT, and spares queued handshake frames', async () => {
    const { controller, manager, repos } = make();
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
    // ...and what was queued FOR the account still goes, Welcomes included - but no device row:
    // a row names its route, and only the seat-locked cut removes both.
    expect(repos.queued.delete).toHaveBeenCalledWith({ recipientId: USER });
    expect(repos.deviceGroup.delete).not.toHaveBeenCalled();
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
    });
    // The first run already deleted them - the old code read its device list from here.
    repos.keyPackage.find.mockResolvedValue([]);

    await controller.deleteUserData(USER, SECRET);

    // The rows, the queue and the routes (by prefix) go in one seat-locked cut, which also
    // moves the group's seat generation - so a route restored from a read taken before cannot outlive the erasure.
    expect(messagingService.eraseSeats).toHaveBeenCalledWith('g-distribution', USER);
    expect(redis.srem).not.toHaveBeenCalled();
  });

  it('removes every route of the account from every routing set, one no row names any more included', async () => {
    // A run that died after a 1:1 DM's tombstone committed and before its Redis keys went: the
    // retry finds no row naming that DM, so the routes are found where they live, by prefix.
    const { controller, redis } = make({
      routed: {
        'group:members:g-dm': [`${USER}:dev-1`, 'someone-else:dev-9'],
        'group:members:g-other': ['someone-else:dev-8'],
      },
    });

    await controller.deleteUserData(USER, SECRET);

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'group:members:*', 'COUNT', 500);
    expect(redis.srem).toHaveBeenCalledTimes(1);
    expect(redis.srem).toHaveBeenCalledWith('group:members:g-dm', `${USER}:dev-1`);
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
    // A writer holding a key package makes its delete wait, so the discovery that follows reads
    // every row such a writer wrote; each group's rows then go with their routes, under the lock.
    // The roster goes before the sweep, so a registration re-seats nothing after it; the sweep then
    // finds nothing (no device reconnected meanwhile), and no device row is deleted outside a cut.
    const { controller, steps, messagingService } = make({ deviceGroups: ['g-1', 'g-2'] });
    await controller.deleteUserData(USER, SECRET);

    expect(steps).toEqual([
      'keyPackages',
      'discovery',
      'cut g-1',
      'cut g-2',
      'roster',
      'keyPackages',
      'sweep',
      'routes',
      'queuedFor',
      'rowsLeft',
    ]);
    expect(messagingService.eraseSeats).toHaveBeenCalledTimes(2);
  });

  it('a key package republished during the erasure is deleted again, and the seat it let in is cut with its routes', async () => {
    // The account reconnected after the first delete (a token still valid), its key package came
    // back, and a writer seated it in a group the discovery never saw. Deleting that row outside a
    // cut would leave its route and the key package behind.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { controller, steps, messagingService } = make({
      deviceGroups: ['g-1'],
      lateGroups: ['g-late'],
      lateKeyPackages: 1,
    });
    await controller.deleteUserData(USER, SECRET);

    expect(steps).toEqual([
      'keyPackages',
      'discovery',
      'cut g-1',
      'roster',
      'keyPackages',
      'sweep',
      'cut g-late',
      'routes',
      'queuedFor',
      'rowsLeft',
    ]);
    expect(messagingService.eraseSeats).toHaveBeenLastCalledWith('g-late', USER);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/republished 1 key package\(s\).*1 group\(s\) cut again, routes=2/)
    );
    warn.mockRestore();
  });

  it('cuts a group with no group row left through the same seat lock, rows and routes together', async () => {
    // Deleting its device rows outside a cut would leave its routes named by nothing,
    // for good, if the run stopped before a sweep.
    const { controller, messagingService } = make({ orphanGroups: ['g-orphan'] });
    await controller.deleteUserData(USER, SECRET);

    expect(messagingService.eraseSeats).toHaveBeenCalledWith('g-orphan', USER);
  });

  it("leaves a row written after the sweep's read for the final pass, and says so", async () => {
    // Deleting it here would leave its route with nothing to name it; the final pass's discovery
    // cuts it with its route.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { controller, repos } = make({ leftRows: 1 });
    await controller.deleteUserData(USER, SECRET);

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/1 device row\(s\).*left for the final pass/)
    );
    expect(repos.deviceGroup.delete).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answers ok on an account with nothing left, which is what the final pass meets', async () => {
    const { controller } = make();
    await expect(controller.deleteUserData(USER, SECRET)).resolves.toEqual({ ok: true });
  });
});
