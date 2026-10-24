/// <reference types="jest" />

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { InternalController } from './internal.controller';
import { PushToken } from '../entities/push-token.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { Group } from '../entities/group.entity';
import { GroupMember } from '../entities/group-member.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { MessagingService } from '../services/messaging.service';
import { MAX_PRESENCE_AUDIENCE_USERS } from '../utils/presence-audience';

type Row = Record<string, unknown>;

/** Whether `row` satisfies a TypeORM `where` built from plain values, `In(...)` and `IsNull()`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond instanceof FindOperator) {
      if (cond.type === 'in') return (cond.value as unknown as unknown[]).includes(row[key]);
      if (cond.type === 'isNull') return row[key] === null || row[key] === undefined;
      throw new Error(`operator ${cond.type} not modelled`);
    }
    return row[key] === cond;
  });
}

/** An in-memory repository answering `find({ where })` over `rows`, so the QUERIES are what is tested. */
function fakeRepo(rows: Row[]) {
  return {
    find: jest.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where))),
  };
}

/**
 * The conversation half of the presence audience (WP-PRESENCE, 2026-10-18): the gateway may show
 * whether X is online only to someone who shares a conversation or a community with X. Asserted
 * here: a shared DM or group counts, a stranger does not, a TOMBSTONED conversation no longer
 * does, the viewer never answers for themself, and the route is internal-only.
 */
describe('InternalController - the presence audience (shared conversations)', () => {
  const SECRET = 'internal-secret-for-tests';
  let controller: InternalController;
  let memberRepo: ReturnType<typeof fakeRepo>;

  beforeEach(async () => {
    const seat = (groupId: string, userId: string, awaitingAdmission = false) => ({
      groupId,
      userId,
      awaitingAdmission,
    });
    memberRepo = fakeRepo([
      seat('dm-ab', 'alice'),
      seat('dm-ab', 'bob'),
      seat('grp-dead', 'alice'),
      seat('grp-dead', 'dora'),
      seat('grp-other', 'carol'),
      seat('grp-other', 'erin'),
      // An invitation link's ask in each direction: frank waits in a group alice is in, and alice
      // waits in a group gina is in.
      seat('grp-ask', 'alice'),
      seat('grp-ask', 'frank', true),
      seat('grp-asked', 'alice', true),
      seat('grp-asked', 'gina'),
    ]);
    const groupRepo = fakeRepo([
      { id: 'dm-ab', deletedAt: null },
      { id: 'grp-dead', deletedAt: new Date(0) },
      { id: 'grp-other', deletedAt: null },
      { id: 'grp-ask', deletedAt: null },
      { id: 'grp-asked', deletedAt: null },
    ]);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: {} },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: {} },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(GroupMember), useValue: memberRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
        { provide: getRepositoryToken(QueuedMessage), useValue: {} },
        { provide: getRepositoryToken(PinVerifier), useValue: {} },
        { provide: getRepositoryToken(RevokedDevice), useValue: {} },
        { provide: getRepositoryToken(GroupInvite), useValue: {} },
        { provide: getRepositoryToken(GroupMembershipInterval), useValue: {} },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    }).compile();
    controller = module.get(InternalController);
    jest.spyOn(controller['logger'], 'debug').mockImplementation(() => undefined);
    Object.defineProperty(controller, 'secret', { value: SECRET, writable: true });
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers the people the viewer shares a live conversation with, and nobody else', async () => {
    await expect(
      controller.presenceSharedConversations(SECRET, {
        viewerId: 'alice',
        userIds: ['bob', 'carol', 'dora'],
      })
    ).resolves.toEqual({ userIds: ['bob'] });
  });

  it('counts no seat awaiting a member as sharing the conversation, in either direction', async () => {
    await expect(
      controller.presenceSharedConversations(SECRET, {
        viewerId: 'alice',
        userIds: ['frank', 'gina'],
      })
    ).resolves.toEqual({ userIds: [] });
    await expect(
      controller.presenceSharedConversations(SECRET, { viewerId: 'frank', userIds: ['alice'] })
    ).resolves.toEqual({ userIds: [] });
  });

  it('compares ids in the lowercase spelling every stored id has', async () => {
    await expect(
      controller.presenceSharedConversations(SECRET, { viewerId: 'ALICE', userIds: [' Bob '] })
    ).resolves.toEqual({ userIds: ['bob'] });
  });

  it('never answers for the viewer themself', async () => {
    await expect(
      controller.presenceSharedConversations(SECRET, { viewerId: 'alice', userIds: ['alice'] })
    ).resolves.toEqual({ userIds: [] });
    expect(memberRepo.find).not.toHaveBeenCalled();
  });

  it('answers an empty audience for a viewer in no conversation', async () => {
    await expect(
      controller.presenceSharedConversations(SECRET, { viewerId: 'zed', userIds: ['bob'] })
    ).resolves.toEqual({ userIds: [] });
  });

  it('refuses a caller without the internal secret', async () => {
    await expect(
      controller.presenceSharedConversations('wrong', { viewerId: 'alice', userIds: ['bob'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(memberRepo.find).not.toHaveBeenCalled();
  });

  it('refuses a malformed question rather than answering "nobody"', async () => {
    await expect(
      controller.presenceSharedConversations(SECRET, { viewerId: 'alice', userIds: 'bob' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.presenceSharedConversations(SECRET, { userIds: ['bob'] })
    ).rejects.toBeInstanceOf(BadRequestException);
    const tooMany = Array.from({ length: MAX_PRESENCE_AUDIENCE_USERS + 1 }, (_, i) => `u${i}`);
    await expect(
      controller.presenceSharedConversations(SECRET, { viewerId: 'alice', userIds: tooMany })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
