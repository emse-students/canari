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
  let intervalFind: jest.Mock;

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
    intervalFind = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        {
          provide: getRepositoryToken(Group),
          // The group must exist, or the orphan purge answers before anything reads the stream.
          useValue: {
            ...emptyRepo(),
            find: jest.fn().mockResolvedValue([{ id: GROUP }]),
            // The reader's own membership intervals (a Remove holds against a later re-add).
            manager: { find: intervalFind, query: jest.fn().mockResolvedValue([]) },
          },
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

  /**
   * A REMOVE HOLDS AGAINST A LATER RE-ADD (user, 2026-10-14). When the Remove commit never landed,
   * the re-admitted person's OLD state can still open every frame sealed while they were out, and
   * this stream is the one road back to those frames. The server withholds them itself: the row
   * keeps its id - so the reader's cursor moves past it - and nothing else.
   */
  describe('withholds what was sent while the READER was out', () => {
    const at = (iso: string) => new Date(iso);
    const entry = (id: string, iso: string): [string, string[]] => [
      id,
      ['sender_id', 'peer', 'content', `cipher-${id}`, 'timestamp', iso],
    ];

    beforeEach(() => {
      // The reader was out from the 3rd to the 5th.
      intervalFind.mockResolvedValue([
        {
          groupId: GROUP,
          joinedAt: at('2026-10-01T00:00:00Z'),
          leftAt: at('2026-10-03T00:00:00Z'),
        },
        { groupId: GROUP, joinedAt: at('2026-10-05T00:00:00Z'), leftAt: null },
      ]);
      redis.xrange.mockResolvedValue([
        entry('1-0', '2026-10-02T00:00:00.000Z'),
        entry('2-0', '2026-10-04T00:00:00.000Z'),
        entry('3-0', '2026-10-06T00:00:00.000Z'),
      ]);
    });

    it('on the single-group read', async () => {
      const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

      expect(page.rows.map((r) => r['id'])).toEqual(['1-0', '2-0', '3-0']);
      expect(page.rows[1]).toEqual({ id: '2-0', withheld: '1' });
      expect(page.rows[0]['content']).toBe('cipher-1-0');
      expect(page.rows[2]['content']).toBe('cipher-3-0');
      expect(lines()).toContain('withheld=1 of 3');
    });

    it('on the batch read', async () => {
      const res = await service.getHistoryBatch([{ groupId: GROUP }], USER, ADMIN);

      expect(res.histories[GROUP][1]).toEqual({ id: '2-0', withheld: '1' });
      expect(res.histories[GROUP][2]['content']).toBe('cipher-3-0');
    });

    it('reads the windows of the CALLER, never of anybody else', async () => {
      await service.getHistory(GROUP, undefined, USER, ADMIN);

      expect(intervalFind).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ where: expect.objectContaining({ userId: USER }) })
      );
    });
  });

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
   * `after=X until=X entries=0` was read on 2026-10-13 as a client asking for an empty window. The
   * client had sent no `until`: the line printed the head it found there. A caught-up group on the
   * batch route is now a count, not a line, and a line prints the caller's bound and the head apart.
   */
  it('counts a caught-up group on the batch route and prints the bound it was asked', async () => {
    redis.xrevrange.mockResolvedValue([['9-0', ['content', 'ciphertext']]]);

    await service.getHistoryBatch([{ groupId: GROUP, after: '9-0' }], USER, ADMIN, DEVICE);
    expect(lines()).not.toContain('[HISTORY] ');
    expect(lines()).toContain('groups=1 authorized=1 caughtUp=1');

    log.mockClear();
    await service.getHistoryBatch([{ groupId: GROUP, after: '8-0' }], USER, ADMIN, DEVICE);
    expect(lines()).toContain(`group=${GROUP} after=8-0 until=none head=9-0`);
    expect(lines()).toContain('caughtUp=0');
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
