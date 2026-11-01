/// <reference types="jest" />

/**
 * THE BANNER OF A QUEUED FRAME IS THE PUSH'S OR THE PAGE'S, NEVER BOTH (`push-claim.ts`).
 *
 * The page receives a frame over the socket and may announce it; the server pushes the same row
 * when it is not acknowledged in ten seconds, and the iOS extension announces it too. The ACK and
 * the push are made exclusive by one recorded claim, and the ACK's answer says who won - asserted
 * here in both orders and across retries of either side, through the real service.
 */
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { PUSH_CLAIM_TTL_S, pushClaimKey } from './push-claim';

const fcmSend = jest.fn();
const G1 = '0b9f3d7e-1111-4222-8333-444455556666';
jest.mock('firebase-admin/app', () => ({ getApps: jest.fn(() => [{}]) }));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: fcmSend })),
}));

/**
 * The two Redis commands the claim uses, with Redis's semantics: `SET k v EX s NX GET` writes only
 * when the key is absent and returns what it held; `MGET` reads. `expire()` drops a key, as its TTL
 * would.
 */
class FakeRedis {
  readonly store = new Map<string, { value: string; ttl: number }>();
  fail = false;
  async call(cmd: string, key: string, value: string, ex: string, ttl: string, ...rest: string[]) {
    if (this.fail) throw new Error('redis down');
    if (cmd !== 'SET' || ex !== 'EX' || rest.join(' ') !== 'NX GET')
      throw new Error(`unexpected ${cmd} ${ex} ${rest.join(' ')}`);
    const held = this.store.get(key);
    if (held) return held.value;
    this.store.set(key, { value, ttl: Number(ttl) });
    return null;
  }
  async mget(...keys: string[]) {
    if (this.fail) throw new Error('redis down');
    return keys.map((k) => this.store.get(k)?.value ?? null);
  }
  expire(key: string) {
    this.store.delete(key);
  }
}

describe('MessagingService - who owns the banner of a queued frame', () => {
  let service: MessagingService;
  let redis: FakeRedis;
  /** The queued rows, by id - what `find` and `delete` read. */
  let rows: Map<string, { id: string; recipientId: string; deviceId: string }>;

  const manager = {
    findOne: jest.fn(async () => null),
    query: jest.fn().mockResolvedValue([]),
  };
  const pushTokenRepo = { find: jest.fn(), delete: jest.fn(), manager };
  const groupRepo = {
    findOne: jest.fn().mockResolvedValue({ name: 'G', isGroup: false }),
    manager,
  };
  const matches = (where: { id: { value: string[] }; recipientId: string; deviceId: string }) =>
    [...rows.values()].filter(
      (r) =>
        where.id.value.includes(r.id) &&
        r.recipientId === where.recipientId &&
        r.deviceId === where.deviceId
    );
  const queuedRepo = {
    find: jest.fn(async ({ where }) => matches(where).map((r) => ({ id: r.id }))),
    delete: jest.fn(async (where) => {
      const gone = matches(where);
      for (const r of gone) rows.delete(r.id);
      return { affected: gone.length };
    }),
    findOne: jest.fn(),
    save: jest.fn(),
  };
  const unusedRepo = { find: jest.fn(), findOne: jest.fn(), delete: jest.fn(), save: jest.fn() };

  const queued = {
    id: 'q1',
    recipientId: 'u1',
    deviceId: 'iphone',
    proto: 'AAAA',
    isWelcome: false,
    createdAt: new Date('2026-11-01T10:00:00Z'),
  };
  const push = (silent = false) =>
    (
      service as unknown as { sendFcmForQueued: (...a: unknown[]) => Promise<void> }
    ).sendFcmForQueued(queued, 'trace', G1, 'u2', silent);
  const ack = () =>
    service.acknowledgeMessages(
      { userId: 'u1', deviceId: 'iphone', messageIds: ['q1'] },
      'u1',
      undefined
    );

  let errors: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    redis = new FakeRedis();
    rows = new Map([['q1', { id: 'q1', recipientId: 'u1', deviceId: 'iphone' }]]);
    pushTokenRepo.find.mockResolvedValue([
      { id: 1, userId: 'u1', deviceId: 'iphone', token: 'tok', platform: 'ios', locale: 'fr' },
    ]);
    fcmSend.mockResolvedValue('ok');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedRepo },
        { provide: getRepositoryToken(GroupMember), useValue: unusedRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: unusedRepo },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsCommitLog), useValue: unusedRepo },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: unusedRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: unusedRepo },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('PUSH FIRST: the push is sent, and the ACK that follows is told the push owns the banner', async () => {
    await push();
    expect(fcmSend).toHaveBeenCalledTimes(1);
    expect(await ack()).toEqual({ status: 'deleted', count: 1, pushed: ['q1'], unresolved: [] });
  });

  it('ACK FIRST: the page owns the banner, and the push that follows is not sent', async () => {
    expect(await ack()).toEqual({ status: 'deleted', count: 1, pushed: [], unresolved: [] });
    // `runDeferredPush` reads the row first; this is the push that read it before the ACK deleted it.
    await push();
    expect(fcmSend).not.toHaveBeenCalled();
  });

  it('an ACK RETRIED after the push is told what its first attempt was: pushed', async () => {
    await push();
    await ack();
    expect(rows.size).toBe(0);
    expect(await ack()).toEqual({ status: 'deleted', count: 0, pushed: ['q1'], unresolved: [] });
  });

  it('an ACK RETRIED after the ACK is told the page still owns it', async () => {
    await ack();
    expect(await ack()).toEqual({ status: 'deleted', count: 0, pushed: [], unresolved: [] });
  });

  it('a push RETRIED after the ACK is not sent either', async () => {
    await ack();
    await push();
    await push();
    expect(fcmSend).not.toHaveBeenCalled();
  });

  it('a push that claimed and then failed keeps its claim, and says so at an accusing level', async () => {
    fcmSend.mockRejectedValue(new Error('apns down'));
    await push();
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /claimed its banner and no token accepted the push/
    );
    expect(await ack()).toMatchObject({ pushed: ['q1'] });
  });

  it('a SILENT push owns no banner and claims nothing', async () => {
    await push(true);
    expect(fcmSend).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(0);
    expect(await ack()).toMatchObject({ pushed: [], unresolved: [] });
  });

  it('a retry finding no claim and no row is UNRESOLVED, never a guessed owner', async () => {
    await push();
    await ack();
    redis.expire(pushClaimKey('q1'));
    expect(await ack()).toMatchObject({ pushed: [], unresolved: ['q1'] });
    // And it does not mint one: a row no longer queued is never claimed afresh.
    expect(redis.store.size).toBe(0);
  });

  it('the claim outlives the queue retention: its TTL is garbage collection, not a verdict', async () => {
    await push();
    const ninetyDaysS = 90 * 24 * 60 * 60;
    expect(redis.store.get(pushClaimKey('q1'))?.ttl).toBe(PUSH_CLAIM_TTL_S);
    expect(PUSH_CLAIM_TTL_S).toBeGreaterThanOrEqual(2 * ninetyDaysS);
  });

  it('Redis refusing: the push goes out unclaimed and the ACK answers unresolved - both accused', async () => {
    redis.fail = true;
    await push();
    expect(fcmSend).toHaveBeenCalledTimes(1);
    expect(await ack()).toMatchObject({ count: 1, pushed: [], unresolved: ['q1'] });
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
