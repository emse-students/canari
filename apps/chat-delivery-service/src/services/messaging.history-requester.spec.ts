/// <reference types="jest" />

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

/**
 * A HISTORY LINE THAT DOES NOT NAME ITS CALLER MEASURES NOTHING.
 *
 * `[HISTORY]` named the group, the cursor and the row count. Thirteen full `after=start` walks over
 * one group in ten minutes on production 2026-09-16 were therefore unattributable to a device, to an
 * account, or even to a count of distinct callers - and a rate is only a defect once it is measured
 * against the population that produced it. These cases pin the field that makes that measurement
 * possible, and the property that keeps it from ever costing a request.
 */
describe('a history read names who asked', () => {
  let service: MessagingService;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  let redis: { xrange: jest.Mock; xrevrange: jest.Mock; del: jest.Mock };

  const GROUP = 'group-1';
  const ADMIN = 'true';
  const DEVICE = 'device-7';
  const USER = 'user-9';

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  /** Every `[HISTORY]`/`[HISTORY_BATCH]` line written during a case, joined. */
  const lines = () => [...log.mock.calls, ...error.mock.calls].map((c) => String(c[0])).join('\n');

  beforeEach(async () => {
    jest.restoreAllMocks();
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    redis = {
      xrange: jest.fn().mockResolvedValue([]),
      xrevrange: jest.fn().mockResolvedValue([]),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        {
          provide: getRepositoryToken(Group),
          // The group must exist, or the orphan purge answers before anything reads the stream.
          useValue: { ...emptyRepo(), find: jest.fn().mockResolvedValue([{ id: GROUP }]) },
        },
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
  });

  afterEach(() => jest.restoreAllMocks());

  it('names the user nginx authenticated and the device the client claims', async () => {
    await service.getHistory(GROUP, undefined, USER, ADMIN, undefined, undefined, DEVICE);

    expect(lines()).toContain(`[HISTORY] user=${USER} device=${DEVICE} group=${GROUP}`);
  });

  it('names them on the batch route too, which is where a catch-up starts', async () => {
    await service.getHistoryBatch([{ groupId: GROUP }], USER, ADMIN, DEVICE);

    expect(lines()).toContain(`[HISTORY] user=${USER} device=${DEVICE} group=${GROUP}`);
    expect(lines()).toContain(`[HISTORY_BATCH] user=${USER} device=${DEVICE} groups=1`);
  });

  /**
   * A client old enough not to send the header is not a defect and must not read as one: `unstated`
   * says "nobody told us", which is a different fact from "somebody told us something unusable".
   */
  it('says so when the caller sent no device, rather than inventing one', async () => {
    await service.getHistory(GROUP, undefined, USER, ADMIN);

    expect(lines()).toContain(`[HISTORY] user=${USER} device=unstated group=${GROUP}`);
  });

  /**
   * THE WHOLE POINT OF A DIAGNOSTIC FIELD IS THAT IT CANNOT COST THE REQUEST IT DESCRIBES. The
   * header is client-supplied, so it is also the obvious way to forge log lines - hence `invalid`
   * rather than the value, and a served page rather than a 400.
   */
  it('refuses a header it cannot print, and serves the page anyway', async () => {
    redis.xrevrange.mockResolvedValue([['9-0', ['content', 'ciphertext']]]);

    const { head } = await service.getHistory(
      GROUP,
      undefined,
      USER,
      ADMIN,
      undefined,
      undefined,
      'a\n[HISTORY] user=victim device=forged group=elsewhere'
    );

    expect(head).toBe('9-0');
    expect(lines()).toContain(`[HISTORY] user=${USER} device=invalid group=${GROUP}`);
    expect(lines()).not.toContain('device=forged');
  });
});
