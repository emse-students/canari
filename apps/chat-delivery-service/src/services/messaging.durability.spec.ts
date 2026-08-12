/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService, SendMessageBody } from './messaging.service';
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

/**
 * Guards the split between VISIBILITY (`silent`: raise no notification) and DURABILITY
 * (`durable`: keep a copy in the group's shared log). They were one boolean until 2026-08-12,
 * and because every control frame is silent by construction, no reaction, edit, deletion or read
 * receipt ever had a shared copy - a device that was absent could never obtain one.
 *
 * The split has a second half that is easy to lose: the stream now carries silent frames, so
 * anything that NOTIFIES from the stream must honour the per-entry flag, or a reactivated device
 * rings its user once per reaction. Both halves are asserted here.
 */
describe('MessagingService - visibility vs durability', () => {
  let service: MessagingService;

  const redis = {
    xadd: jest.fn().mockResolvedValue('1-0'),
    expire: jest.fn().mockResolvedValue(1),
    xrange: jest.fn().mockResolvedValue([]),
    sadd: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    publish: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
  };
  const deviceGroupRepo = { find: jest.fn().mockResolvedValue([]) };
  const queuedMessageRepo = {
    create: jest.fn((e: Record<string, unknown>) => e),
    save: jest.fn((e: Record<string, unknown>) => ({ id: 'q1', ...e })),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
  };

  /**
   * A repository that holds nothing - which is NOT the same as one that answers `undefined`.
   *
   * `find` on a real TypeORM repository returns `[]`, and a bare `jest.fn()` returns `undefined`,
   * so every caller reading `.length` off the result threw a TypeError instead of taking the
   * empty-set branch. Isolated, the throw landed inside a caller that swallows it; alongside
   * another spec it surfaced as a failure, which is why this read as cross-file pollution and was
   * not - the fixture was simply lying about what a repository does.
   */
  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  /** A proto send with no resolvable recipient: nothing is queued, so only the log write is exercised. */
  const send = (extra: Partial<SendMessageBody>): SendMessageBody => ({
    proto: 'cGF5bG9hZA==',
    groupId: 'g1',
    senderId: 'u1',
    senderDeviceId: 'd1',
    recipients: [],
    ...extra,
  });

  /** Reads a field from the flat `XADD key MAXLEN ~ n * f v f v ...` argument list. */
  const fieldOf = (name: string): string | undefined => {
    const args = redis.xadd.mock.calls[0] as string[];
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };

  /** `redeliverMissedDuringActivationWindow` is private; called directly so the assertion is not racy. */
  const redeliver = (userId: string, deviceId: string, groupId: string): Promise<void> =>
    (
      service as unknown as {
        redeliverMissedDuringActivationWindow: (
          u: string,
          d: string,
          g: string,
          since?: number
        ) => Promise<void>;
      }
    ).redeliverMissedDuringActivationWindow(userId, deviceId, groupId);

  /** One `history:<group>` entry, as ioredis returns it: `[id, [field, value, ...]]`. */
  const entry = (senderId: string, proto: string, silent?: '0' | '1'): [string, string[]] => [
    '1-0',
    [
      'sender_id',
      senderId,
      'content',
      proto,
      'timestamp',
      new Date().toISOString(),
      ...(silent === undefined ? [] : ['silent', silent]),
    ],
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: deviceGroupRepo },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  describe('who the shared log records as the author', () => {
    it('rejects a frame claiming to come from another user', async () => {
      // `senderId` is what a device replaying the log attributes the message - and every mutation
      // in it - to. It came from the body and was never compared to the authenticated caller, so a
      // member could write frames into a group's log under another member's name.
      await expect(service.sendMessage(send({ senderId: 'victim' }), 'attacker')).rejects.toThrow(
        'requesterUserId does not match the authenticated caller'
      );
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('accepts the caller sending as itself, whatever the case', async () => {
      await service.sendMessage(send({ senderId: 'Alice' }), 'alice');

      expect(redis.xadd).toHaveBeenCalledTimes(1);
    });

    it('skips the check for an internal caller, which never crosses nginx', async () => {
      // The gateway calls the service directly and has no `x-user-id`; same rule as every other
      // route in this service.
      await service.sendMessage(send({}), undefined);

      expect(redis.xadd).toHaveBeenCalledTimes(1);
    });
  });

  describe('what reaches the shared log', () => {
    it('keeps a silent mutation, so a device that was absent can still obtain it', async () => {
      // The whole defect in one assertion: a reaction is silent AND durable.
      await service.sendMessage(send({ silent: true, durable: true }));

      expect(redis.xadd).toHaveBeenCalledTimes(1);
      expect(fieldOf('content')).toBe('cGF5bG9hZA==');
    });

    it('marks that mutation as showing nothing, so no consumer may notify for it', async () => {
      await service.sendMessage(send({ silent: true, durable: true }));

      expect(fieldOf('silent')).toBe('1');
    });

    it('keeps a visible message and marks it showable', async () => {
      await service.sendMessage(send({ silent: false, durable: true }));

      expect(redis.xadd).toHaveBeenCalledTimes(1);
      expect(fieldOf('silent')).toBe('0');
    });

    it('drops a transport frame, which carries no conversation state', async () => {
      // History bundles, digests and call signalling are only meaningful while both peers are
      // live: storing them would fill the cap with frames nobody can ever use.
      await service.sendMessage(send({ silent: true, durable: false }));

      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('never keeps a Welcome or a Commit, which cannot be replayed out of order', async () => {
      await service.sendMessage(send({ durable: true, isWelcome: true }));
      await service.sendMessage(send({ durable: true, isCommit: true }));

      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('refreshes the log TTL on every write, so an abandoned group is evicted', async () => {
      await service.sendMessage(send({ silent: false, durable: true }));

      expect(redis.expire).toHaveBeenCalledWith('history:g1', expect.any(Number));
    });

    describe('a sender that predates the split', () => {
      it('reads an omitted durable as the old meaning of silent (visible -> kept)', async () => {
        await service.sendMessage(send({ silent: false }));

        expect(redis.xadd).toHaveBeenCalledTimes(1);
        expect(fieldOf('silent')).toBe('0');
      });

      it('reads an omitted durable as the old meaning of silent (silent -> dropped)', async () => {
        // Not a regression: it is exactly what such a client used to get, and it is the only
        // thing its intent can be read as.
        await service.sendMessage(send({ silent: true }));

        expect(redis.xadd).not.toHaveBeenCalled();
      });
    });
  });

  describe('who a transport frame is queued for', () => {
    /** Two peer devices, so one can be online and the other not. */
    const twoPeers = { recipients: [{ userId: 'u2', deviceId: 'dA' }, { userId: 'u2', deviceId: 'dB' }] };

    /** `dA` online, `dB` offline. */
    const onlyAOnline = () =>
      redis.exists.mockImplementation((k: string) =>
        Promise.resolve(k === 'user:online:u2:dA' ? 1 : 0)
      );

    /** Both private; spied on the instance so the assertion does not depend on FCM itself. */
    const pushSpies = () => ({
      deferred: jest
        .spyOn(service as unknown as { scheduleDeferredPush: () => void }, 'scheduleDeferredPush')
        .mockImplementation(() => {}),
      immediate: jest
        .spyOn(
          service as unknown as { sendFcmForQueued: () => Promise<void> },
          'sendFcmForQueued'
        )
        .mockResolvedValue(undefined),
    });

    it('queues a transport frame ONLY for the devices that are online', async () => {
      // The election that summons a responder only ever picks an online device, so an offline one
      // could not have answered even holding the frame - and the rendezvous it belongs to expires
      // in 60 s, long before that device drains its mailbox.
      onlyAOnline();
      pushSpies();

      await service.sendMessage(send({ silent: true, durable: false, ...twoPeers }));

      const queued = queuedMessageRepo.save.mock.calls[0][0] as unknown as { deviceId: string }[];
      expect(queued.map((q) => q.deviceId)).toEqual(['dA']);
    });

    it('sends NO push at all for a transport frame', async () => {
      onlyAOnline();
      const { deferred, immediate } = pushSpies();

      await service.sendMessage(send({ silent: true, durable: false, ...twoPeers }));

      expect(deferred).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
    });

    it('reports the number of rows it WROTE, not the number it considered', async () => {
      // A log that still counted the candidates would describe rows that do not exist.
      onlyAOnline();
      pushSpies();

      const res = await service.sendMessage(send({ silent: true, durable: false, ...twoPeers }));

      expect(res).toEqual(expect.objectContaining({ queued: 1 }));
    });

    it('still queues a DURABLE frame for an offline device, and pushes to it', async () => {
      // The whole point of the distinction: a real message must survive the recipient being away.
      onlyAOnline();
      const { immediate } = pushSpies();

      await service.sendMessage(send({ silent: false, durable: true, ...twoPeers }));

      const queued = queuedMessageRepo.save.mock.calls[0][0] as unknown as { deviceId: string }[];
      expect(queued.map((q) => q.deviceId)).toEqual(['dA', 'dB']);
      expect(immediate).toHaveBeenCalledTimes(1);
    });

    it('asks Redis whether a device is online ONCE, not once per pass', async () => {
      // The filter and the delivery loop used to ask the same question separately.
      onlyAOnline();
      pushSpies();

      await service.sendMessage(send({ silent: true, durable: false, ...twoPeers }));

      const onlineChecks = redis.exists.mock.calls.filter((c: string[]) =>
        String(c[0]).startsWith('user:online:')
      );
      expect(onlineChecks).toHaveLength(2);
    });
  });

  describe('redelivery to a device that just became active', () => {
    it('notifies for a visible message it missed', async () => {
      redis.xrange.mockResolvedValue([entry('u2', 'visible')]);

      await redeliver('u1', 'd1', 'g1');

      expect(queuedMessageRepo.save).toHaveBeenCalledTimes(1);
      expect(queuedMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ proto: 'visible' })
      );
    });

    it('stays silent for a mutation, instead of ringing once per reaction', async () => {
      // The regression the split would otherwise have introduced: before it, the stream held
      // visible messages only and this path could assume everything in it was showable.
      redis.xrange.mockResolvedValue([entry('u2', 'a-reaction', '1')]);

      await redeliver('u1', 'd1', 'g1');

      expect(queuedMessageRepo.save).not.toHaveBeenCalled();
    });

    it('notifies only for the visible frames of a mixed window', async () => {
      redis.xrange.mockResolvedValue([
        entry('u2', 'msg-a', '0'),
        entry('u2', 'reaction', '1'),
        entry('u2', 'msg-b', '0'),
        entry('u2', 'receipt', '1'),
      ]);

      await redeliver('u1', 'd1', 'g1');

      expect(queuedMessageRepo.save).toHaveBeenCalledTimes(2);
    });

    it('treats an entry written before the field existed as visible', async () => {
      // The stream held nothing but visible messages then, so an absent flag has one reading.
      redis.xrange.mockResolvedValue([entry('u2', 'older-message')]);

      await redeliver('u1', 'd1', 'g1');

      expect(queuedMessageRepo.save).toHaveBeenCalledTimes(1);
    });

    it('never redelivers the device its own messages', async () => {
      redis.xrange.mockResolvedValue([entry('u1', 'mine', '0')]);

      await redeliver('u1', 'd1', 'g1');

      expect(queuedMessageRepo.save).not.toHaveBeenCalled();
    });
  });
});
