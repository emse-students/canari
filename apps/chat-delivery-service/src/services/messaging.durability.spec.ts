/// <reference types="jest" />

import { Logger } from '@nestjs/common';
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
import { RETENTION_WINDOW_MS } from '../retention.constants';

/**
 * Guards the split between VISIBILITY (`silent`: raise no notification) and DURABILITY
 * (`durable`: keep a copy in the group's shared log). They were one boolean until 2026-08-12,
 * and because every control frame is silent by construction, no reaction, edit, deletion or read
 * receipt ever had a shared copy - a device that was absent could never obtain one.
 *
 * The split had a second half while something NOTIFIED from the stream: a per-entry `silent` flag,
 * so a reactivated device did not ring once per reaction. That consumer (DF2) was deleted on
 * 2026-09-28 and the flag with it - nothing notifies from the stream any more.
 */
describe('MessagingService - visibility vs durability', () => {
  let service: MessagingService;

  /** What `exec()` answers. Per-command failures live in the RESULTS, so a test can seed one. */
  let execResult: Array<[Error | null, unknown]> | null;

  const redis = {
    xadd: jest.fn().mockResolvedValue('1-0'),
    xtrim: jest.fn().mockResolvedValue(0),
    expire: jest.fn().mockResolvedValue(1),
    xrange: jest.fn().mockResolvedValue([]),
    sadd: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    // The presence key's VALUE: `sessions-1` when a current gateway wrote it, `true` from an older one.
    get: jest.fn().mockResolvedValue(null),
    // The device's per-session declarations, `addressing:sessions:{u}:{d}` (one field per session).
    hvals: jest.fn().mockResolvedValue([]),
    publish: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    // Nobody routed yet, unless a test says otherwise: the reconciliation then re-reads and writes.
    smismember: jest.fn(async (_key: string, ...members: string[]) => members.map(() => 0)),
    pipeline: jest.fn(() => pipelineDouble()),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn().mockResolvedValue(1),
    /**
     * `ADDRESSABLE_PUBLISH_LUA`, replayed over the doubles above: its real atomicity is proven against
     * a real Redis in `addressing.redis.spec.ts`; here it only has to answer what the keys say.
     */
    eval: jest.fn(
      async (
        _script: string,
        _keys: number,
        presenceKey: string,
        hashKey: string,
        channel: string,
        payload: string,
        capability: string,
        marker: string
      ) => {
        const presence = await redis.get(presenceKey);
        const declared = (await redis.hvals(hashKey)) as string[];
        if (presence !== marker || declared.length === 0) return 0;
        if (declared.some((d) => d !== capability)) return 0;
        if (channel) await redis.publish(channel, payload);
        return 1;
      }
    ),
  };

  /**
   * The stream write is ONE pipeline, so its commands arrive through `pipeline()` rather than on the
   * client itself.
   *
   * The double records each one on the SAME mock the client exposes, so every assertion about
   * `xadd` or `expire` reads exactly as it did when they were separate awaits - what changed is the
   * number of round trips, which is not what those tests are about.
   */
  const pipelineDouble = () => {
    const chain = {
      xadd: (...args: unknown[]) => (void redis.xadd(...args), chain),
      xtrim: (...args: unknown[]) => (void redis.xtrim(...args), chain),
      expire: (...args: unknown[]) => (void redis.expire(...args), chain),
      exec: () => Promise.resolve(execResult),
    };
    return chain;
  };
  // `find` resolves the RECIPIENTS; `findOne` is the sender's own row, which the send path now reads
  // before addressing anybody - a device whose membership is not `active` holds no leaf in the
  // ratchet tree, so nothing it encrypts can be opened by any member (see the gate below).
  const deviceGroupRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ status: 'active' }),
  };
  const queuedMessageRepo = {
    create: jest.fn((e: Record<string, unknown>) => e),
    // TypeORM's contract, and the fake owes it: an array in is an array out. The activation
    // redelivery saves a whole page at once and iterates what comes back, so a fake that answered
    // one object for a list of them failed on the RETURN rather than on anything it was testing.
    save: jest.fn((e: Record<string, unknown> | Record<string, unknown>[]) =>
      Array.isArray(e) ? e.map((row, i) => ({ id: `q${i + 1}`, ...row })) : { id: 'q1', ...e }
    ),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    /**
     * The send writes its rows inside a transaction that first reads the group under a shared lock,
     * so that a deletion cannot land between the recipient resolution and the enqueue
     * (`messaging.send-race.spec.ts` is where that ordering is asserted).
     *
     * Here the group is simply ALIVE - every test in this file is about what a send DURABLY writes,
     * and none of them deletes anything. The queue repository handed to the callback is the same
     * fake, so every existing assertion on `queuedMessageRepo.save` reads exactly what it did
     * before the transaction existed.
     */
    manager: {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
        cb({
          // The shared seat lock the write takes first (`messaging.send-race.spec.ts` asserts it).
          query: async () => [],
          // The seats re-read under it are the roster fake's, so nobody is evicted in between.
          getRepository: (entity: { name?: string }) =>
            entity?.name === 'Group'
              ? { find: async () => [{ id: 'g1', deletedAt: null }] }
              : entity?.name === 'DeviceGroupMembership'
                ? deviceGroupRepo
                : queuedMessageRepo,
        })
      ),
    },
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

  /**
   * Groups. An addressed frame is accepted on a key-distribution group only, so the default row is
   * one; a test about a conversation group says so.
   */
  const groupRepo = {
    ...emptyRepo(),
    // The seat lock's transaction, which re-reads the roster before a route is written.
    manager: {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
        cb({ query: async () => [], getRepository: () => deviceGroupRepo })
      ),
    },
  };

  /**
   * Static KeyPackages - the server-side proof that a device is addressable at all (WP-GHOST-1).
   *
   * Held at this scope rather than built inside `beforeEach` so a test can say who exists.
   */
  const keyPackageRepo = emptyRepo();

  /** A proto send with no resolvable recipient: nothing is queued, so only the log write is exercised. */
  const send = (extra: Partial<SendMessageBody>): SendMessageBody => ({
    proto: 'cGF5bG9hZA==',
    groupId: 'g1',
    senderId: 'u1',
    senderDeviceId: 'd1',
    ...extra,
  });

  /** Reads a field from the flat `XADD key MAXLEN ~ n * f v f v ...` argument list. */
  const fieldOf = (name: string): string | undefined => {
    const args = redis.xadd.mock.calls[0] as string[];
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // `clearAllMocks` keeps implementations, so a set restored by one test would leak into the
    // next; both are stated here so every test starts from "this group has no members".
    deviceGroupRepo.find.mockResolvedValue([]);
    deviceGroupRepo.findOne.mockResolvedValue({ status: 'active' });
    keyPackageRepo.find.mockResolvedValue([]);
    groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: 'w1' });
    redis.exists.mockResolvedValue(0);
    redis.get.mockResolvedValue(null);
    redis.hvals.mockResolvedValue([]);
    execResult = [
      [null, '1-0'],
      [null, 0],
      [null, 1],
    ];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        {
          provide: getRepositoryToken(QueuedMessage),
          useValue: queuedMessageRepo,
        },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
        {
          provide: getRepositoryToken(OneTimeKeyPackage),
          useValue: emptyRepo(),
        },
        {
          provide: getRepositoryToken(DeviceGroupMembership),
          useValue: deviceGroupRepo,
        },
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

    it('records the sending DEVICE, which is the only thing a replay can filter its own rows by', async () => {
      // The stream is shared by the whole group, so it necessarily holds this device's own frames -
      // and MLS refuses them by construction. `sender_id` cannot discriminate: the same user's
      // OTHER device wrote frames that are both decryptable and wanted. Written here because here
      // is the last point where the device is known. Never learn by failing what a fact could tell.
      await service.sendMessage(send({ senderDeviceId: 'd-sender', durable: true }));

      expect(fieldOf('sender_device_id')).toBe('d-sender');
    });

    it('keeps a visible message', async () => {
      await service.sendMessage(send({ silent: false, durable: true }));

      expect(redis.xadd).toHaveBeenCalledTimes(1);
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

    /**
     * The stream is the only shared copy of a conversation, and four compatibility shims are retired
     * on the sentence "no row older than the retention window can still exist"
     * (`docs/wiki/legacy-compatibility.md`). Nothing made that true: `MAXLEN` bounds the stream by
     * COUNT, and the TTL above is refreshed on every write, so a group under the cap kept every row
     * it ever held. Measured on production 2026-08-17, four of five streams still carried rows from
     * before 2026-08-15.
     */
    describe('how far back the shared log may reach', () => {
      it('drops what is older than the retention window, by AGE and not by count', async () => {
        const before = Date.now();
        await service.sendMessage(send({ silent: false, durable: true }));
        const after = Date.now();

        expect(redis.xtrim).toHaveBeenCalledTimes(1);
        const [key, strategy, cutoff] = redis.xtrim.mock.calls[0] as string[];
        expect(key).toBe('history:g1');
        expect(strategy).toBe('MINID');
        expect(Number(cutoff)).toBeGreaterThanOrEqual(before - RETENTION_WINDOW_MS);
        expect(Number(cutoff)).toBeLessThanOrEqual(after - RETENTION_WINDOW_MS);
      });

      it('trims EXACTLY, because a date nothing may be older than cannot be approximate', async () => {
        // `~` stops at node boundaries and keeps up to a node's worth of older entries - which is
        // precisely why the stream measured 8001 against a cap of 8000. Tolerable for a memory cap,
        // not for the bound a removal date rests on.
        await service.sendMessage(send({ silent: false, durable: true }));

        expect(redis.xtrim.mock.calls[0]).not.toContain('~');
      });

      it('costs ONE round trip for the three commands', async () => {
        await service.sendMessage(send({ silent: false, durable: true }));

        expect(redis.pipeline).toHaveBeenCalledTimes(1);
        expect(redis.xadd).toHaveBeenCalledTimes(1);
        expect(redis.xtrim).toHaveBeenCalledTimes(1);
        expect(redis.expire).toHaveBeenCalledTimes(1);
      });

      it('accuses when one command of the pipeline failed', async () => {
        // A pipeline reports per-command failures in its RESULTS rather than by throwing, so the
        // surrounding `catch` never sees them. Unread, a stream that stopped being trimmed would
        // look exactly like one that was - and the date would go on being believed.
        execResult = [
          [null, '1-0'],
          [new Error('MINID refused'), null],
          [null, 1],
        ];
        const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

        await service.sendMessage(send({ silent: false, durable: true }));

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('XTRIM failed'));
      });

      it('accuses when the pipeline itself answered nothing', async () => {
        execResult = null;
        const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

        await service.sendMessage(send({ silent: false, durable: true }));

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('pipeline aborted'));
      });
    });

    describe('a sender that predates the split', () => {
      it('reads an omitted durable as the old meaning of silent (visible -> kept)', async () => {
        await service.sendMessage(send({ silent: false }));

        expect(redis.xadd).toHaveBeenCalledTimes(1);
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
    /**
     * Two peer devices, so one can be online and the other not.
     *
     * Declared the way production declares them - an active membership row and a static
     * KeyPackage each - and NOT through `body.recipients`, which is what these five tests used to
     * fill. The proto path read that field first and kept the DB resolve behind an
     * `ops.length === 0` guard labelled a Redis cache miss; since no client has ever sent the
     * field, the fixture was exercising the branch production never takes while the branch it
     * always takes went unasserted.
     */
    const twoPeers = () => {
      const devices = [
        { userId: 'u2', deviceId: 'dA' },
        { userId: 'u2', deviceId: 'dB' },
      ];
      deviceGroupRepo.find.mockResolvedValue(devices);
      keyPackageRepo.find.mockResolvedValue(devices);
    };

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
        .spyOn(service as unknown as { sendFcmForQueued: () => Promise<void> }, 'sendFcmForQueued')
        .mockResolvedValue(undefined),
    });

    it('queues a transport frame ONLY for the devices that are online', async () => {
      // The election that summons a responder only ever picks an online device, so an offline one
      // could not have answered even holding the frame - and the rendezvous it belongs to expires
      // in 60 s, long before that device drains its mailbox.
      twoPeers();
      onlyAOnline();
      pushSpies();

      await service.sendMessage(send({ silent: true, durable: false }));

      const queued = queuedMessageRepo.save.mock.calls[0][0] as unknown as {
        deviceId: string;
      }[];
      expect(queued.map((q) => q.deviceId)).toEqual(['dA']);
    });

    it('sends NO push at all for a transport frame', async () => {
      twoPeers();
      onlyAOnline();
      const { deferred, immediate } = pushSpies();

      await service.sendMessage(send({ silent: true, durable: false }));

      expect(deferred).not.toHaveBeenCalled();
      expect(immediate).not.toHaveBeenCalled();
    });

    it('reports the number of rows it WROTE, not the number it considered', async () => {
      // A log that still counted the candidates would describe rows that do not exist.
      twoPeers();
      onlyAOnline();
      pushSpies();

      const res = await service.sendMessage(send({ silent: true, durable: false }));

      expect(res).toEqual(expect.objectContaining({ queued: 1 }));
    });

    /**
     * A REMOVAL IS RECORDED BEFORE ITS COMMIT and deletes the removed person's device rows, which
     * are what a commit is fanned out from - so the commit that removes them never reached them, and
     * they kept the epoch's keys until a refused send told them (second review of #1878, P1-a).
     */
    describe('a commit reaches whoever it removes', () => {
      const queuedKeys = () =>
        (
          queuedMessageRepo.save.mock.calls[0][0] as unknown as {
            recipientId: string;
            deviceId: string;
          }[]
        ).map((q) => `${q.recipientId}:${q.deviceId}`);

      it('queues the commit to the removed devices it was handed, and consumes the entries', async () => {
        twoPeers();
        onlyAOnline();
        pushSpies();

        await service.sendMessage(send({ isCommit: true }), undefined, [
          { userId: 'u9', deviceId: 'dX' },
        ]);

        expect(queuedKeys()).toEqual(['u2:dA', 'u2:dB', 'u9:dX']);
        expect(redis.hdel).toHaveBeenCalledWith('group:parting:g1', 'u9:dX');
      });

      it('a parted device that is a member again is queued ONCE, as a member, and its entry is not consumed', async () => {
        twoPeers();
        onlyAOnline();
        pushSpies();

        await service.sendMessage(send({ isCommit: true }), undefined, [
          { userId: 'u2', deviceId: 'dA' },
          { userId: 'u9', deviceId: 'dX' },
        ]);

        expect(queuedKeys()).toEqual(['u2:dA', 'u2:dB', 'u9:dX']);
        expect(redis.hdel).toHaveBeenCalledWith('group:parting:g1', 'u9:dX');
      });

      it('an application frame never reaches them', async () => {
        twoPeers();
        onlyAOnline();
        pushSpies();

        await service.sendMessage(send({ silent: false, durable: true }), undefined, [
          { userId: 'u9', deviceId: 'dX' },
        ]);

        expect(queuedKeys()).toEqual(['u2:dA', 'u2:dB']);
        expect(redis.hdel).not.toHaveBeenCalled();
      });

      /**
       * KEYED TO WHAT THE COMMIT DECLARES, never to "the remover's next commit" (third review of
       * #1878): two removals in flight by one member each reach their own person, and a commit
       * declaring nothing - an ordinary one, or one from an older build - consumes nobody's entry.
       */
      describe('which parted devices a commit names', () => {
        const declared = (removes: unknown) =>
          (
            service as unknown as {
              declaredPartingDevices: (
                g: string,
                r: unknown,
                t: string
              ) => Promise<Array<{ userId: string; deviceId: string }>>;
            }
          ).declaredPartingDevices('g1', removes, 'trace');

        beforeEach(() => {
          redis.hgetall.mockResolvedValue({ 'u9:dX': 'u1', 'u9:dZ': 'u1', 'u8:dY': 'u1' });
        });

        it("every device of a person named alone, and nobody else's", async () => {
          await expect(declared([{ userId: 'u9' }])).resolves.toEqual([
            { userId: 'u9', deviceId: 'dX' },
            { userId: 'u9', deviceId: 'dZ' },
          ]);
        });

        it('the one device of a person named with it', async () => {
          await expect(declared([{ userId: 'u9', deviceId: 'dZ' }])).resolves.toEqual([
            { userId: 'u9', deviceId: 'dZ' },
          ]);
        });

        it('nothing for a commit that declares nothing, without reading the hint', async () => {
          redis.hgetall.mockClear();
          await expect(declared(undefined)).resolves.toEqual([]);
          expect(redis.hgetall).not.toHaveBeenCalled();
        });
      });
    });

    it("answers the sender the SAME receive time its recipients' rows carry", async () => {
      // The sender dates its own copy by it, and a history answer places that copy against a
      // membership window - so it must be the instant a recipient's copy is dated by, not a near one.
      twoPeers();
      onlyAOnline();
      pushSpies();

      const res = await service.sendMessage(send({ silent: true, durable: false }));

      const queued = queuedMessageRepo.save.mock.calls[0][0] as unknown as { createdAt: Date }[];
      expect(res).toEqual(expect.objectContaining({ receivedAt: queued[0].createdAt.getTime() }));
    });

    it('still queues a DURABLE frame for an offline device, and pushes to it', async () => {
      // The whole point of the distinction: a real message must survive the recipient being away.
      twoPeers();
      onlyAOnline();
      const { immediate } = pushSpies();

      await service.sendMessage(send({ silent: false, durable: true }));

      const queued = queuedMessageRepo.save.mock.calls[0][0] as unknown as {
        deviceId: string;
      }[];
      expect(queued.map((q) => q.deviceId)).toEqual(['dA', 'dB']);
      expect(immediate).toHaveBeenCalledTimes(1);
    });

    it('asks Redis whether a device is online ONCE, not once per pass', async () => {
      // The filter and the delivery loop used to ask the same question separately.
      twoPeers();
      onlyAOnline();
      pushSpies();

      await service.sendMessage(send({ silent: true, durable: false }));

      const onlineChecks = redis.exists.mock.calls.filter((c: string[]) =>
        String(c[0]).startsWith('user:online:')
      );
      expect(onlineChecks).toHaveLength(2);
    });
  });

  /**
   * A Graine answer to ONE device's seed request (channel-encryption section 23). It used to be
   * queued for every seat of the key group: measured on production 2026-10-12, a seed bundle was
   * ~42 rows per payload on a 112-seat group, and bundles were 70 % of that group's queued bytes.
   */
  describe('a frame addressed to one device', () => {
    const groupOfThree = () => {
      const devices = [
        { userId: 'u1', deviceId: 'd1' },
        { userId: 'u2', deviceId: 'dA' },
        { userId: 'u2', deviceId: 'dB' },
        { userId: 'u3', deviceId: 'dC' },
      ];
      deviceGroupRepo.find.mockResolvedValue(devices);
      keyPackageRepo.find.mockResolvedValue(devices);
      jest
        .spyOn(service as unknown as { scheduleDeferredPush: () => void }, 'scheduleDeferredPush')
        .mockImplementation(() => {});
      jest
        .spyOn(service as unknown as { sendFcmForQueued: () => Promise<void> }, 'sendFcmForQueued')
        .mockResolvedValue(undefined);
    };
    const queuedDevices = () =>
      (queuedMessageRepo.save.mock.calls[0][0] as unknown as { deviceId: string }[]).map(
        (q) => q.deviceId
      );

    it('is queued for the addressed device ONLY, offline included', async () => {
      groupOfThree();

      await service.sendMessage(send({ silent: true, durable: true, recipientDevices: ['u2:dB'] }));

      expect(queuedDevices()).toEqual(['dB']);
    });

    it('matches the user id whatever its case, as the client lower-cases it', async () => {
      groupOfThree();

      await service.sendMessage(send({ silent: true, durable: true, recipientDevices: ['U2:dB'] }));

      expect(queuedDevices()).toEqual(['dB']);
    });

    it('never reaches a device outside the group, whatever the key names', async () => {
      groupOfThree();

      await service.sendMessage(
        send({ silent: true, durable: true, recipientDevices: ['u9:d9', 'u1:d1'] })
      );

      // `u9:d9` is no member and `u1:d1` is the sender itself: nobody is left to address.
      expect(queuedMessageRepo.save).not.toHaveBeenCalled();
    });

    it('is kept OUT of the shared history stream, which every member reads', async () => {
      groupOfThree();

      await service.sendMessage(send({ silent: true, durable: true, recipientDevices: ['u2:dB'] }));

      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('refuses an addressed commit or Welcome, which every member must receive', async () => {
      groupOfThree();

      await expect(
        service.sendMessage(send({ isCommit: true, recipientDevices: ['u2:dB'] }))
      ).rejects.toThrow('refused on a commit or a Welcome');
      await expect(
        service.sendMessage(send({ isWelcome: true, recipientDevices: ['u2:dB'] }))
      ).rejects.toThrow('refused on a commit or a Welcome');
    });

    /**
     * STEP A (docs/wiki/protocols/history-answer-addressing.md): a history answer on a CONVERSATION
     * is addressed to the device that asked. Held to rules 3 and 6 - transport only, and only to a
     * device whose every live session declared that it refuses an addressed frame that is not a
     * solicited history answer.
     */
    describe('on a conversation group', () => {
      const conversation = () => {
        groupOfThree();
        groupRepo.findOne.mockResolvedValue({ id: 'g1', distributionWorkspaceId: null });
        // Every device is online - a transport frame reaches nobody else.
        redis.exists.mockResolvedValue(1);
      };
      /**
       * The gateway's two writes for a device: the presence VALUE (`sessions-1` from a current
       * gateway, `true` from an older one) and one field per live session on a current gateway.
       */
      const sessions = (device: string, presence: string, fields: string[]) => {
        const get = redis.get.getMockImplementation();
        const hvals = redis.hvals.getMockImplementation();
        redis.get.mockImplementation(async (key: string) =>
          key === `user:online:${device}` ? presence : ((await get?.(key)) ?? null)
        );
        redis.hvals.mockImplementation(async (key: string) =>
          key === `addressing:sessions:${device}` ? fields : ((await hvals?.(key)) ?? [])
        );
      };
      const declares = (...devices: string[]) => {
        for (const d of devices) sessions(d, 'sessions-1', ['addressed-history-1']);
      };

      it('queues the answer for the asking device ONLY - another device of the group gets no row', async () => {
        conversation();
        declares('u2:dB');

        await service.sendMessage(
          send({ silent: true, durable: false, recipientDevices: ['u2:dB'] })
        );

        expect(queuedDevices()).toEqual(['dB']);
        // The newcomer's device and the asker's own sibling device: no row, no realtime frame.
        const published = redis.publish.mock.calls.map((c) => JSON.parse(String(c[1])));
        expect(published.map((f) => f.deviceId)).toEqual(['dB']);
        expect(redis.xadd).not.toHaveBeenCalled();
      });

      it('marks the row and the live frame `addressed`, the routing fact the receiver needs', async () => {
        conversation();
        declares('u2:dB');

        await service.sendMessage(
          send({ silent: true, durable: false, recipientDevices: ['u2:dB'] })
        );

        const rows = queuedMessageRepo.save.mock.calls[0][0] as unknown as { addressed: boolean }[];
        expect(rows.map((r) => r.addressed)).toEqual([true]);
        expect(JSON.parse(String(redis.publish.mock.calls[0][1])).addressed).toBe(true);
      });

      it('a frame that is not addressed is never marked', async () => {
        conversation();

        await service.sendMessage(send({ silent: true, durable: false }));

        const rows = queuedMessageRepo.save.mock.calls[0][0] as unknown as { addressed: boolean }[];
        expect(rows.every((r) => r.addressed === false)).toBe(true);
        expect(
          redis.publish.mock.calls.every((c) => !('addressed' in JSON.parse(String(c[1]))))
        ).toBe(true);
      });

      it('refuses a DURABLE addressed frame - an answer may not enter the queue of an offline device', async () => {
        conversation();
        declares('u2:dB');

        await expect(
          service.sendMessage(send({ silent: true, durable: true, recipientDevices: ['u2:dB'] }))
        ).rejects.toMatchObject({ response: { error: 'addressed_durable' } });
        expect(queuedMessageRepo.save).not.toHaveBeenCalled();
      });

      it('refuses a device whose live sessions did not ALL declare the capability, and names it', async () => {
        conversation();
        declares('u2:dA');

        await expect(
          service.sendMessage(send({ silent: true, durable: false, recipientDevices: ['u2:dB'] }))
        ).rejects.toMatchObject({
          response: { error: 'addressed_unsupported', devices: ['u2:dB'] },
        });
        expect(queuedMessageRepo.save).not.toHaveBeenCalled();
        expect(redis.publish).not.toHaveBeenCalled();
      });

      /**
       * Review of #2270: the check and the publish were two round trips, so a session registering
       * between them received the frame. The publish now re-checks in the SAME script; the row stays
       * queued for the declared session to pull.
       */
      it('re-checks AT the publish - a session that registered after the check gets no frame', async () => {
        conversation();
        declares('u2:dB');
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

        await service.sendMessage(
          send({ silent: true, durable: false, recipientDevices: ['u2:dB'] })
        );

        expect(queuedDevices()).toEqual(['dB']);
        expect(redis.publish).not.toHaveBeenCalled();
        expect(
          error.mock.calls.some(([l]) => String(l).includes('ADDRESSED row NOT published'))
        ).toBe(true);
        error.mockRestore();
      });

      /**
       * THE CAPABILITY IS A CROSS-PROCESS FACT. Two sessions of one device may sit on two gateway
       * processes (a deploy overlap): each records its own declaration in the shared hash, and ONE
       * undeclared session anywhere makes the device unaddressable.
       */
      it('refuses a device ONE of whose sessions, on any gateway, did not declare it', async () => {
        conversation();
        sessions('u2:dB', 'sessions-1', ['addressed-history-1', '-']);

        await expect(
          service.sendMessage(send({ silent: true, durable: false, recipientDevices: ['u2:dB'] }))
        ).rejects.toMatchObject({
          response: { error: 'addressed_unsupported', devices: ['u2:dB'] },
        });
        expect(redis.publish).not.toHaveBeenCalled();
      });

      it('refuses a device an OLDER gateway also serves - its presence value is `true`', async () => {
        conversation();
        // The current gateway's session declared; an older gateway's session writes no field at
        // all, and the presence value it writes is the only trace of it.
        sessions('u2:dB', 'true', ['addressed-history-1']);

        await expect(
          service.sendMessage(send({ silent: true, durable: false, recipientDevices: ['u2:dB'] }))
        ).rejects.toMatchObject({
          response: { error: 'addressed_unsupported', devices: ['u2:dB'] },
        });
      });

      it('refuses a device with no recorded session, even under a current presence value', async () => {
        conversation();
        sessions('u2:dB', 'sessions-1', []);

        await expect(
          service.sendMessage(send({ silent: true, durable: false, recipientDevices: ['u2:dB'] }))
        ).rejects.toMatchObject({
          response: { error: 'addressed_unsupported', devices: ['u2:dB'] },
        });
      });

      it('marks a KEY-GROUP answer nothing - the flag is the conversation rule, and the edge filters on it', async () => {
        groupOfThree();
        redis.exists.mockResolvedValue(1);

        await service.sendMessage(
          send({ silent: true, durable: false, recipientDevices: ['u2:dB'] })
        );

        const rows = queuedMessageRepo.save.mock.calls[0][0] as unknown as { addressed: boolean }[];
        expect(rows.map((r) => r.addressed)).toEqual([false]);
        expect('addressed' in JSON.parse(String(redis.publish.mock.calls[0][1]))).toBe(false);
      });
    });

    it('refuses an empty or malformed list rather than reading it as "the whole group"', async () => {
      groupOfThree();

      for (const recipientDevices of [[], ['no-colon'], [':dB'], ['u2:'], [42]]) {
        await expect(
          service.sendMessage(
            send({ durable: true, recipientDevices: recipientDevices as unknown as string[] })
          )
        ).rejects.toThrow('recipientDevices');
      }
      expect(queuedMessageRepo.save).not.toHaveBeenCalled();
    });

    it('still reaches the whole group when the field is absent, as every older client sends', async () => {
      groupOfThree();

      await service.sendMessage(send({ silent: true, durable: true }));

      expect(queuedDevices()).toEqual(['dA', 'dB', 'dC']);
      expect(redis.xadd).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * WP-SENDPATH-1a. The proto path used to read `body.recipients` first and keep the membership
   * resolve behind an `ops.length === 0` guard commented "Fallback: recipients not provided (Redis
   * cache miss)". Nothing has ever filled that field - not the client, not the gateway, not either
   * PushSecret route, not the commit fan-out - so the guard was true on every send, a fallback was
   * the whole design, and it announced a cache miss on 100 % of production traffic for a cache it
   * never consulted.
   */
  describe('where the recipient set comes from', () => {
    const threeDevices = () => {
      // The sender's own device is a member like any other; it is excluded from DELIVERY, not
      // from the group.
      const devices = [
        { userId: 'u1', deviceId: 'd1' },
        { userId: 'u2', deviceId: 'dA' },
        { userId: 'u2', deviceId: 'dB' },
      ];
      deviceGroupRepo.find.mockResolvedValue(devices);
      keyPackageRepo.find.mockResolvedValue(devices);
    };

    const silencePush = () => {
      jest
        .spyOn(service as unknown as { scheduleDeferredPush: () => void }, 'scheduleDeferredPush')
        .mockImplementation(() => {});
      jest
        .spyOn(service as unknown as { sendFcmForQueued: () => Promise<void> }, 'sendFcmForQueued')
        .mockResolvedValue(undefined);
    };

    it('resolves from the membership table and ignores what the caller claims', async () => {
      threeDevices();
      silencePush();

      await service.sendMessage(
        send({ recipients: [{ userId: 'u9', deviceId: 'd9' }], durable: true })
      );

      const queued = queuedMessageRepo.save.mock.calls[0][0] as unknown as {
        deviceId: string;
      }[];
      expect(queued.map((q) => q.deviceId)).toEqual(['dA', 'dB']);
    });

    describe('a pending device its commit admitted (user, 2026-09-28)', () => {
      /** An MLS 1.0 PrivateMessage header sealed at `epoch`: `version || wire_format || group_id<V> || epoch`. */
      const sealedAt = (epoch: number): string => {
        const id = Buffer.from('g1', 'ascii');
        const e = Buffer.alloc(8);
        e.writeBigUInt64BE(BigInt(epoch));
        return Buffer.concat([
          Buffer.from([0x00, 0x01, 0x00, 0x02, id.length]),
          id,
          e,
          Buffer.from([0xca, 0xfe]),
        ]).toString('base64');
      };

      /** Two active devices, plus one pending device admitted at epoch 7 and one never admitted. */
      const withAdmitted = () => {
        const active = [
          { userId: 'u1', deviceId: 'd1' },
          { userId: 'u2', deviceId: 'dA' },
        ];
        const pending = [
          { userId: 'u3', deviceId: 'dNew', admittedAtEpoch: 7 },
          { userId: 'u4', deviceId: 'dOld', admittedAtEpoch: null },
        ];
        // The fake evaluates the one operator the send path uses, so the RULE is what is tested.
        deviceGroupRepo.find.mockImplementation(
          async ({ where }: { where: { status?: string; admittedAtEpoch?: { value: number } } }) =>
            // No status is the write's re-read of who holds a seat at all.
            where.status === undefined
              ? [...active, ...pending]
              : where.status === 'active'
                ? active
                : pending.filter(
                    (p) =>
                      p.admittedAtEpoch !== null &&
                      p.admittedAtEpoch <= (where.admittedAtEpoch?.value ?? -1)
                  )
        );
        keyPackageRepo.find.mockResolvedValue([...active, ...pending]);
      };

      const queuedDevices = (): string[] =>
        (queuedMessageRepo.save.mock.calls[0][0] as unknown as { deviceId: string }[]).map(
          (q) => q.deviceId
        );

      afterEach(() => deviceGroupRepo.find.mockReset().mockResolvedValue([]));

      it('queues it every frame sealed at the epoch it was admitted at', async () => {
        withAdmitted();
        silencePush();

        await service.sendMessage(send({ proto: sealedAt(7), durable: true }));

        expect(queuedDevices()).toEqual(['dA', 'dNew']);
      });

      it('skips it for a frame sealed before that epoch, which it can never open', async () => {
        withAdmitted();
        silencePush();

        await service.sendMessage(send({ proto: sealedAt(6), durable: true }));

        expect(queuedDevices()).toEqual(['dA']);
      });

      it('never announces it on the routing set - only its activation does', async () => {
        withAdmitted();
        silencePush();

        await service.sendMessage(send({ proto: sealedAt(7), durable: true }));

        expect(redis.sadd).toHaveBeenCalledWith('group:members:g1', 'u1:d1', 'u2:dA');
      });
    });

    it('reconciles the gateway routing set with every live member, the sender included', async () => {
      // Reconciling with the DELIVERY set instead left the sender out for ever, and a member
      // missing from this set is one `forward_to_one_peer` can never elect to answer a
      // `welcome_request` or a `history_request`.
      threeDevices();
      silencePush();

      await service.sendMessage(send({ durable: true }));

      expect(redis.sadd).toHaveBeenCalledWith('group:members:g1', 'u1:d1', 'u2:dA', 'u2:dB');
    });

    it('says nothing when the routing set was already complete', async () => {
      // Measured on prod 2026-08-15: every group that has a set has a COMPLETE one, so this is
      // what the reconciliation does on essentially every send. A line here would be noise, and
      // noise is what let the old one go unread on 100 % of traffic.
      threeDevices();
      silencePush();
      redis.smismember.mockImplementationOnce(async (_key: string, ...members: string[]) =>
        members.map(() => 1)
      );
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

      await service.sendMessage(send({ durable: true }));

      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('MEMBERS_CACHE_REPAIRED'));
      // Nor does it write, or take the seat lock a write needs, on the ordinary send.
      expect(redis.sadd).not.toHaveBeenCalled();
      expect(groupRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it('accuses when it actually had to repair the routing set', async () => {
      // An active device absent from the set is one the gateway silently fails to reach:
      // `broadcast_to_group_members` proceeds with an empty member list and sends to nobody.
      // Reaching this line means an owner did not write, and the fix belongs there.
      threeDevices();
      silencePush();
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

      await service.sendMessage(send({ durable: true }));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MEMBERS_CACHE_REPAIRED'));
    });
  });

  /**
   * A device whose membership row is not `active` holds NO LEAF in the ratchet tree. Whatever it
   * encrypts is undecryptable by construction for every member, so accepting such a frame does not
   * deliver a message - it manufactures one that will fail to open, on every recipient, for ever.
   *
   * Measured on prod 2026-09-02 (group `7da231f8`): six messages were accepted from a `pending` web
   * device, fanned out, ACKed off the queue, and displayed nowhere. The sender saw them sent.
   * Refusing at the seam is what turns that into an answer the client can act on, and the
   * discriminator was already in the row the server reads to address the recipients.
   */
  describe('a sender holding no leaf may not publish ciphertext', () => {
    it('refuses a proto frame from a pending device, queueing and logging nothing', async () => {
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'pending' });

      await expect(service.sendMessage(send({ durable: true }))).rejects.toMatchObject({
        response: { error: 'sender_not_active', status: 'pending' },
      });

      expect(queuedMessageRepo.save).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it('still accepts the HANDSHAKE frames, which are how a pending device stops being pending', async () => {
      // A Welcome and a Commit are addressed to the group in the clear-ish: they carry no
      // application payload and are precisely the path out of `pending`. Refusing them would make
      // the gate a deadlock.
      deviceGroupRepo.findOne.mockResolvedValue({ status: 'pending' });

      await expect(service.sendMessage(send({ isWelcome: true }))).resolves.toBeDefined();
      await expect(service.sendMessage(send({ isCommit: true }))).resolves.toBeDefined();
    });

    it('refuses a frame from a device with no membership row in a live group - no member at all', async () => {
      // An external join's own commit activates its row before the commit is fanned out, so an
      // application frame never legitimately precedes it (0 such sends on production, 2026-10-22).
      deviceGroupRepo.findOne.mockResolvedValue(null);

      await expect(service.sendMessage(send({ durable: true }))).rejects.toMatchObject({
        response: { error: 'sender_not_member' },
      });
      expect(queuedMessageRepo.save).not.toHaveBeenCalled();
      expect(redis.xadd).not.toHaveBeenCalled();
    });

    it("refuses a caller naming another member's device - the row is read by person AND device", async () => {
      // The group holds ONE row: the member u2's device d2. The mock answers by every key of the
      // `where`, so a lookup by device id alone would find it and let u1 send as u2's device.
      const rows = [{ groupId: 'g1', userId: 'u2', deviceId: 'd2', status: 'active' }];
      deviceGroupRepo.findOne.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((r) => Object.entries(where).every(([k, v]) => r[k as keyof typeof r] === v)) ??
          null
      );

      await expect(
        service.sendMessage(send({ senderId: 'u1', senderDeviceId: 'd2', durable: true }), 'u1')
      ).rejects.toMatchObject({ response: { error: 'sender_not_member' } });
      expect(deviceGroupRepo.findOne).toHaveBeenCalledWith({
        where: { groupId: 'g1', userId: 'u1', deviceId: 'd2' },
      });
      expect(redis.xadd).not.toHaveBeenCalled();

      // The member itself still sends from it.
      await service.sendMessage(
        send({ senderId: 'u2', senderDeviceId: 'd2', durable: true }),
        'u2'
      );
      expect(redis.xadd).toHaveBeenCalledTimes(1);
    });
  });
});
