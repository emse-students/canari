/**
 * conversation-flow.e2e.spec.ts
 *
 * Tests d'integration couvrant le cycle de vie COMPLET d'une conversation :
 *
 *  - PARTIE A : Groupe a 2 utilisateurs (user_test1 <-> user_test2)
 *     1. Enregistrement des KeyPackages (2 appareils)
 *     2. Creation du groupe + inscription des membres + Welcome
 *     3. Envoi de messages texte (online et offline)
 *     4. Reception et acquittement des messages
 *     5. Envoi et reception de reactions
 *     6. Envoi et reception de reponses (reply)
 *     7. Renommage du groupe
 *     8. Suppression du groupe
 *
 *  - PARTIE B : Groupe a 3 utilisateurs (user_test1, user_test2, user_test3)
 *     1. Invitation de user_test3 dans le groupe
 *     2. Diffusion multi-destinataires (broadcast)
 *     3. Message avec un destinataire hors-ligne
 *     4. Reaction d'un tiers utilisateur
 *     5. Reply entre des membres non-initiateurs
 *     6. Suppression du groupe a 3
 *
 *  - CLEANUP : suppression de toutes les donnees de test
 *
 * Execution :
 *   cd apps/chat-delivery-service && npm test
 *   make test-history
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { QueuedMessage } from './queued-message.schema';
import { KeyPackage } from './key-package.schema';
import { WelcomeMessage } from './welcome-message.schema';
import { GroupMember } from './group-member.schema';
import { Group } from './group.schema';
import { PinVerifier } from './pin-verifier.schema';

// ---- Fixtures de test -------------------------------------------------------

const USERS = {
  u1: {
    userId: 'user_test1',
    deviceId: 'dev-t1-01',
    kp: 'a1b2c3_kp_user_test1==',
  },
  u2: {
    userId: 'user_test2',
    deviceId: 'dev-t2-01',
    kp: 'a1b2c3_kp_user_test2==',
  },
  u3: {
    userId: 'user_test3',
    deviceId: 'dev-t3-01',
    kp: 'a1b2c3_kp_user_test3==',
  },
} as const;

// Content fictif base64 representant des messages MLS chiffres
const CONTENT = {
  msgHello: 'aGVsbG8gd29ybGQ=',
  msgHi: 'aGkgdGhlcmU=',
  msgTriangle: 'YSBtZXNzYWdl',
  reaction: 'eyJlbW9qaSI6IvCfkYkiLCJtZXNzYWdlSWQiOiJtc2ctMDAxIn0=',
  replyBody: 'eyJyZXBseVRvIjoibXNnLTAwMSIsImNvbnRlbnQiOiJSZXBvbnNlIn0=',
  commit: 'Y29tbWl0X21scw==',
  rename: 'cmVuYW1lX2V2ZW50',
  deleteEvt: 'ZGVsZXRlX2V2ZW50',
} as const;

// ---- Helpers ----------------------------------------------------------------

function buildModelMock(overrides: Record<string, jest.Mock> = {}) {
  const mock: Record<string, jest.Mock> = {
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn().mockReturnThis(),
    updateOne: jest.fn().mockReturnThis(),
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(null),
    bulkWrite: jest.fn().mockResolvedValue({ insertedCount: 0 }),
    insertMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return mock;
}

function buildRedisMock() {
  return {
    exists: jest.fn().mockResolvedValue(0),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    del: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    lpush: jest.fn().mockResolvedValue(1),
    xrange: jest.fn().mockResolvedValue([]),
  };
}

/** Construit un ObjectId MongoDB valide pour les tests d'ACK. */
function fakeId(): string {
  return new Types.ObjectId().toHexString();
}

interface TestEnv {
  ctrl: AppController;
  kpModel: ReturnType<typeof buildModelMock>;
  welcomeModel: ReturnType<typeof buildModelMock>;
  groupModel: ReturnType<typeof buildModelMock>;
  memberModel: ReturnType<typeof buildModelMock>;
  queueModel: ReturnType<typeof buildModelMock>;
  pinModel: ReturnType<typeof buildModelMock>;
  redis: ReturnType<typeof buildRedisMock>;
  app: TestingModule;
}

async function buildTestEnv(): Promise<TestEnv> {
  const kpModel = buildModelMock();
  const welcomeModel = buildModelMock();
  const groupModel = buildModelMock();
  const memberModel = buildModelMock();
  const queueModel = buildModelMock();
  const pinModel = buildModelMock();
  const redis = buildRedisMock();

  const moduleRef = await Test.createTestingModule({
    controllers: [AppController],
    providers: [
      { provide: getModelToken(QueuedMessage.name), useValue: queueModel },
      { provide: getModelToken(KeyPackage.name), useValue: kpModel },
      { provide: getModelToken(WelcomeMessage.name), useValue: welcomeModel },
      { provide: getModelToken(GroupMember.name), useValue: memberModel },
      { provide: getModelToken(Group.name), useValue: groupModel },
      { provide: getModelToken(PinVerifier.name), useValue: pinModel },
      { provide: 'REDIS_CLIENT', useValue: redis },
    ],
  }).compile();

  return {
    ctrl: moduleRef.get(AppController),
    kpModel,
    welcomeModel,
    groupModel,
    memberModel,
    queueModel,
    pinModel,
    redis,
    app: moduleRef,
  };
}

// ============================================================================
// PARTIE A - Groupe a 2 utilisateurs
// ============================================================================

