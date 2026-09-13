/// <reference types="jest" />

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

/**
 * A FRAME LEAVES THIS SERVICE IN ONE WAY, WHICHEVER ROUTE PUT IT IN THE QUEUE.
 *
 * `sendMessage` and `sendWelcome` both persist a row and then hand it to a device: publish on
 * `chat:messages` if the device is online, push over FCM if it is not. They wrote that out twice,
 * each from its own request body rather than from the row, and diverged where a body differs from
 * a row - the Welcome's envelope carried no `isCommit`, no `createdAt`, and a `senderDeviceId`
 * written as an empty literal.
 *
 * **AND ONE OF THEM NEVER ARMED THE DEFERRED FALLBACK.** That fallback is the whole answer to a
 * frozen Android app: the kernel holds the TCP connection open and the presence key stays fresh, so
 * the server believes the device is reachable and publishes into a socket no process is reading.
 * For a message that costs one notification. For a WELCOME it costs the join - the device stays
 * outside the group, and `sendWelcome`'s own offline branch already names the consequence, "the
 * subsequent message push then fails to decrypt (Groupe introuvable)". It published and stopped.
 *
 * So the table below drives both ROUTES over one policy rather than asserting on the shared
 * function: a route that publishes its own envelope is exactly what this file is here to catch.
 */

const GROUP = 'g1';
const TARGET_USER = 'u2';
const TARGET_DEVICE = 'd2';
const PROTO = 'cGF5bG9hZA==';

/** Every field the envelope carries. Both routes publish this key set, or they have diverged. */
const ENVELOPE_KEYS = [
  'createdAt',
  'deviceId',
  'groupId',
  'isCommit',
  'isWelcome',
  'proto',
  'queuedMessageId',
  'recipientId',
  'senderDeviceId',
  'senderId',
];

interface Route {
  name: string;
  send: () => Promise<unknown>;
  /** A Welcome is a handshake: pushed silently, so the background receiver joins without ringing. */
  silent: boolean;
}

