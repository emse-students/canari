/// <reference types="jest" />

/**
 * THE RELAY ROUTES ASK THE GROUP, NOT ONLY THE LOGIN (re-review of #2358).
 *
 * `mls/history-request`, `mls/base-refresh-request` and `mls/welcome-request` make a member's device
 * answer a requester, and `mls/notify-reaction` pushes to a message's author - each on its caller's
 * word alone, until this spec: anyone authenticated could reach them for a group they were not in.
 * History and base refresh go through the gate every route keyed by a group id shares
 * (`assertCallerActsOnGroup`): a member passes, no seat is the 403 `NOT_A_MEMBER` and nothing leaves,
 * a seat awaiting admission is the 409. The welcome request relays ANY seat, a waiting one above all
 * (`assertCallerHoldsSeat`), never a key group, and re-asks its stored asks at the drain. A salon
 * reaction asks social-service's reader question.
 */
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingController } from './messaging.controller';
import { MessagingService } from '../services/messaging.service';
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

const GROUP = '00000000-0000-4000-8000-0000000000c1';
const SALON = '00000000-0000-4000-8000-0000000000c2';
const MEMBER = 'member';
const STRANGER = 'stranger';
const AUTHOR = 'author';

/** The status and refusal name of a rejected call, or `null` when it resolved. */
const refusalOf = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (e: { getStatus: () => number; getResponse: () => { code?: string; error?: string } }) => ({
      status: e.getStatus(),
      name: e.getResponse().code ?? e.getResponse().error,
    })
  );

