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
   * this stream is the one road back to those frames. The server withholds them itself, by DROPPING
   * the rows and filling the page past them: the first shape kept a `{ id, withheld }` row, and every
   * store build shipped before it stalled on that row for good (third review of #1878).
   */
  describe('withholds what was sent while the READER was out', () => {
    const at = (iso: string) => new Date(iso);
    const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}T00:00:00.000Z`;
    /** A real stream: XRANGE honours its exclusive start, inclusive end and COUNT. */
    let stream: Array<[string, string[]]> = [];
    const seq = (id: string) => Number(id.split('-')[0]);
    const put = (n: number, d: number) =>
      stream.push([
        `${n}-0`,
        ['sender_id', 'peer', 'content', `Y2lwaGVy${n}`, 'timestamp', day(d)],
      ]);

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
      stream = [];
      put(1, 2);
      put(2, 4);
      put(3, 6);
      redis.xrange.mockImplementation(
        async (_k: string, start: string, end: string, _c: string, count: number) => {
          const lo = start === '-' ? -1 : seq(start.replace('(', ''));
          const hi = end === '+' ? Infinity : seq(end);
          return stream.filter(([id]) => seq(id) > lo && seq(id) <= hi).slice(0, count);
        }
      );
      redis.xrevrange.mockImplementation(async () => stream.slice(-1));
    });

    it('on the single-group read, the row is absent - never a shape without content', async () => {
      const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

      expect(page.rows.map((r) => r['id'])).toEqual(['1-0', '3-0']);
      for (const row of page.rows) expect(typeof row['content']).toBe('string');
      expect(lines()).toContain('withheld=1 (sent while the reader was out of the group)');
    });

    it('on the batch read', async () => {
      const res = await service.getHistoryBatch([{ groupId: GROUP }], USER, ADMIN);

      expect(res.histories[GROUP].map((r) => r['id'])).toEqual(['1-0', '3-0']);
    });

    it('fills the page past what it drops, so a short page never ends a walk early', async () => {
      stream = [];
      put(1, 4);
      put(2, 4);
      put(3, 4);
      put(4, 6);
      put(5, 7);

      // An incremental read (`after` set) takes the caller's limit.
      const page = await service.getHistory(GROUP, '0-0', USER, ADMIN, 2);

      expect(page.rows.map((r) => r['id'])).toEqual(['4-0', '5-0']);
    });

    /**
     * THE LOOP OF EVERY STORE BUILD BEFORE THIS ONE, transcribed from `history.ts` on `main`: walk
     * from the cursor up to the head pinned on the first page, stop on an empty page, DECODE EVERY
     * ROW'S `content` (`fromBase64` -> `atob`, which throws on `undefined`), and advance the cursor
     * past each row. A throw escapes to a catch that only logs, the cursor is never saved, and the
     * next replay throws on the same row - for good.
     */
    it('an OLD build walks the new payload to the end and never meets a row it cannot decode', async () => {
      stream = [];
      put(1, 2);
      for (let n = 2; n <= 7; n++) put(n, 4); // a whole page and more, all inside the window
      put(8, 6);
      put(9, 7);
      put(10, 4); // inside the window, AFTER the last row the reader may have

      const decode = (content: unknown): string => {
        if (typeof content !== 'string') throw new TypeError('atob: content is undefined');
        return content;
      };
      let cursor: string | undefined;
      let head: string | undefined;
      const decoded: string[] = [];
      for (let guard = 0; guard < 20; guard++) {
        const page = await service.getHistory(GROUP, cursor ?? '0-0', USER, ADMIN, 3, head);
        head ??= page.head;
        if (page.rows.length === 0) break;
        for (const row of page.rows) {
          decoded.push(decode(row['content']));
          cursor = String(row['id']);
        }
      }

      expect(decoded).toEqual(['Y2lwaGVy1', 'Y2lwaGVy8', 'Y2lwaGVy9']);
      expect(cursor).toBe('9-0');
    });

    it('the caller sets how much it is handed, never how many reads it costs', async () => {
      stream = [];
      for (let n = 1; n <= 300; n++) put(n, 4); // all inside the window
      put(301, 6);

      const page = await service.getHistory(GROUP, '0-0', USER, ADMIN, 1);

      expect(page.rows.map((r) => r['id'])).toEqual(['301-0']);
      // One chunk of HISTORY_FULL_PAGE_LIMIT, never 301 reads of one row.
      expect(redis.xrange).toHaveBeenCalledTimes(1);
    });

    /**
     * A ROSTER MEMBER WITH NO OPEN INTERVAL (an enrolment interrupted between its two statements) is
     * NOT read as out of the group from their last close onwards: that dropped every row since their
     * removal although they were a member again (fifth review of #1878). The interval is opened from
     * the roster row, as `GET .../exclusions` does, before the window is computed.
     */
    /** The interval table, with a repair transaction whose roster read finds `rosterJoinedAt`. */
    const withRepairableTable = (rosterJoinedAt: Date | null, stored: boolean) => {
      const table: Array<{ groupId: string; joinedAt: Date; leftAt: Date | null }> = [
        {
          groupId: GROUP,
          joinedAt: at('2026-10-01T00:00:00Z'),
          leftAt: at('2026-10-03T00:00:00Z'),
        },
      ];
      intervalFind.mockImplementation(async () => table.map((r) => ({ ...r })));
      const values = jest.fn();
      const ib: Record<string, unknown> = {
        insert: () => ib,
        into: () => ib,
        values: (v: Array<{ joinedAt: Date }>) => {
          values(v);
          return ib;
        },
        orIgnore: () => ib,
        returning: () => ib,
        execute: async () => {
          // `stored: false` is a concurrent repair that got there first: the conflict is ignored.
          table.push({ groupId: GROUP, joinedAt: rosterJoinedAt as Date, leftAt: null });
          return { raw: stored ? [{ userId: USER, joinedAt: rosterJoinedAt }] : [] };
        },
      };
      const rb: Record<string, unknown> = {
        select: () => rb,
        addSelect: () => rb,
        where: () => rb,
        andWhere: () => rb,
        setLock: () => rb,
        getRawMany: async () =>
          rosterJoinedAt ? [{ userId: USER, joinedAt: rosterJoinedAt }] : [],
      };
      const tx = {
        getRepository: () => ({ createQueryBuilder: () => rb }),
        createQueryBuilder: () => ib,
      };
      const internals = service as unknown as { groupRepo: { manager: Record<string, unknown> } };
      internals.groupRepo.manager.transaction = (fn: (t: unknown) => Promise<unknown>) => fn(tx);
      return values;
    };

    it('repairs a roster member with no open interval instead of reading them as still out', async () => {
      const values = withRepairableTable(at('2026-10-05T00:00:00Z'), true);

      const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

      // Without the repair, 3-0 (the 6th) falls in a window open from the 3rd and is dropped.
      expect(page.rows.map((r) => r['id'])).toEqual(['1-0', '3-0']);
      expect(values).toHaveBeenCalledWith([
        { groupId: GROUP, userId: USER, joinedAt: at('2026-10-05T00:00:00Z'), leftAt: null },
      ]);
      expect(lines()).toContain('opened a missing interval');
    });

    it('a concurrent repair that stored it first: the table is re-read, and no repair is claimed', async () => {
      withRepairableTable(at('2026-10-05T00:00:00Z'), false);

      const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

      expect(page.rows.map((r) => r['id'])).toEqual(['1-0', '3-0']);
      expect(lines()).not.toContain('opened a missing interval');
    });

    it('a person with no roster row and a closed interval is still read as out', async () => {
      withRepairableTable(null, false);

      const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

      expect(page.rows.map((r) => r['id'])).toEqual(['1-0']);
      expect(lines()).not.toContain('opened a missing interval');
    });

    it('counts a cursor followed only by withheld rows as caught up, not as a line per launch', async () => {
      stream.pop(); // the head is now 2-0, inside the window
      await service.getHistoryBatch([{ groupId: GROUP, after: '1-0' }], USER, ADMIN);

      expect(lines()).not.toContain('[HISTORY] ');
      expect(lines()).toContain('caughtUp=1');
    });

    it('a failed window read answers THAT group empty and serves the rest of the batch', async () => {
      intervalFind.mockImplementation(async (_e: unknown, opts: { where: { groupId: string } }) => {
        if (opts.where.groupId === 'group-2') throw new Error('connection reset');
        return [];
      });
      const groupRepo = (service as unknown as { groupRepo: { find: jest.Mock } }).groupRepo;
      groupRepo.find.mockResolvedValue([{ id: GROUP }, { id: 'group-2' }]);

      const res = await service.getHistoryBatch(
        [{ groupId: GROUP }, { groupId: 'group-2' }],
        USER,
        ADMIN
      );

      expect(res.histories['group-2']).toEqual([]);
      expect(res.histories[GROUP].map((r) => r['id'])).toEqual(['1-0', '2-0', '3-0']);
      expect(lines()).toContain('[HISTORY_BATCH] user=user-9 device=unstated group=group-2 error=');
    });

    /**
     * A NEWCOMER READS NOTHING FROM BEFORE THEIR ARRIVAL (user, 2026-10-21), and the server's own
     * stream is held to it too: the same `withheldWindows` the exclusions route answers, so the
     * ciphertexts a member's answer withholds are not served to the newcomer by this route either.
     */
    describe("in a GROUP conversation, also what preceded the reader's arrival", () => {
      /** The group row and the reader's earliest device row in it. */
      const groupAndFirstDevice = (
        group: { isGroup: boolean; createdAt: Date; distributionWorkspaceId?: string | null },
        firstDeviceAt: Date | null
      ) => {
        const internals = service as unknown as {
          groupRepo: { findOne: jest.Mock };
          deviceGroupRepo: { createQueryBuilder: jest.Mock };
        };
        internals.groupRepo.findOne = jest
          .fn()
          .mockResolvedValue({ id: GROUP, distributionChannelId: null, ...group });
        const qb: Record<string, unknown> = {
          select: () => qb,
          where: () => qb,
          andWhere: () => qb,
          getRawOne: async () => ({ firstDeviceAt }),
        };
        internals.deviceGroupRepo.createQueryBuilder = jest.fn(() => qb);
      };

      beforeEach(() => {
        stream = [];
        put(1, 2);
        put(2, 4);
        put(3, 6);
      });

      it('a newcomer added on the 5th is served nothing from before it', async () => {
        intervalFind.mockResolvedValue([
          { groupId: GROUP, joinedAt: at(day(5)), leftAt: null, admittedAt: null },
        ]);
        groupAndFirstDevice({ isGroup: true, createdAt: at(day(1)) }, at(day(5)));

        const page = await service.getHistory(GROUP, undefined, USER, ADMIN);
        const batch = await service.getHistoryBatch([{ groupId: GROUP }], USER, ADMIN);

        expect(page.rows.map((r) => r['id'])).toEqual(['3-0']);
        expect(batch.histories[GROUP].map((r) => r['id'])).toEqual(['3-0']);
      });

      it('the arrival is the EARLIER of the interval and the first device row (added = arrived)', async () => {
        intervalFind.mockResolvedValue([
          { groupId: GROUP, joinedAt: at(day(5)), leftAt: null, admittedAt: null },
        ]);
        groupAndFirstDevice({ isGroup: true, createdAt: at(day(1)) }, at(day(3)));

        const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

        expect(page.rows.map((r) => r['id'])).toEqual(['2-0', '3-0']);
      });

      it('the person who arrived with the group is withheld nothing', async () => {
        intervalFind.mockResolvedValue([
          { groupId: GROUP, joinedAt: at(day(1)), leftAt: null, admittedAt: null },
        ]);
        groupAndFirstDevice({ isGroup: true, createdAt: at(day(1)) }, at(day(1)));

        const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

        expect(page.rows.map((r) => r['id'])).toEqual(['1-0', '2-0', '3-0']);
      });

      it('a 1:1 and a key group withhold no arrival span, as before', async () => {
        intervalFind.mockResolvedValue([
          { groupId: GROUP, joinedAt: at(day(5)), leftAt: null, admittedAt: null },
        ]);
        groupAndFirstDevice({ isGroup: false, createdAt: at(day(1)) }, at(day(5)));
        expect(
          (await service.getHistory(GROUP, undefined, USER, ADMIN)).rows.map((r) => r['id'])
        ).toEqual(['1-0', '2-0', '3-0']);

        groupAndFirstDevice(
          { isGroup: true, createdAt: at(day(1)), distributionWorkspaceId: 'ws-1' },
          at(day(5))
        );
        expect(
          (await service.getHistory(GROUP, undefined, USER, ADMIN)).rows.map((r) => r['id'])
        ).toEqual(['1-0', '2-0', '3-0']);
      });

      it('a caller holding no interval (a global admin outside the group) is not narrowed', async () => {
        intervalFind.mockResolvedValue([]);
        groupAndFirstDevice({ isGroup: true, createdAt: at(day(1)) }, null);

        const page = await service.getHistory(GROUP, undefined, USER, ADMIN);

        expect(page.rows.map((r) => r['id'])).toEqual(['1-0', '2-0', '3-0']);
      });
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