describe('a queued frame - one delivery, two routes', () => {
  let service: MessagingService;
  let routes: Route[];
  /** Every `sendFcmForQueued` call, as `{ silent, traceId }`. */
  let pushes: { silent: boolean; traceId: string }[];

  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  };

  const deviceGroupRepo = {
    // The sender's own row: `active`, so the send is not refused for holding no leaf.
    findOne: jest.fn().mockResolvedValue({ status: 'active' }),
    // The recipients.
    find: jest
      .fn()
      .mockResolvedValue([{ userId: TARGET_USER, deviceId: TARGET_DEVICE, status: 'active' }]),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    createQueryBuilder: jest.fn(() => insertBuilder),
  };

  const keyPackageRepo = {
    // The proof the target device exists server-side, read by both routes for their own reason.
    find: jest.fn().mockResolvedValue([{ userId: TARGET_USER, deviceId: TARGET_DEVICE }]),
    findOne: jest.fn().mockResolvedValue({ userId: TARGET_USER, deviceId: TARGET_DEVICE }),
    save: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
  };

  /** Assigns the id TypeORM would, in place, because the caller keeps the row it handed over. */
  const queuedSave = jest.fn(async (rows: Record<string, unknown> | Record<string, unknown>[]) => {
    const list = Array.isArray(rows) ? rows : [rows];
    list.forEach((row, i) => {
      row.id = row.id ?? `q${i + 1}`;
    });
    return rows;
  });

  const queuedMessageRepo = {
    create: jest.fn((e: Record<string, unknown>) => e),
    save: queuedSave,
    find: jest.fn().mockResolvedValue([]),
    // The deferred fallback asks whether the row is still unACKed. It is - that is the case the
    // fallback exists for.
    findOne: jest.fn().mockResolvedValue({ id: 'q1' }),
    delete: jest.fn(),
    manager: {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
        cb({
          getRepository: (entity: unknown) =>
            entity === Group
              ? { find: jest.fn().mockResolvedValue([{ id: GROUP, deletedAt: null }]) }
              : { save: queuedSave },
        })
      ),
    },
  };

  const pipelineDouble = () => {
    const chain = {
      xadd: () => chain,
      xtrim: () => chain,
      expire: () => chain,
      exec: () => Promise.resolve([]),
    };
    return chain;
  };

  const redis = {
    exists: jest.fn().mockResolvedValue(0),
    publish: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(0),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    del: jest.fn(),
    pipeline: jest.fn(() => pipelineDouble()),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  /** The envelope the route published, parsed. */
  const published = () => JSON.parse(redis.publish.mock.calls[0][1] as string);

  beforeEach(async () => {
    jest.clearAllMocks();
    pushes = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: keyPackageRepo },
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
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    // The push itself is Firebase's; what this file asserts is that it is REACHED, and with which
    // visibility. Without the spy it returns at `getApps().length === 0` and leaves no trace.
    jest
      .spyOn(service as unknown as { sendFcmForQueued: () => Promise<void> }, 'sendFcmForQueued')
      .mockImplementation(
        (..._args: unknown[]): Promise<void> => (
          pushes.push({ traceId: String(_args[1]), silent: _args[4] === true }),
          Promise.resolve()
        )
      );

    routes = [
      {
        name: 'a message send',
        silent: false,
        send: () =>
          service.sendMessage(
            {
              proto: PROTO,
              groupId: GROUP,
              senderId: 'u1',
              senderDeviceId: 'd1',
            },
            'u1'
          ),
      },
      {
        name: 'a welcome send',
        silent: true,
        send: () =>
          service.sendWelcome(undefined, {
            groupId: GROUP,
            targetUserId: TARGET_USER,
            targetDeviceId: TARGET_DEVICE,
            welcomePayload: PROTO,
          }),
      },
    ];
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe.each([0, 1])('route %i', (index) => {
    it('publishes one envelope, built from the row rather than from the request', async () => {
      redis.exists.mockResolvedValue(1);

      await routes[index].send();

      expect(redis.publish).toHaveBeenCalledTimes(1);
      const envelope = published();
      // The SAME key set from both routes. A route building its own carried whichever subset its
      // body happened to have - which is how the Welcome lost `isCommit` and `createdAt`.
      expect(Object.keys(envelope).sort()).toEqual(ENVELOPE_KEYS);
      expect(envelope).toMatchObject({
        recipientId: TARGET_USER,
        deviceId: TARGET_DEVICE,
        groupId: GROUP,
        proto: PROTO,
        queuedMessageId: 'q1',
      });
      // Without this id the client cannot ACK a frame it processed in realtime, so the durable row
      // survives and the next pull redelivers it - destructively, for a Welcome.
      expect(typeof envelope.createdAt).toBe('string');
    });

    it('arms the deferred fallback, because an online Android app may be frozen', async () => {
      // THE DEFECT, EXACTLY. `exists` answers 1 for a device whose kernel holds the socket while
      // the process cannot read it, so the publish above reaches nobody and nothing followed it.
      redis.exists.mockResolvedValue(1);
      jest.useFakeTimers();

      await routes[index].send();
      expect(pushes).toEqual([]);

      await jest.advanceTimersByTimeAsync(10_000);

      expect(pushes).toHaveLength(1);
      expect(pushes[0].silent).toBe(routes[index].silent);
      // The deferred attempt is traceable back to the send that armed it.
      expect(pushes[0].traceId).toMatch(/-def$/);
    });

    it('pushes straight away when the device is offline, and publishes nothing', async () => {
      redis.exists.mockResolvedValue(0);

      await routes[index].send();

      expect(redis.publish).not.toHaveBeenCalled();
      expect(pushes).toHaveLength(1);
      expect(pushes[0].silent).toBe(routes[index].silent);
    });

    it('persists the row before it tries to deliver it', async () => {
      redis.exists.mockResolvedValue(1);

      await routes[index].send();

      // The delivery is best-effort at every step; the row is what survives a crash, a restart or
      // a device that never ACKs, and every case above rests on it existing first.
      expect(queuedMessageRepo.manager.transaction).toHaveBeenCalledTimes(1);
      expect(queuedSave).toHaveBeenCalledTimes(1);
    });
  });

  it('is driving two routes, and not one of them twice', () => {
    // The self-check: two rows landing on the same handler would make every case above a statement
    // about one route, and the divergence this file exists for would be invisible.
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((r) => r.send.toString())).size).toBe(2);
    expect(service).toBeInstanceOf(MessagingService);
  });
});