describe('the relay routes refuse a caller with no seat in the group they name', () => {
  let controller: MessagingController;
  let service: MessagingService;
  let push: jest.SpyInstance;
  const env = { ...process.env };
  const realFetch = global.fetch;

  /** Who holds a seat in GROUP, and whether it awaits a member's admission. */
  let seats: Map<string, { awaitingAdmission: boolean }>;
  /** The `dm_groups` rows, by id - GROUP a conversation unless a test makes it a key group. */
  let groups: Map<string, Record<string, unknown>>;
  /** What `pending_welcome:<GROUP>` holds: welcome requests stored while no member was online. */
  let storedAsks: string[];
  let warn: jest.SpyInstance;
  /** `dm_groups.findOne` - an id that is not a uuid must be refused before it is ever called. */
  let groupFindOne: jest.Mock;
  const fetchMock = jest.fn();

  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.INTERNAL_SECRET = 'shared-secret';
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
    seats = new Map([
      [MEMBER, { awaitingAdmission: false }],
      [AUTHOR, { awaitingAdmission: false }],
    ]);
    groups = new Map([[GROUP, { id: GROUP }]]);
    storedAsks = [];
    // The requester's own device and the author's: the election never picks the requester.
    redis.smembers.mockImplementation(async (key: string) =>
      key.startsWith('pending_welcome:') ? storedAsks : [`${MEMBER}:${MEMBER}-dev`, `${AUTHOR}:da`]
    );
    redis.exists.mockResolvedValue(1);

    groupFindOne = jest.fn(
      async ({ where }: { where: { id: string } }) => groups.get(where.id) ?? null
    );
    const groupRepo = {
      ...emptyRepo(),
      findOne: groupFindOne,
    };
    const memberRepo = {
      ...emptyRepo(),
      findOne: jest.fn(async ({ where }: { where: { groupId: string; userId: string } }) => {
        const seat = where.groupId === GROUP ? seats.get(where.userId) : undefined;
        return seat ? { id: `seat-${where.userId}`, ...seat } : null;
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: memberRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
    // Built by hand: the route's guards are not under test here, the handler's gate is.
    controller = new MessagingController(service);
    push = jest.spyOn(service, 'sendPushToUser').mockResolvedValue({ sent: 1, failed: 0 });
    const logger = (service as unknown as { logger: Record<string, (m: string) => void> }).logger;
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...env };
    global.fetch = realFetch;
  });

  const ask = (caller: string) => ({
    groupId: GROUP,
    requesterUserId: caller,
    requesterDeviceId: `${caller}-dev`,
  });

  describe('POST mls/history-request', () => {
    it('elects a member for an admitted member', async () => {
      const res = await controller.notifyHistoryRequest(MEMBER, ask(MEMBER));

      expect(res).toEqual({ status: 'forwarded', target: `${AUTHOR}:da` });
      expect(redis.publish).toHaveBeenCalledTimes(1);
    });

    it('refuses a caller with no seat - never a member, or removed - and relays nothing', async () => {
      await expect(
        refusalOf(controller.notifyHistoryRequest(STRANGER, ask(STRANGER)))
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(redis.smembers).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('answers a seat awaiting admission the 409 it waits on, never the 403 that retires', async () => {
      seats.set(STRANGER, { awaitingAdmission: true });

      await expect(
        refusalOf(controller.notifyHistoryRequest(STRANGER, ask(STRANGER)))
      ).resolves.toEqual({ status: 409, name: 'awaiting_admission' });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('refuses an id that is not a uuid with the 403, asking no table (never the 500 of 22P02)', async () => {
      await expect(
        refusalOf(
          controller.notifyHistoryRequest(MEMBER, { ...ask(MEMBER), groupId: 'not-a-group' })
        )
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(groupFindOne).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });
  });

  describe('POST mls/base-refresh-request', () => {
    it('elects a member for an admitted member', async () => {
      const res = await controller.notifyBaseRefreshRequest(MEMBER, ask(MEMBER));

      expect(res).toEqual({ status: 'forwarded', target: `${AUTHOR}:da` });
      expect(redis.publish).toHaveBeenCalledTimes(1);
    });

    it('refuses a caller with no seat and relays nothing', async () => {
      await expect(
        refusalOf(controller.notifyBaseRefreshRequest(STRANGER, ask(STRANGER)))
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('answers a seat awaiting admission the 409', async () => {
      seats.set(STRANGER, { awaitingAdmission: true });

      await expect(
        refusalOf(controller.notifyBaseRefreshRequest(STRANGER, ask(STRANGER)))
      ).resolves.toEqual({ status: 409, name: 'awaiting_admission' });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('refuses an id that is not a uuid with the 403, asking no table', async () => {
      await expect(
        refusalOf(
          controller.notifyBaseRefreshRequest(MEMBER, { ...ask(MEMBER), groupId: 'not-a-group' })
        )
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(groupFindOne).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });
  });

  describe('POST mls/welcome-request - any seat may ask, a waiting one above all', () => {
    /** Who the relayed frames named as requester, in publish order. */
    const relayedRequesters = () =>
      redis.publish.mock.calls.map(
        (c) => (JSON.parse(c[1] as string) as { senderId: string }).senderId
      );

    it('refuses a caller with no seat, and neither elects nor stores anything', async () => {
      await expect(
        refusalOf(controller.notifyWelcomeRequest(STRANGER, ask(STRANGER)))
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(redis.smembers).not.toHaveBeenCalled();
      expect(redis.exists).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it("relays a seat awaiting a member's admission - the ask this route exists for", async () => {
      seats.set(STRANGER, { awaitingAdmission: true });

      await expect(controller.notifyWelcomeRequest(STRANGER, ask(STRANGER))).resolves.toEqual({
        status: 'forwarded',
        target: expect.any(String),
      });
      expect(relayedRequesters()).toEqual([STRANGER]);
    });

    it("relays an admitted member's new device", async () => {
      const res = await controller.notifyWelcomeRequest(MEMBER, {
        ...ask(MEMBER),
        requesterDeviceId: 'new-phone',
      });

      expect(res.status).toBe('forwarded');
      expect(relayedRequesters()).toEqual([MEMBER]);
    });

    it('refuses a key-distribution group with the same 403, even to a row on its roster', async () => {
      groups.set(GROUP, { id: GROUP, distributionWorkspaceId: 'ws-1' });

      await expect(
        refusalOf(controller.notifyWelcomeRequest(MEMBER, ask(MEMBER)))
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('refuses an id that is not a uuid, asking no table', async () => {
      await expect(
        refusalOf(controller.notifyWelcomeRequest(MEMBER, { ...ask(MEMBER), groupId: 'nope' }))
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(groupFindOne).not.toHaveBeenCalled();
    });

    it('re-asks every stored ask at the drain: one with no seat any more is dropped, and said', async () => {
      // Stored while no member was online - before the gate existed, or by someone removed since.
      seats.set('waiting', { awaitingAdmission: true });
      storedAsks = ['waiting:w-dev', `${STRANGER}:s-dev`];

      await controller.notifyWelcomeRequest(MEMBER, { ...ask(MEMBER), requesterDeviceId: 'new' });

      expect(relayedRequesters()).toEqual([MEMBER, 'waiting']);
      expect(warn.mock.calls.flat().join(' ')).toContain('DROPPED 1 stored welcome_request');
    });
  });

  describe('POST mls/notify-reaction', () => {
    const reaction = (groupId: string) => ({
      groupId,
      targetSenderId: AUTHOR,
      emoji: '+1',
      messageId: 'm-1',
      actorName: 'Someone',
    });

    it('pushes to the author for a member of the conversation', async () => {
      await expect(controller.notifyReaction(MEMBER, reaction(GROUP))).resolves.toEqual({
        sent: 1,
        failed: 0,
      });
      expect(push).toHaveBeenCalledWith(
        AUTHOR,
        'Someone',
        expect.any(String),
        expect.objectContaining({ groupId: GROUP, senderId: MEMBER })
      );
    });

    it('refuses a caller with no seat, and pushes nothing', async () => {
      await expect(
        refusalOf(controller.notifyReaction(STRANGER, reaction(GROUP)))
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(push).not.toHaveBeenCalled();
    });

    it('refuses an id that names no conversation with the same 403, without asking the database', async () => {
      await expect(
        refusalOf(controller.notifyReaction(MEMBER, reaction('not-a-group')))
      ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
      expect(push).not.toHaveBeenCalled();
    });

    describe('a salon reaction (`channel_<id>`) asks social-service whether the caller reads it', () => {
      const answer = (reader: unknown) =>
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ reader }) });

      it("pushes to the author for a reader, asking the salon's reader route", async () => {
        answer(true);

        await expect(
          controller.notifyReaction(MEMBER, reaction(`channel_${SALON}`))
        ).resolves.toEqual({ sent: 1, failed: 0 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(new RegExp(`/api/internal/channels/${SALON}/reader$`));
        expect(init.headers).toEqual(
          expect.objectContaining({ 'x-internal-secret': 'shared-secret' })
        );
        expect(JSON.parse(String(init.body))).toEqual({ userId: MEMBER });
      });

      it('refuses a caller who does not read the salon, and pushes nothing', async () => {
        answer(false);

        await expect(
          refusalOf(controller.notifyReaction(STRANGER, reaction(`channel_${SALON}`)))
        ).resolves.toEqual({ status: 403, name: 'NOT_A_MEMBER' });
        expect(push).not.toHaveBeenCalled();
      });

      it('answers the retryable 503 when social-service cannot answer - never a refusal', async () => {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

        const call = controller.notifyReaction(MEMBER, reaction(`channel_${SALON}`));

        await expect(call).rejects.toBeInstanceOf(ServiceUnavailableException);
        await expect(call).rejects.not.toBeInstanceOf(ForbiddenException);
        // Named for ITS question, never for the key-group entitlement's.
        await expect(refusalOf(call)).resolves.toEqual({
          status: 503,
          name: 'salon_reader_unavailable',
        });
        expect(push).not.toHaveBeenCalled();
      });
    });
  });
});
