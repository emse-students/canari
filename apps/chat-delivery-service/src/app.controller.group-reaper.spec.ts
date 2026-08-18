/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { AppController } from './app.controller';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { Group } from './entities/group.entity';
import { GroupMember } from './entities/group-member.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { RevokedDevice } from './entities/revoked-device.entity';
import { PushToken } from './entities/push-token.entity';
import { MessagingService } from './services/messaging.service';

/**
 * The 90-day tombstone reaper is the ONLY path a normally-deleted group takes to its end, so
 * whatever it forgets is forgotten for ever - `mls_group_info` has no other collector at all.
 * Until 2026-08-18 it named two tables out of seven and left 21 of prod's 69 GroupInfo rows and
 * 293 of its 452 commit-log rows orphaned.
 *
 * Two things are pinned, and neither is the SQL (a mocked repo parses nothing):
 *  - the owned rows go with the group, through the one shared allowlist;
 *  - they go in the SAME transaction as the `dm_groups` delete. Outside one there is a window
 *    where the group is gone and its rows are not, which is the exact state the orphan sweep
 *    hunts - a sweep racing the reaper that is deleting for it.
 */
describe('AppController - cleanupSoftDeletedGroups', () => {
  let controller: AppController;

  const deletedInTx: string[] = [];
  let groupDeletedInTx = false;
  let transactionOpen = false;

  /** A manager whose repositories record whether the transaction was open at delete time. */
  const txManager = {
    getRepository: jest.fn((entity: unknown) => ({
      delete: jest.fn(() => {
        if (entity === Group) {
          groupDeletedInTx = transactionOpen;
        } else {
          deletedInTx.push(transactionOpen ? 'in' : 'out');
        }
        return Promise.resolve({ affected: 2 });
      }),
    })),
  } as unknown as EntityManager;

  const groupRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    manager: {
      transaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          return await cb(txManager);
        } finally {
          transactionOpen = false;
        }
      }),
    },
  };

  const redis = { del: jest.fn().mockResolvedValue(1), scan: jest.fn(), srem: jest.fn() };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
  });

  /** Invoke the private cron body the same way the scheduler does. */
  const run = () =>
    (
      controller as unknown as { cleanupSoftDeletedGroups(): Promise<void> }
    ).cleanupSoftDeletedGroups();

  beforeEach(async () => {
    jest.clearAllMocks();
    deletedInTx.length = 0;
    groupDeletedInTx = false;
    transactionOpen = false;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: MessagingService, useValue: { purgeOrphanGroups: jest.fn() } },
      ],
    })
      .setLogger({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() })
      .compile();

    controller = module.get<AppController>(AppController);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reaps every table the group owns, inside the transaction that drops the group', async () => {
    groupRepo.find.mockResolvedValue([{ id: 'g1' }, { id: 'g2' }]);

    await run();

    // Six owned tables plus dm_groups itself, all in one unit of work.
    expect(deletedInTx).toEqual(['in', 'in', 'in', 'in', 'in', 'in', 'in']);
    expect(groupDeletedInTx).toBe(true);
    expect(groupRepo.manager.transaction).toHaveBeenCalledTimes(1);
  });

  it('drops the Redis keys after the commit, never before', async () => {
    groupRepo.find.mockResolvedValue([{ id: 'g1' }]);
    const order: string[] = [];
    groupRepo.manager.transaction.mockImplementationOnce(
      async (cb: (m: EntityManager) => Promise<unknown>) => {
        transactionOpen = true;
        try {
          const r = await cb(txManager);
          order.push('commit');
          return r;
        } finally {
          transactionOpen = false;
        }
      }
    );
    redis.del.mockImplementation(() => {
      order.push('redis');
      return Promise.resolve(1);
    });

    await run();

    // Reversed, a rollback would leave a live group with its history stripped.
    expect(order).toEqual(['commit', 'redis']);
    expect(redis.del).toHaveBeenCalledWith('history:g1', 'group:members:g1', 'pending_welcome:g1');
  });

  it('opens no transaction and deletes nothing when no tombstone is old enough', async () => {
    groupRepo.find.mockResolvedValue([]);

    await run();

    expect(groupRepo.manager.transaction).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});