describe('PARTIE A - Groupe a 2 utilisateurs (user_test1 <> user_test2)', () => {
  let env: TestEnv;
  let groupId: string;

  beforeEach(async () => {
    env = await buildTestEnv();
  });
  afterEach(async () => {
    await env.app.close();
  });

  // ---- A.1 : Enregistrement des KeyPackages --------------------------------

  describe('A.1 - Enregistrement des KeyPackages', () => {
    it('user_test1 enregistre son appareil', async () => {
      const res = await env.ctrl.registerDevice({
        userId: USERS.u1.userId,
        deviceId: USERS.u1.deviceId,
        keyPackage: USERS.u1.kp,
      });
      expect(res).toEqual({ status: 'registered' });
      expect(env.kpModel.updateOne).toHaveBeenCalledWith(
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
        { $set: { keyPackage: USERS.u1.kp, createdAt: expect.any(Date) } },
        { upsert: true },
      );
    });

    it('user_test2 enregistre son appareil', async () => {
      const res = await env.ctrl.registerDevice({
        userId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
        keyPackage: USERS.u2.kp,
      });
      expect(res).toEqual({ status: 'registered' });
    });

    it('user_test1 peut mettre a jour (rotation de cle)', async () => {
      await env.ctrl.registerDevice({
        userId: USERS.u1.userId,
        deviceId: USERS.u1.deviceId,
        keyPackage: 'kp_v1',
      });
      await env.ctrl.registerDevice({
        userId: USERS.u1.userId,
        deviceId: USERS.u1.deviceId,
        keyPackage: 'kp_v2',
      });
      expect(env.kpModel.updateOne).toHaveBeenCalledTimes(2);
      expect(env.kpModel.updateOne.mock.calls[1][1].$set.keyPackage).toBe(
        'kp_v2',
      );
    });

    it('GET /devices retourne les devices de user_test2 (< 30 jours)', async () => {
      env.kpModel.exec.mockResolvedValueOnce([
        {
          userId: USERS.u2.userId,
          deviceId: USERS.u2.deviceId,
          keyPackage: USERS.u2.kp,
          createdAt: new Date(),
        },
      ]);
      const devices = await env.ctrl.getUserDevices(USERS.u2.userId);
      expect(devices).toHaveLength(1);
      expect(devices[0].deviceId).toBe(USERS.u2.deviceId);
      expect(env.kpModel.find).toHaveBeenCalledWith({
        userId: USERS.u2.userId,
        createdAt: { $gte: expect.any(Date) },
      });
    });

    it('GET /devices retourne [] si user_test2 jamais connecte (blocage 1)', async () => {
      env.kpModel.exec.mockResolvedValueOnce([]);
      const devices = await env.ctrl.getUserDevices('user_test_nouveau');
      expect(devices).toEqual([]);
    });
  });

  // ---- A.2 : Creation du groupe et inscription ----------------------------

  describe('A.2 - Creation du groupe et inscription des membres', () => {
    it('cree le groupe "user_test1 & user_test2"', async () => {
      const res = await env.ctrl.createGroup({
        name: 'user_test1 & user_test2',
        createdBy: USERS.u1.userId,
      });
      groupId = res.groupId;
      expect(groupId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.name).toBe('user_test1 & user_test2');
    });

    it('inscrit user_test1 comme membre + synchro Redis', async () => {
      const res = await env.ctrl.createGroup({
        name: 'g-a2',
        createdBy: USERS.u1.userId,
      });
      groupId = res.groupId;
      const addRes = await env.ctrl.addGroupMember(groupId, {
        userId: USERS.u1.userId,
        deviceId: USERS.u1.deviceId,
      });
      expect(addRes).toEqual({ status: 'added' });
      expect(env.memberModel.updateOne).toHaveBeenCalledWith(
        { groupId, userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
        { $set: { joinedAt: expect.any(Date) } },
        { upsert: true },
      );
      expect(env.redis.sadd).toHaveBeenCalledWith(
        `group:members:${groupId}`,
        `${USERS.u1.userId}:${USERS.u1.deviceId}`,
      );
    });

    it('inscrit user_test2 comme membre + synchro Redis', async () => {
      const res = await env.ctrl.createGroup({
        name: 'g-a2b',
        createdBy: USERS.u1.userId,
      });
      groupId = res.groupId;
      await env.ctrl.addGroupMember(groupId, {
        userId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
      });
      expect(env.redis.sadd).toHaveBeenCalledWith(
        `group:members:${groupId}`,
        `${USERS.u2.userId}:${USERS.u2.deviceId}`,
      );
    });

    it('liste les 2 membres du groupe', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'g-list',
        createdBy: USERS.u1.userId,
      });
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId, groupId: gid },
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId, groupId: gid },
      ]);
      const members = await env.ctrl.getGroupMembers(gid);
      expect(members).toHaveLength(2);
      expect(members.map((m: any) => m.userId)).toEqual([
        USERS.u1.userId,
        USERS.u2.userId,
      ]);
    });

    it('Welcome OFFLINE : stocke en MongoDB pour user_test2', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'g-w-offline',
        createdBy: USERS.u1.userId,
      });
      env.kpModel.findOne.mockReturnThis();
      env.kpModel.exec.mockResolvedValueOnce({
        userId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
      });
      env.redis.exists.mockResolvedValueOnce(0);
      const res = await env.ctrl.sendWelcome({
        targetDeviceId: USERS.u2.deviceId,
        targetUserId: USERS.u2.userId,
        senderUserId: USERS.u1.userId,
        welcomePayload: 'welcome_b64==',
        groupId: gid,
      });
      expect(res).toEqual({ status: 'queued' });
      expect(env.welcomeModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: USERS.u2.deviceId,
          userId: USERS.u2.userId,
          senderUserId: USERS.u1.userId,
          groupId: gid,
          message: 'welcome_b64==',
        }),
      );
      expect(env.redis.publish).not.toHaveBeenCalled();
    });

    it('Welcome ONLINE : publie via Redis en temps-reel pour user_test2', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'g-w-online',
        createdBy: USERS.u1.userId,
      });
      env.kpModel.findOne.mockReturnThis();
      env.kpModel.exec.mockResolvedValueOnce({
        userId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
      });
      env.redis.exists.mockResolvedValueOnce(1);
      await env.ctrl.sendWelcome({
        targetDeviceId: USERS.u2.deviceId,
        targetUserId: USERS.u2.userId,
        senderUserId: USERS.u1.userId,
        welcomePayload: 'welcome_online_b64==',
        groupId: gid,
      });
      expect(env.redis.exists).toHaveBeenCalledWith(
        `user:online:${USERS.u2.userId}:${USERS.u2.deviceId}`,
      );
      expect(env.redis.publish).toHaveBeenCalledWith(
        'chat:messages',
        JSON.stringify({
          recipientId: USERS.u2.userId,
          deviceId: USERS.u2.deviceId,
          senderId: USERS.u1.userId,
          groupId: gid,
          content: 'welcome_online_b64==',
          type: 'mlsWelcome',
        }),
      );
    });

    it('user_test2 recupere son Welcome en attente (ephemere)', async () => {
      const welcomeData = [
        {
          deviceId: USERS.u2.deviceId,
          userId: USERS.u2.userId,
          senderUserId: USERS.u1.userId,
          groupId: 'g-x',
          message: 'wlc==',
        },
      ];
      env.welcomeModel.find.mockReturnThis();
      env.welcomeModel.exec.mockResolvedValueOnce(welcomeData);
      const result = await env.ctrl.getWelcomeMessages(USERS.u2.deviceId);
      expect(result).toEqual(welcomeData);
      expect(env.welcomeModel.deleteMany).toHaveBeenCalledWith({
        deviceId: USERS.u2.deviceId,
      });
    });
  });

  // ---- A.3 : Envoi et reception de messages texte ------------------------

  describe('A.3 - Envoi et reception de messages texte', () => {
    it('user_test1 ONLINE envoie un message -> livraison Redis directe a user_test2', async () => {
      const gid = 'group-a3-online';
      env.redis.exists.mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.msgHello,
      });
      expect(res).toEqual({ status: 'processed', queued: 0, sent: 1 });
      expect(env.redis.publish).toHaveBeenCalledWith(
        'chat:messages',
        JSON.stringify({
          recipientId: USERS.u2.userId,
          deviceId: USERS.u2.deviceId,
          senderId: USERS.u1.userId,
          senderDeviceId: USERS.u1.deviceId,
          groupId: gid,
          content: CONTENT.msgHello,
          type: undefined,
        }),
      );
      expect(env.queueModel.bulkWrite).not.toHaveBeenCalled();
    });

    it('user_test1 OFFLINE envoie un message -> stocke en file MongoDB', async () => {
      const gid = 'group-a3-offline';
      env.redis.exists.mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.msgHi,
      });
      expect(res).toEqual({ status: 'processed', queued: 1, sent: 0 });
      expect(env.queueModel.bulkWrite).toHaveBeenCalledTimes(1);
      const op = env.queueModel.bulkWrite.mock.calls[0][0][0];
      expect(op.insertOne.document).toMatchObject({
        recipientId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
        senderId: USERS.u1.userId,
        groupId: gid,
        content: CONTENT.msgHi,
      });
    });

    it('user_test2 ONLINE repond -> livraison directe a user_test1', async () => {
      const gid = 'group-a3-reply-online';
      env.redis.exists.mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u2.userId,
        senderDeviceId: USERS.u2.deviceId,
        groupId: gid,
        content: CONTENT.msgHi,
      });
      expect(res.sent).toBe(1);
      expect(env.redis.publish).toHaveBeenCalledWith(
        'chat:messages',
        expect.stringContaining(USERS.u1.userId),
      );
    });

    it('user_test2 recupere ses messages en attente (polling)', async () => {
      const msgId = fakeId();
      const queued = [
        {
          _id: msgId,
          recipientId: USERS.u2.userId,
          deviceId: USERS.u2.deviceId,
          senderId: USERS.u1.userId,
          groupId: 'g-poll',
          content: CONTENT.msgHello,
        },
      ];
      env.queueModel.exec.mockResolvedValueOnce(queued);
      const result = await env.ctrl.fetchMessages(
        USERS.u2.userId,
        USERS.u2.deviceId,
      );
      expect(result).toEqual(queued);
      expect(env.queueModel.find).toHaveBeenCalledWith({
        recipientId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
      });
    });

    it('user_test2 acquitte les messages recus', async () => {
      const msgId1 = fakeId();
      const msgId2 = fakeId();
      env.queueModel.deleteMany.mockResolvedValueOnce({ deletedCount: 2 });
      const res = await env.ctrl.acknowledgeMessages({
        userId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
        messageIds: [msgId1, msgId2],
      });
      expect(res).toEqual({ status: 'deleted', count: 2 });
      expect(env.queueModel.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientId: USERS.u2.userId,
          deviceId: USERS.u2.deviceId,
        }),
      );
    });

    it('ACK avec liste vide retourne "ignored"', async () => {
      const res = await env.ctrl.acknowledgeMessages({
        userId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
        messageIds: [],
      });
      expect(res).toEqual({ status: 'ignored' });
      expect(env.queueModel.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ---- A.4 : Reactions ----------------------------------------------------

  describe('A.4 - Envoi et reception de reactions', () => {
    it('user_test2 ONLINE envoie une reaction a user_test1', async () => {
      const gid = 'group-a4-reaction';
      env.redis.exists.mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u2.userId,
        senderDeviceId: USERS.u2.deviceId,
        groupId: gid,
        content: CONTENT.reaction,
        type: 'reaction',
      });
      expect(res).toEqual({ status: 'processed', queued: 0, sent: 1 });
      const published = JSON.parse(env.redis.publish.mock.calls[0][1]);
      expect(published.type).toBe('reaction');
      expect(published.content).toBe(CONTENT.reaction);
      expect(published.recipientId).toBe(USERS.u1.userId);
    });

    it('user_test2 OFFLINE envoie une reaction -> queue MongoDB avec type "reaction"', async () => {
      const gid = 'group-a4-reaction-offline';
      env.redis.exists.mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u2.userId,
        senderDeviceId: USERS.u2.deviceId,
        groupId: gid,
        content: CONTENT.reaction,
        type: 'reaction',
      });
      expect(res.queued).toBe(1);
      const op = env.queueModel.bulkWrite.mock.calls[0][0][0];
      expect(op.insertOne.document.type).toBe('reaction');
      expect(op.insertOne.document.content).toBe(CONTENT.reaction);
    });

    it('user_test1 recupere la reaction en attente (polling)', async () => {
      const msgId = fakeId();
      env.queueModel.exec.mockResolvedValueOnce([
        {
          _id: msgId,
          recipientId: USERS.u1.userId,
          deviceId: USERS.u1.deviceId,
          senderId: USERS.u2.userId,
          groupId: 'g-r',
          content: CONTENT.reaction,
          type: 'reaction',
        },
      ]);
      const result = await env.ctrl.fetchMessages(
        USERS.u1.userId,
        USERS.u1.deviceId,
      );
      expect(result[0].type).toBe('reaction');
      expect(result[0].content).toBe(CONTENT.reaction);
    });

    it('user_test1 acquitte la reaction', async () => {
      const msgId = fakeId();
      env.queueModel.deleteMany.mockResolvedValueOnce({ deletedCount: 1 });
      const res = await env.ctrl.acknowledgeMessages({
        userId: USERS.u1.userId,
        deviceId: USERS.u1.deviceId,
        messageIds: [msgId],
      });
      expect(res).toEqual({ status: 'deleted', count: 1 });
    });
  });

  // ---- A.5 : Reponses (reply) ---------------------------------------------

  describe('A.5 - Envoi et reception de reponses (reply)', () => {
    it('user_test1 ONLINE envoie une reponse a un message de user_test2', async () => {
      const gid = 'group-a5-reply';
      env.redis.exists.mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.replyBody,
        type: 'chat',
      });
      expect(res.sent).toBe(1);
      const published = JSON.parse(env.redis.publish.mock.calls[0][1]);
      expect(published.content).toBe(CONTENT.replyBody);
      expect(published.senderId).toBe(USERS.u1.userId);
    });

    it('user_test2 OFFLINE recoit une reponse -> queue MongoDB', async () => {
      const gid = 'group-a5-reply-offline';
      env.redis.exists.mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.replyBody,
        type: 'chat',
      });
      expect(res.queued).toBe(1);
      const op = env.queueModel.bulkWrite.mock.calls[0][0][0];
      expect(op.insertOne.document.content).toBe(CONTENT.replyBody);
      expect(op.insertOne.document.senderId).toBe(USERS.u1.userId);
    });

    it('user_test2 recupere la reponse via polling', async () => {
      const msgId = fakeId();
      env.queueModel.exec.mockResolvedValueOnce([
        {
          _id: msgId,
          recipientId: USERS.u2.userId,
          deviceId: USERS.u2.deviceId,
          senderId: USERS.u1.userId,
          content: CONTENT.replyBody,
          type: 'chat',
        },
      ]);
      const result = await env.ctrl.fetchMessages(
        USERS.u2.userId,
        USERS.u2.deviceId,
      );
      expect(result[0].content).toBe(CONTENT.replyBody);
    });

    it('user_test2 acquitte la reponse', async () => {
      const msgId = fakeId();
      env.queueModel.deleteMany.mockResolvedValueOnce({ deletedCount: 1 });
      const res = await env.ctrl.acknowledgeMessages({
        userId: USERS.u2.userId,
        deviceId: USERS.u2.deviceId,
        messageIds: [msgId],
      });
      expect(res).toEqual({ status: 'deleted', count: 1 });
    });

    it('envoi avec destinataires explicites (ciblage precis)', async () => {
      const gid = 'group-a5-explicit';
      env.redis.exists.mockResolvedValueOnce(1);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        recipients: [{ userId: USERS.u2.userId, deviceId: USERS.u2.deviceId }],
        groupId: gid,
        content: CONTENT.replyBody,
        type: 'chat',
      });
      expect(res.sent).toBe(1);
      expect(env.memberModel.find).not.toHaveBeenCalled();
    });
  });

  // ---- A.6 : Renommage du groupe ------------------------------------------

  describe('A.6 - Renommage du groupe', () => {
    it('user_test1 renomme le groupe', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'Ancien Nom',
        createdBy: USERS.u1.userId,
      });
      const res = await env.ctrl.renameGroup(gid, { name: 'Nouveau Nom' });
      expect(res).toEqual({ status: 'renamed' });
      expect(env.groupModel.updateOne).toHaveBeenCalledWith(
        { groupId: gid },
        { $set: { name: 'Nouveau Nom' } },
      );
    });

    it('la notification de renommage est distribuee aux membres ONLINE', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'Nom 1',
        createdBy: USERS.u1.userId,
      });
      await env.ctrl.renameGroup(gid, { name: 'Nom 2' });
      env.redis.exists.mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.rename,
        type: 'handshake',
      });
      expect(env.redis.publish).toHaveBeenCalledTimes(1);
      const published = JSON.parse(env.redis.publish.mock.calls[0][1]);
      expect(published.recipientId).toBe(USERS.u2.userId);
    });

    it('la notification de renommage est queued pour user_test2 OFFLINE', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'N1',
        createdBy: USERS.u1.userId,
      });
      env.redis.exists.mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.rename,
        type: 'handshake',
      });
      expect(env.queueModel.bulkWrite).toHaveBeenCalled();
    });

    it('rejette un renommage avec un nom vide', async () => {
      await expect(
        env.ctrl.renameGroup('group-x', { name: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejette un renommage avec uniquement des espaces', async () => {
      await expect(
        env.ctrl.renameGroup('group-x', { name: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---- A.7 : Suppression du groupe ----------------------------------------

  describe('A.7 - Suppression du groupe (2 utilisateurs)', () => {
    it('supprime le groupe, ses membres et la cle Redis', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'g-del-2',
        createdBy: USERS.u1.userId,
      });
      const res = await env.ctrl.deleteGroup(gid);
      expect(res).toEqual({ status: 'deleted' });
      expect(env.groupModel.deleteOne).toHaveBeenCalledWith({ groupId: gid });
      expect(env.memberModel.deleteMany).toHaveBeenCalledWith({ groupId: gid });
      expect(env.redis.del).toHaveBeenCalledWith(`group:members:${gid}`);
    });

    it('evenement "groupDeleted" distribue aux membres ONLINE avant suppression', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'g-del-2-evt',
        createdBy: USERS.u1.userId,
      });
      env.redis.exists.mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.deleteEvt,
        type: 'handshake',
      });
      await env.ctrl.deleteGroup(gid);
      expect(env.redis.publish).toHaveBeenCalledTimes(1);
      expect(env.groupModel.deleteOne).toHaveBeenCalledWith({ groupId: gid });
    });

    it('evenement "groupDeleted" queued pour user_test2 OFFLINE', async () => {
      const { groupId: gid } = await env.ctrl.createGroup({
        name: 'g-del-2-off',
        createdBy: USERS.u1.userId,
      });
      env.redis.exists.mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId: gid,
        content: CONTENT.deleteEvt,
        type: 'handshake',
      });
      await env.ctrl.deleteGroup(gid);
      expect(env.queueModel.bulkWrite).toHaveBeenCalled();
      expect(env.groupModel.deleteOne).toHaveBeenCalledWith({ groupId: gid });
    });

    it('rejette la suppression avec un groupId contenant des caracteres dangereux', async () => {
      await expect(env.ctrl.deleteGroup('../etc/passwd')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});

// ============================================================================
// PARTIE B - Groupe a 3 utilisateurs
// ============================================================================

describe('PARTIE B - Groupe a 3 utilisateurs (user_test1, user_test2, user_test3)', () => {
  let env: TestEnv;
  let groupId: string;

  beforeEach(async () => {
    env = await buildTestEnv();
  });
  afterEach(async () => {
    await env.app.close();
  });

  async function setupGroup3(): Promise<string> {
    const { groupId: gid } = await env.ctrl.createGroup({
      name: 'user_test1 & user_test2 & user_test3',
      createdBy: USERS.u1.userId,
    });
    await env.ctrl.addGroupMember(gid, {
      userId: USERS.u1.userId,
      deviceId: USERS.u1.deviceId,
    });
    await env.ctrl.addGroupMember(gid, {
      userId: USERS.u2.userId,
      deviceId: USERS.u2.deviceId,
    });
    await env.ctrl.addGroupMember(gid, {
      userId: USERS.u3.userId,
      deviceId: USERS.u3.deviceId,
    });
    return gid;
  }

  // ---- B.1 : Invitation de user_test3 -------------------------------------

  describe('B.1 - Invitation de user_test3 dans le groupe', () => {
    it('user_test3 enregistre son KeyPackage', async () => {
      const res = await env.ctrl.registerDevice({
        userId: USERS.u3.userId,
        deviceId: USERS.u3.deviceId,
        keyPackage: USERS.u3.kp,
      });
      expect(res).toEqual({ status: 'registered' });
    });

    it('GET /devices retourne le device de user_test3', async () => {
      env.kpModel.exec.mockResolvedValueOnce([
        {
          userId: USERS.u3.userId,
          deviceId: USERS.u3.deviceId,
          keyPackage: USERS.u3.kp,
          createdAt: new Date(),
        },
      ]);
      const devices = await env.ctrl.getUserDevices(USERS.u3.userId);
      expect(devices).toHaveLength(1);
      expect(devices[0].userId).toBe(USERS.u3.userId);
    });

    it('user_test3 est inscrit comme membre + synchro Redis', async () => {
      groupId = await setupGroup3();
      expect(env.memberModel.updateOne).toHaveBeenCalledTimes(3);
      expect(env.redis.sadd).toHaveBeenCalledWith(
        `group:members:${groupId}`,
        `${USERS.u3.userId}:${USERS.u3.deviceId}`,
      );
    });

    it('Welcome envoye a user_test3 (OFFLINE)', async () => {
      groupId = await setupGroup3();
      env.kpModel.findOne.mockReturnThis();
      env.kpModel.exec.mockResolvedValueOnce({
        userId: USERS.u3.userId,
        deviceId: USERS.u3.deviceId,
      });
      env.redis.exists.mockResolvedValueOnce(0);
      await env.ctrl.sendWelcome({
        targetDeviceId: USERS.u3.deviceId,
        targetUserId: USERS.u3.userId,
        senderUserId: USERS.u1.userId,
        welcomePayload: 'wlc_u3==',
        groupId,
      });
      expect(env.welcomeModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USERS.u3.userId,
          senderUserId: USERS.u1.userId,
        }),
      );
    });

    it('Welcome envoye a user_test3 (ONLINE)', async () => {
      groupId = await setupGroup3();
      env.kpModel.findOne.mockReturnThis();
      env.kpModel.exec.mockResolvedValueOnce({
        userId: USERS.u3.userId,
        deviceId: USERS.u3.deviceId,
      });
      env.redis.exists.mockResolvedValueOnce(1);
      await env.ctrl.sendWelcome({
        targetDeviceId: USERS.u3.deviceId,
        targetUserId: USERS.u3.userId,
        senderUserId: USERS.u1.userId,
        welcomePayload: 'wlc_u3_live==',
        groupId,
      });
      expect(env.redis.publish).toHaveBeenCalledWith(
        'chat:messages',
        expect.stringContaining('"type":"mlsWelcome"'),
      );
    });

    it('groupe a 3 liste 3 membres', async () => {
      groupId = await setupGroup3();
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      const members = await env.ctrl.getGroupMembers(groupId);
      expect(members).toHaveLength(3);
    });
  });

  // ---- B.2 : Broadcast multi-destinataires --------------------------------

  describe('B.2 - Diffusion multi-destinataires (broadcast a 3)', () => {
    beforeEach(async () => {
      groupId = await setupGroup3();
    });

    it('user_test1 ONLINE -> message livre en direct a user_test2 et user_test3', async () => {
      env.redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId,
        content: CONTENT.msgHello,
      });
      expect(res).toEqual({ status: 'processed', queued: 0, sent: 2 });
      expect(env.redis.publish).toHaveBeenCalledTimes(2);
      const destinations = env.redis.publish.mock.calls.map(
        ([, body]: [string, string]) => JSON.parse(body).recipientId,
      );
      expect(destinations).toContain(USERS.u2.userId);
      expect(destinations).toContain(USERS.u3.userId);
    });

    it('user_test1 MESSAGE -> user_test2 online / user_test3 offline (split)', async () => {
      env.redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId,
        content: CONTENT.msgTriangle,
      });
      expect(res).toEqual({ status: 'processed', queued: 1, sent: 1 });
      const publishedTo = JSON.parse(
        env.redis.publish.mock.calls[0][1],
      ).recipientId;
      const queuedTo =
        env.queueModel.bulkWrite.mock.calls[0][0][0].insertOne.document
          .recipientId;
      expect(publishedTo).toBe(USERS.u2.userId);
      expect(queuedTo).toBe(USERS.u3.userId);
    });

    it('user_test1 MESSAGE -> tous OFFLINE -> 2 messages en file', async () => {
      env.redis.exists.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId,
        content: CONTENT.msgHello,
      });
      expect(res).toEqual({ status: 'processed', queued: 2, sent: 0 });
      expect(env.queueModel.bulkWrite).toHaveBeenCalledTimes(1);
      expect(env.queueModel.bulkWrite.mock.calls[0][0]).toHaveLength(2);
    });
  });

  // ---- B.3 : Reaction d'un tiers utilisateur ------------------------------

  describe('B.3 - Reaction de user_test3 dans un groupe a 3', () => {
    beforeEach(async () => {
      groupId = await setupGroup3();
    });

    it('user_test3 ONLINE envoie une reaction -> livree a user_test1 et user_test2', async () => {
      env.redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u3.userId,
        senderDeviceId: USERS.u3.deviceId,
        groupId,
        content: CONTENT.reaction,
        type: 'reaction',
      });
      expect(res).toEqual({ status: 'processed', queued: 0, sent: 2 });
      const calls = env.redis.publish.mock.calls.map(
        ([, body]: [string, string]) => JSON.parse(body),
      );
      expect(calls[0].type).toBe('reaction');
      expect(calls[0].senderId).toBe(USERS.u3.userId);
      const recipients = calls.map((c: any) => c.recipientId);
      expect(recipients).toContain(USERS.u1.userId);
      expect(recipients).toContain(USERS.u2.userId);
    });

    it('user_test3 OFFLINE reaction -> queued pour user_test1 et user_test2', async () => {
      env.redis.exists.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u3.userId,
        senderDeviceId: USERS.u3.deviceId,
        groupId,
        content: CONTENT.reaction,
        type: 'reaction',
      });
      expect(res.queued).toBe(2);
      const ops = env.queueModel.bulkWrite.mock.calls[0][0];
      expect(ops).toHaveLength(2);
      expect(
        ops.every((op: any) => op.insertOne.document.type === 'reaction'),
      ).toBe(true);
    });
  });

  // ---- B.4 : Reply entre membres non-initiateurs --------------------------

  describe('B.4 - Reply de user_test2 dans un groupe a 3', () => {
    beforeEach(async () => {
      groupId = await setupGroup3();
    });

    it('user_test2 ONLINE repond -> livre a user_test1 et user_test3', async () => {
      env.redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u2.userId,
        senderDeviceId: USERS.u2.deviceId,
        groupId,
        content: CONTENT.replyBody,
        type: 'chat',
      });
      expect(res.sent).toBe(2);
      const recipients = env.redis.publish.mock.calls.map(
        ([, body]: [string, string]) => JSON.parse(body).recipientId,
      );
      expect(recipients).toContain(USERS.u1.userId);
      expect(recipients).toContain(USERS.u3.userId);
    });

    it('user_test2 OFFLINE reply -> queued pour user_test1 et user_test3', async () => {
      env.redis.exists.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u1.userId, deviceId: USERS.u1.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      const res = await env.ctrl.sendMessage({
        senderId: USERS.u2.userId,
        senderDeviceId: USERS.u2.deviceId,
        groupId,
        content: CONTENT.replyBody,
        type: 'chat',
      });
      expect(res.queued).toBe(2);
      const ops = env.queueModel.bulkWrite.mock.calls[0][0];
      const recipients = ops.map(
        (op: any) => op.insertOne.document.recipientId,
      );
      expect(recipients).toContain(USERS.u1.userId);
      expect(recipients).toContain(USERS.u3.userId);
    });
  });

  // ---- B.5 : Retrait de user_test3 ----------------------------------------

  describe('B.5 - Retrait de user_test3 du groupe', () => {
    beforeEach(async () => {
      groupId = await setupGroup3();
    });

    it('supprime user_test3 de MongoDB et nettoie Redis', async () => {
      env.redis.smembers.mockResolvedValueOnce([
        `${USERS.u3.userId}:${USERS.u3.deviceId}`,
        `${USERS.u1.userId}:${USERS.u1.deviceId}`,
        `${USERS.u2.userId}:${USERS.u2.deviceId}`,
      ]);
      const res = await env.ctrl.removeGroupMember(groupId, USERS.u3.userId);
      expect(res).toEqual({ status: 'removed' });
      expect(env.memberModel.deleteMany).toHaveBeenCalledWith({
        groupId,
        userId: USERS.u3.userId,
      });
      expect(env.redis.srem).toHaveBeenCalledWith(
        `group:members:${groupId}`,
        `${USERS.u3.userId}:${USERS.u3.deviceId}`,
      );
    });
  });

  // ---- B.6 : Renommage du groupe a 3 --------------------------------------

  describe('B.6 - Renommage du groupe a 3', () => {
    beforeEach(async () => {
      groupId = await setupGroup3();
    });

    it('renomme le groupe a 3', async () => {
      const res = await env.ctrl.renameGroup(groupId, { name: 'Equipe Core' });
      expect(res).toEqual({ status: 'renamed' });
      expect(env.groupModel.updateOne).toHaveBeenCalledWith(
        { groupId },
        { $set: { name: 'Equipe Core' } },
      );
    });

    it('notification de renommage -> livree aux 2 autres membres ONLINE', async () => {
      env.redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId,
        content: CONTENT.rename,
        type: 'handshake',
      });
      expect(env.redis.publish).toHaveBeenCalledTimes(2);
    });
  });

  // ---- B.7 : Suppression du groupe a 3 ------------------------------------

  describe('B.7 - Suppression du groupe a 3 utilisateurs', () => {
    beforeEach(async () => {
      groupId = await setupGroup3();
    });

    it('supprime le groupe et purge MongoDB + Redis', async () => {
      const res = await env.ctrl.deleteGroup(groupId);
      expect(res).toEqual({ status: 'deleted' });
      expect(env.groupModel.deleteOne).toHaveBeenCalledWith({ groupId });
      expect(env.memberModel.deleteMany).toHaveBeenCalledWith({ groupId });
      expect(env.redis.del).toHaveBeenCalledWith(`group:members:${groupId}`);
    });

    it('notification "groupDeleted" -> livree aux 2 autres membres ONLINE', async () => {
      env.redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId,
        content: CONTENT.deleteEvt,
        type: 'handshake',
      });
      await env.ctrl.deleteGroup(groupId);
      expect(env.redis.publish).toHaveBeenCalledTimes(2);
      expect(env.groupModel.deleteOne).toHaveBeenCalledWith({ groupId });
    });

    it('notification "groupDeleted" -> queued pour user_test2 et user_test3 OFFLINE', async () => {
      env.redis.exists.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      env.memberModel.exec.mockResolvedValueOnce([
        { userId: USERS.u2.userId, deviceId: USERS.u2.deviceId },
        { userId: USERS.u3.userId, deviceId: USERS.u3.deviceId },
      ]);
      await env.ctrl.sendMessage({
        senderId: USERS.u1.userId,
        senderDeviceId: USERS.u1.deviceId,
        groupId,
        content: CONTENT.deleteEvt,
        type: 'handshake',
      });
      await env.ctrl.deleteGroup(groupId);
      expect(env.queueModel.bulkWrite).toHaveBeenCalled();
      expect(env.queueModel.bulkWrite.mock.calls[0][0]).toHaveLength(2);
    });
  });
});

