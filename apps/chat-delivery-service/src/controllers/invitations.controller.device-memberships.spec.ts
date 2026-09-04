/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { MessagingService } from '../services/messaging.service';

/**
 * `GET /api/mls/device-memberships/:userId/:deviceId` is where a client decides whether to WAIT for
 * a member or to serve itself an external-commit join, and until 2026-09-04 it answered with the
 * membership row alone.
 *
 * THE ROW CANNOT CARRY THE ANSWER. `pending` means "a member has been told to Add this device"; it
 * says nothing about anyone doing it, and two opposite situations wear it. Measured on production
 * 2026-09-03: a web device enrolled at 12:49:59 with ELEVEN `pending` rows, ZERO queued Welcomes and
 * an `updatedAt` that never moved, and ten hours later it was still emitting one `welcome_request`
 * per group per minute - while every one of those groups had a usable external-join base published.
 * Reproduced on the local estate the next day on four groups.
 *
 * WHAT IS PINNED HERE IS THE PARTITION, not the SQL - a mocked repository never parses a query. What
 * a mock can prove, and what would silently regress, is that the endpoint reports the two facts that
 * separate the situations `pending` collapses, and reports them PER ROW:
 *
 *   - a Welcome queued for THIS device and THIS group -> the Add worked, delivery is owed, WAIT;
 *   - the group's add lock held -> an Add is in flight right now, WAIT (this is the window a queued
 *     Welcome does not yet cover, and it is what keeps the GRP-4 duplicate-leaf race shut);
 *   - neither -> a roster seat nothing follows, which is the only state a device may act on.
 */
describe('InvitationsController - getDeviceMemberships', () => {
  let controller: InvitationsController;
  let log: jest.SpyInstance;

  const deviceGroupRepo = { find: jest.fn() };
  const queuedMessageRepo = { find: jest.fn() };
  const redis = { mget: jest.fn() };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
    metadata: { tableName: 'stub' },
  });

  const USER = 'user-a';
  const DEVICE = 'web-user-a-fresh';

  const row = (groupId: string, status: 'pending' | 'active') => ({
    id: `m-${groupId}`,
    userId: USER,
    deviceId: DEVICE,
    groupId,
    status,
  });

  /** Call it the way nginx does: the caller owns the userId it is asking about. */
  const ask = () => controller.getDeviceMemberships(USER, DEVICE, USER, 'false');

  beforeEach(async () => {
    jest.clearAllMocks();
    queuedMessageRepo.find.mockResolvedValue([]);
    redis.mget.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupInvite), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: MessagingService, useValue: { deviceAddressability: jest.fn() } },
      ],
    }).compile();

    controller = module.get(InvitationsController);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => log.mockRestore());

  it('marks a pending row with no queued Welcome and no add lock as owed by nobody', async () => {
    // THE PRODUCTION P1, AS ONE ROW. This is the answer that lets the client stop asking a member
    // that is not there and join the group itself.
    deviceGroupRepo.find.mockResolvedValue([row('g1', 'pending')]);

    const answer = await ask();

    expect(answer).toEqual([
      expect.objectContaining({ groupId: 'g1', welcomeQueued: false, addInFlight: false }),
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stranded=1'));
  });

  it('reports the Welcome that is actually queued for this device and this group', async () => {
    deviceGroupRepo.find.mockResolvedValue([row('g1', 'pending')]);
    queuedMessageRepo.find.mockResolvedValue([{ groupId: 'g1' }]);

    const answer = await ask();

    expect(answer[0]).toMatchObject({ welcomeQueued: true, addInFlight: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stranded=0'));
  });

  it('reports the add lock a member is holding right now', async () => {
    // The window between the roster row being written and the Welcome being queued. Answering
    // "nobody owes you anything" here is what would put two parties in the same tree.
    deviceGroupRepo.find.mockResolvedValue([row('g1', 'pending')]);
    redis.mget.mockResolvedValue(['user-b:web-user-b-1']);

    const answer = await ask();

    expect(redis.mget).toHaveBeenCalledWith(['mls:addlock:g1']);
    expect(answer[0]).toMatchObject({ welcomeQueued: false, addInFlight: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stranded=0'));
  });

  it('answers per row rather than per device, so one queued Welcome does not cover the others', async () => {
    // The production shape: ELEVEN rows written in one batch, of which some may be served and some
    // not. A device-level answer would have hidden exactly the rows that were stranded.
    deviceGroupRepo.find.mockResolvedValue([
      row('g1', 'pending'),
      row('g2', 'pending'),
      row('g3', 'active'),
    ]);
    queuedMessageRepo.find.mockResolvedValue([{ groupId: 'g1' }]);
    redis.mget.mockResolvedValue([null, null]);

    const answer = await ask();

    expect(answer.map((m) => [m.groupId, m.welcomeQueued, m.addInFlight])).toEqual([
      ['g1', true, false],
      ['g2', false, false],
      ['g3', false, false],
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stranded=1'));
  });

  it('asks neither Postgres nor Redis when no row is pending', async () => {
    // An `active` device polls this on its own cadence and has nothing to discriminate.
    deviceGroupRepo.find.mockResolvedValue([row('g1', 'active')]);

    await ask();

    expect(queuedMessageRepo.find).not.toHaveBeenCalled();
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('reports no add lock rather than failing when Redis cannot answer', async () => {
    // FAIL TOWARDS THE OLD BEHAVIOUR. `addInFlight: false` can only ever make the client ask a
    // member, which is what it did before this endpoint carried anything - so a Redis outage
    // degrades to the previous behaviour instead of breaking the sidebar.
    deviceGroupRepo.find.mockResolvedValue([row('g1', 'pending')]);
    redis.mget.mockRejectedValue(new Error('redis down'));

    const answer = await ask();

    expect(answer[0]).toMatchObject({ welcomeQueued: false, addInFlight: false });
  });
});
