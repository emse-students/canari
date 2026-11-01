/// <reference types="jest" />

/**
 * THE THREE RELAY ROUTES ASK THE GROUP, NOT ONLY THE LOGIN (re-review of #2358).
 *
 * `mls/history-request` and `mls/base-refresh-request` make a member's device answer a requester,
 * and `mls/notify-reaction` pushes to a message's author - each on its caller's word alone, until
 * this spec: anyone authenticated could reach them for a group they were not in. Each route now goes
 * through the membership gate every route keyed by a group id shares (`assertCallerActsOnGroup`), and
 * a salon reaction through social-service's reader question. Per route: a member passes, a caller
 * with no seat is the 403 `NOT_A_MEMBER` and nothing leaves, a seat awaiting a member's admission is
 * the 409 its client waits on.
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
  const fetchMock = jest.fn();

  const redis = {
    smembers: jest.fn(),
    exists: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
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
    // The requester's own device and the author's: the election never picks the requester.
    redis.smembers.mockResolvedValue([`${MEMBER}:${MEMBER}-dev`, `${AUTHOR}:da`]);
    redis.exists.mockResolvedValue(1);

    const groupRepo = {
      ...emptyRepo(),
      findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === GROUP ? { id: GROUP } : null
      ),
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
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
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
        expect(push).not.toHaveBeenCalled();
      });
    });
  });
});
