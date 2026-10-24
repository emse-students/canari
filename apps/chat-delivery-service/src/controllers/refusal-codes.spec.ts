/// <reference types="jest" />

import { Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InvitationsController } from './invitations.controller';
import { MembersController } from './members.controller';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { SecurityController } from './security.controller';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { Group } from '../entities/group.entity';
import { GroupInvite } from '../entities/group-invite.entity';
import { GroupMember } from '../entities/group-member.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { UserDismissedGroup } from '../entities/user-dismissed-group.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';
import { RefusalCode, refusalBody } from '../utils/refusal-codes';

/** The `code` of the body a thrown HttpException carries, which is all a client keys on. */
const codeOf = (e: unknown): unknown =>
  (e as { getResponse: () => { code?: unknown } }).getResponse().code;

/**
 * ONE STABLE `code` PER USER-ACTIONABLE REFUSAL of the delivery service. Each case drives the real
 * throw site and asserts the body names the refusal, because the client words it from the code and
 * never reads the English `message`. The mirror table on the client fails its own test when this
 * registry gains a code it does not word.
 */
describe('refusal codes - one stable name per refusal a user can act on', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('keeps the old message text beside the code, so an older client reads what it always read', () => {
    expect(refusalBody(RefusalCode.NOT_A_MEMBER, 'Not a member of this group')).toEqual({
      code: 'NOT_A_MEMBER',
      message: 'Not a member of this group',
    });
  });

  it('names every code by itself - the value is the key, so a rename cannot go unnoticed', () => {
    for (const [key, value] of Object.entries(RefusalCode)) expect(value).toBe(key);
  });

  describe('InvitationsController', () => {
    const groupRepo = { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn() };
    const groupInviteRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
    const groupMemberRepo = { findOne: jest.fn() };
    const keyPackageRepo = { find: jest.fn() };
    const revokedRepo = { find: jest.fn() };
    let controller: InvitationsController;

    beforeEach(async () => {
      jest.clearAllMocks();
      const module: TestingModule = await Test.createTestingModule({
        controllers: [InvitationsController],
        providers: [
          { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
          { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
          { provide: getRepositoryToken(Group), useValue: groupRepo },
          { provide: getRepositoryToken(GroupInvite), useValue: groupInviteRepo },
          { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
          { provide: getRepositoryToken(RevokedDevice), useValue: revokedRepo },
          { provide: getRepositoryToken(QueuedMessage), useValue: {} },
          { provide: 'REDIS_CLIENT', useValue: {} },
          { provide: MessagingService, useValue: {} },
        ],
      })
        .overrideGuard(HeaderAuthGuard)
        .useValue({ canActivate: () => true })
        .compile();
      controller = module.get(InvitationsController);
    });

    it('NOT_A_MEMBER: a non-member cannot mint an invite link', async () => {
      groupMemberRepo.findOne.mockResolvedValue(null);
      const e = await controller
        .createGroupInvite('g1', 'alice', undefined, {})
        .catch((x: unknown) => x);
      expect(codeOf(e)).toBe('NOT_A_MEMBER');
    });

    it('INVITE_NOT_A_GROUP: a 1-to-1 has no invite link', async () => {
      groupMemberRepo.findOne.mockResolvedValue({ userId: 'alice' });
      groupRepo.findOne.mockResolvedValue({ id: 'g1', isGroup: false });
      const e = await controller
        .createGroupInvite('g1', 'alice', undefined, {})
        .catch((x: unknown) => x);
      expect(codeOf(e)).toBe('INVITE_NOT_A_GROUP');
    });

    it('INVITE_INVALID: an unknown token', async () => {
      groupInviteRepo.findOne.mockResolvedValue(null);
      const e = await controller.acceptGroupInvite('nope', 'alice').catch((x: unknown) => x);
      expect(codeOf(e)).toBe('INVITE_INVALID');
    });

    it('NO_ACTIVE_DEVICE: a joiner with no usable key package', async () => {
      groupInviteRepo.findOne.mockResolvedValue({
        groupId: 'g1',
        token: 't',
        revoked: false,
        expiresAt: null,
        maxUses: null,
        uses: 0,
      });
      groupRepo.findOne.mockResolvedValue({ id: 'g1', isGroup: true });
      groupMemberRepo.findOne.mockResolvedValue(null);
      keyPackageRepo.find.mockResolvedValue([]);
      revokedRepo.find.mockResolvedValue([]);
      const e = await controller.acceptGroupInvite('t', 'alice').catch((x: unknown) => x);
      expect(codeOf(e)).toBe('NO_ACTIVE_DEVICE');
    });
  });

  describe('MembersController', () => {
    let controller: MembersController;
    const groupMemberRepo = { count: jest.fn(), findOne: jest.fn() };

    beforeEach(async () => {
      jest.clearAllMocks();
      groupMemberRepo.count.mockResolvedValue(0);
      groupMemberRepo.findOne.mockResolvedValue(null);
      const module: TestingModule = await Test.createTestingModule({
        controllers: [MembersController],
        providers: [
          { provide: getRepositoryToken(GroupMember), useValue: groupMemberRepo },
          { provide: getRepositoryToken(UserDismissedGroup), useValue: {} },
          {
            provide: getRepositoryToken(Group),
            useValue: { findOne: jest.fn().mockResolvedValue({ id: 'g1' }) },
          },
          { provide: getRepositoryToken(KeyPackage), useValue: {} },
          { provide: getRepositoryToken(DeviceGroupMembership), useValue: {} },
          { provide: getRepositoryToken(QueuedMessage), useValue: {} },
          { provide: getRepositoryToken(RevokedDevice), useValue: {} },
          { provide: getRepositoryToken(MlsGroupInfo), useValue: {} },
          { provide: 'REDIS_CLIENT', useValue: {} },
          { provide: DataSource, useValue: { manager: { query: jest.fn() } } },
        ],
      })
        .overrideGuard(HeaderAuthGuard)
        .useValue({ canActivate: () => true })
        .compile();
      controller = module.get(MembersController);
    });

    it('MEMBERSHIP_NOT_ALLOWED: a non-member cannot add somebody else', async () => {
      const e = await controller
        .addGroupMember('g1', { userId: 'bob' }, 'alice', undefined)
        .catch((x: unknown) => x);
      expect(codeOf(e)).toBe('MEMBERSHIP_NOT_ALLOWED');
    });

    it('NOT_A_MEMBER: a non-member cannot read the roster', async () => {
      const e = await controller
        .getGroupUserMembers('g1', 'alice', undefined)
        .catch((x: unknown) => x);
      expect(codeOf(e)).toBe('NOT_A_MEMBER');
    });
  });

  describe('NotificationPreferencesController', () => {
    const g = '0b9f3d7e-1111-4222-8333-444455556666';
    const manager = { update: jest.fn().mockResolvedValue({ affected: 0 }) };
    const controller = new NotificationPreferencesController({
      manager,
    } as unknown as ConstructorParameters<typeof NotificationPreferencesController>[0]);

    it('NOT_A_MEMBER: a level for a conversation the caller is not in', async () => {
      const e = await controller.setGroupLevel('u1', g, { level: 'none' }).catch((x: unknown) => x);
      expect(codeOf(e)).toBe('NOT_A_MEMBER');
    });

    it('NOT_A_MEMBER: the call permission of a conversation the caller is not in', async () => {
      const e = await controller.setGroupCalls('u1', g, { allowed: true }).catch((x: unknown) => x);
      expect(codeOf(e)).toBe('NOT_A_MEMBER');
    });
  });

  describe('SecurityController.changePin', () => {
    const OLD = 'a'.repeat(64);
    const NEW = 'b'.repeat(64);
    const pinRepo = { findOne: jest.fn(), update: jest.fn() };
    let controller: SecurityController;

    beforeEach(async () => {
      jest.clearAllMocks();
      const module: TestingModule = await Test.createTestingModule({
        controllers: [SecurityController],
        providers: [
          { provide: getRepositoryToken(PinVerifier), useValue: pinRepo },
          { provide: getRepositoryToken(RevokedDevice), useValue: {} },
          { provide: getRepositoryToken(KeyPackage), useValue: {} },
          { provide: MessagingService, useValue: {} },
        ],
      })
        .overrideGuard(ThrottlerGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(HeaderAuthGuard)
        .useValue({ canActivate: () => true })
        .compile();
      controller = module.get(SecurityController);
    });

    it('PIN_NOT_SET: an account that never registered a PIN', async () => {
      pinRepo.findOne.mockResolvedValue(null);
      const e = await controller
        .changePin({ userId: 'u1', oldVerifier: OLD, newVerifier: NEW }, 'u1', 'false')
        .catch((x: unknown) => x);
      expect(codeOf(e)).toBe('PIN_NOT_SET');
    });

    it('PIN_INCORRECT: a wrong current PIN, and the lost compare-and-swap alike', async () => {
      pinRepo.findOne.mockResolvedValue({ userId: 'u1', verifier: NEW });
      const wrong = await controller
        .changePin({ userId: 'u1', oldVerifier: OLD, newVerifier: NEW }, 'u1', 'false')
        .catch((x: unknown) => x);
      expect(codeOf(wrong)).toBe('PIN_INCORRECT');

      pinRepo.findOne.mockResolvedValue({ userId: 'u1', verifier: OLD });
      pinRepo.update.mockResolvedValue({ affected: 0 });
      const raced = await controller
        .changePin({ userId: 'u1', oldVerifier: OLD, newVerifier: NEW }, 'u1', 'false')
        .catch((x: unknown) => x);
      expect(codeOf(raced)).toBe('PIN_INCORRECT');
    });
  });
});