// ============================================================================
// PARTIE C - Cleanup des donnees de test
// ============================================================================

describe('PARTIE C - Cleanup des users de test', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await buildTestEnv();
  });
  afterEach(async () => {
    await env.app.close();
  });

  it('suppression du groupe user_test1 & user_test2 : purge MongoDB + Redis', async () => {
    const { groupId: gid } = await env.ctrl.createGroup({
      name: 'user_test1 & user_test2',
      createdBy: USERS.u1.userId,
    });
    await env.ctrl.deleteGroup(gid);
    expect(env.groupModel.deleteOne).toHaveBeenCalledWith({ groupId: gid });
    expect(env.memberModel.deleteMany).toHaveBeenCalledWith({ groupId: gid });
    expect(env.redis.del).toHaveBeenCalledWith(`group:members:${gid}`);
  });

  it('suppression du groupe a 3 : purge MongoDB + Redis', async () => {
    const { groupId: gid } = await env.ctrl.createGroup({
      name: 'user_test1 & user_test2 & user_test3',
      createdBy: USERS.u1.userId,
    });
    await env.ctrl.deleteGroup(gid);
    expect(env.groupModel.deleteOne).toHaveBeenCalledWith({ groupId: gid });
    expect(env.memberModel.deleteMany).toHaveBeenCalledWith({ groupId: gid });
    expect(env.redis.del).toHaveBeenCalledWith(`group:members:${gid}`);
  });

  it('retrait de user_test1 : purge membres MongoDB + Redis srem', async () => {
    const { groupId: gid } = await env.ctrl.createGroup({
      name: 'g-cleanup',
      createdBy: USERS.u1.userId,
    });
    env.redis.smembers.mockResolvedValueOnce([
      `${USERS.u1.userId}:${USERS.u1.deviceId}`,
      `${USERS.u2.userId}:${USERS.u2.deviceId}`,
    ]);
    const res = await env.ctrl.removeGroupMember(gid, USERS.u1.userId);
    expect(res).toEqual({ status: 'removed' });
    expect(env.memberModel.deleteMany).toHaveBeenCalledWith({
      groupId: gid,
      userId: USERS.u1.userId,
    });
    expect(env.redis.srem).toHaveBeenCalledWith(
      `group:members:${gid}`,
      `${USERS.u1.userId}:${USERS.u1.deviceId}`,
    );
  });

  it('retrait de user_test2 : purge membres MongoDB + Redis srem', async () => {
    const { groupId: gid } = await env.ctrl.createGroup({
      name: 'g-cleanup-2',
      createdBy: USERS.u1.userId,
    });
    env.redis.smembers.mockResolvedValueOnce([
      `${USERS.u2.userId}:${USERS.u2.deviceId}`,
    ]);
    await env.ctrl.removeGroupMember(gid, USERS.u2.userId);
    expect(env.redis.srem).toHaveBeenCalledWith(
      `group:members:${gid}`,
      `${USERS.u2.userId}:${USERS.u2.deviceId}`,
    );
  });

  it('retrait de user_test3 : purge membres MongoDB + Redis srem', async () => {
    const { groupId: gid } = await env.ctrl.createGroup({
      name: 'g-cleanup-3',
      createdBy: USERS.u1.userId,
    });
    env.redis.smembers.mockResolvedValueOnce([
      `${USERS.u3.userId}:${USERS.u3.deviceId}`,
    ]);
    await env.ctrl.removeGroupMember(gid, USERS.u3.userId);
    expect(env.redis.srem).toHaveBeenCalledWith(
      `group:members:${gid}`,
      `${USERS.u3.userId}:${USERS.u3.deviceId}`,
    );
  });

  it('messages hors-ligne des users de test sont supprimes (ACK)', async () => {
    const ids = [fakeId(), fakeId(), fakeId()];
    for (const { userId, deviceId } of [USERS.u1, USERS.u2, USERS.u3]) {
      env.queueModel.deleteMany.mockResolvedValueOnce({ deletedCount: 1 });
      const res = await env.ctrl.acknowledgeMessages({
        userId,
        deviceId,
        messageIds: [ids.shift()],
      });
      expect(res.status).toBe('deleted');
    }
    expect(env.queueModel.deleteMany).toHaveBeenCalledTimes(3);
  });

  it('messages Welcome des users de test sont consommes et supprimes', async () => {
    for (const { deviceId } of [USERS.u1, USERS.u2, USERS.u3]) {
      env.welcomeModel.find.mockReturnThis();
      env.welcomeModel.exec.mockResolvedValueOnce([
        {
          deviceId,
          userId: 'user_test_x',
          senderUserId: 'user_test_y',
          groupId: 'g-test',
          message: 'w==',
        },
      ]);
      const result = await env.ctrl.getWelcomeMessages(deviceId);
      expect(result).toHaveLength(1);
      expect(env.welcomeModel.deleteMany).toHaveBeenCalledWith({ deviceId });
    }
  });

  it("aucune donnee residuelle si les groupes n'existent pas (idempotence)", async () => {
    env.groupModel.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    env.memberModel.deleteMany.mockResolvedValueOnce({ deletedCount: 0 });
    env.redis.del.mockResolvedValueOnce(0);
    const res = await env.ctrl.deleteGroup('group-inexistant-cleanup');
    expect(res).toEqual({ status: 'deleted' });
  });

  it('flux de cleanup complet sur les 3 users de test', async () => {
    const { groupId: gid2 } = await env.ctrl.createGroup({
      name: 'g-full-2',
      createdBy: USERS.u1.userId,
    });
    const { groupId: gid3 } = await env.ctrl.createGroup({
      name: 'g-full-3',
      createdBy: USERS.u1.userId,
    });
    await env.ctrl.deleteGroup(gid2);
    await env.ctrl.deleteGroup(gid3);
    for (const { userId, deviceId } of [USERS.u1, USERS.u2, USERS.u3]) {
      env.queueModel.deleteMany.mockResolvedValueOnce({ deletedCount: 0 });
      await env.ctrl.acknowledgeMessages({ userId, deviceId, messageIds: [] });
    }
    for (const { deviceId } of [USERS.u1, USERS.u2, USERS.u3]) {
      env.welcomeModel.find.mockReturnThis();
      env.welcomeModel.exec.mockResolvedValueOnce([]);
      const welcomes = await env.ctrl.getWelcomeMessages(deviceId);
      expect(welcomes).toHaveLength(0);
    }
    expect(env.groupModel.deleteOne).toHaveBeenCalledTimes(2);
    expect(env.memberModel.deleteMany).toHaveBeenCalledWith({ groupId: gid2 });
    expect(env.memberModel.deleteMany).toHaveBeenCalledWith({ groupId: gid3 });
  });
});
