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
import { PENDING_FETCH_CHUNK_ROWS, PENDING_PAGE_MAX_BYTES } from '../retention.constants';

/**
 * A PAGE IS A UNIT OF TRANSFER, SO IT MUST BE BOUNDED IN BYTES.
 *
 * Measured on production 2026-08-13: a device whose frames carried media was asked for 500 rows,
 * which is 12 MB. The client abandoned the request on its own per-page deadline having received
 * nothing, so it ACKed nothing, so the queue never shrank - and the next attempt met the same
 * 12 MB. A closed loop, and the backlog only grew (959 -> 965 -> 976 rows over three hourly
 * reports, never once down).
 *
 * The row limit was never the wrong idea, it was the wrong UNIT. These tests pin the byte budget,
 * the one row that must always be sent whatever its size, and the chunked read that keeps the
 * service itself from loading 44 MB to answer a request it will trim to 1 MB.
 */
describe('MessagingService.fetchMessages - the page is bounded in bytes', () => {
  let service: MessagingService;

  /** Every chunk the service asked for, as `skip`/`take` pairs, in order. */
  let asked: Array<{ skip: number; take: number }>;
  /** The whole queue this fake table holds, oldest first. */
  let table: Array<Partial<QueuedMessage>>;

  const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

  /**
   * One queued row. `atMs` is its `createdAt` offset from the base instant, and it matters: the
   * page must never end inside a group of rows sharing one `createdAt`, so tests that do not mean
   * to exercise that case must give every row its own instant.
   */
  const row = (id: string, bytes: number, atMs: number): Partial<QueuedMessage> => ({
    id,
    // `proto` is base64 text and the service sizes a row by its length, so a string of N
    // characters is a row of N bytes for the purpose being tested.
    proto: 'x'.repeat(bytes),
    createdAt: new Date(BASE + atMs),
  });

  /**
   * When set, the fake orders like PostgreSQL does: by the ORDER BY it was given and NOTHING else,
   * so rows that tie on every given key come back in an order that differs from one query to the
   * next (here: reversed on every other read) - which is what an OFFSET over a non-total order is
   * allowed to do. Off for the tests that do not mean to exercise it, which hand the table in order.
   */
  let honourOrder: boolean;
  let reads: number;

  const queryBuilder = () => {
    const state = { skip: 0, take: 0, hideAddressed: false, order: [] as string[] };
    const qb = {
      leftJoinAndSelect: () => qb,
      where: () => qb,
      // The one condition this fake honours: the SQL filter that withholds addressed rows.
      andWhere: (condition: string) => {
        if (/q\.addressed = false/.test(condition)) state.hideAddressed = true;
        return qb;
      },
      orderBy: (key: string) => {
        state.order = [key];
        return qb;
      },
      addOrderBy: (key: string) => {
        state.order.push(key);
        return qb;
      },
      // `offset`/`limit`, the SQL ones: the payload join is many-to-one, so it cannot multiply rows
      // and TypeORM's two-query `skip`/`take` pagination would only double the read.
      offset: (n: number) => {
        state.skip = n;
        return qb;
      },
      limit: (n: number) => {
        state.take = n;
        return qb;
      },
      getMany: async () => {
        asked.push({ skip: state.skip, take: state.take });
        let rows = state.hideAddressed ? table.filter((r) => !r.addressed) : table;
        if (honourOrder) {
          const flip = reads++ % 2 === 1;
          const key = (r: Partial<QueuedMessage>, k: string) =>
            k === 'q.createdAt' ? +(r.createdAt as Date) : k === 'q.id' ? String(r.id) : '';
          rows = [...rows].sort((a, b) => {
            for (const k of state.order) {
              const x = key(a, k);
              const y = key(b, k);
              if (x !== y) return x < y ? -1 : 1;
            }
            // A tie on every declared key: the database owes no order, and gives a different one.
            return (table.indexOf(a) - table.indexOf(b)) * (flip ? -1 : 1);
          });
        }
        return rows.slice(state.skip, state.skip + state.take);
      },
    };
    return qb;
  };

  const queuedMessageRepo = {
    createQueryBuilder: jest.fn(() => queryBuilder()),
    count: jest.fn(async () => table.filter((r) => r.addressed).length),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
  };

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  /** Rows carry no `groupId`, so the orphan purge lets every one of them through untouched. */
  const fetch = (limit: number) =>
    service.fetchMessages('u1', 'd1', 'u1', undefined, limit, undefined);

  beforeEach(async () => {
    jest.clearAllMocks();
    asked = [];
    table = [];
    honourOrder = false;
    reads = 0;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: queuedMessageRepo },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: getRepositoryToken(Group), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(DeviceGroupMembership), useValue: emptyRepo() },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        {
          provide: 'REDIS_CLIENT',
          useValue: {
            xadd: jest.fn(),
            expire: jest.fn(),
            xrange: jest.fn().mockResolvedValue([]),
            smembers: jest.fn().mockResolvedValue([]),
            exists: jest.fn().mockResolvedValue(0),
            publish: jest.fn(),
            del: jest.fn(),
            keys: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  it('stops at the byte budget even when the row limit is nowhere near reached', async () => {
    // 40 rows of 100 kB = 4 MB asked for as 500 rows: the defect exactly, at a tenth of its size.
    const big = 100 * 1024;
    table = Array.from({ length: 40 }, (_, i) => row(`m${i}`, big, i));

    const page = await fetch(500);

    // Ten rows fit in 1 MB; the eleventh would cross it.
    expect(page).toHaveLength(Math.floor(PENDING_PAGE_MAX_BYTES / big));
    const bytes = page.reduce((n, m) => n + (m.proto?.length ?? 0), 0);
    expect(bytes).toBeLessThanOrEqual(PENDING_PAGE_MAX_BYTES);
  });

  /**
   * Review of #2270: an ADDRESSED row is a history answer the server routed to sessions that declared
   * they apply rule 5. A session that did not declare it - an older tab - must not pull it either.
   * Withheld IN THE QUERY, so the page and its cursor are untouched and the row stays queued for the
   * session that can read it.
   */
  it('withholds an addressed row from a fetch that did not declare the capability', async () => {
    table = [row('a', 10, 0), { ...row('b', 10, 1), addressed: true }, row('c', 10, 2)];

    const older = await service.fetchMessages('u1', 'd1', 'u1', undefined, 500, undefined);
    const current = await service.fetchMessages(
      'u1',
      'd1',
      'u1',
      undefined,
      500,
      undefined,
      'addressed-history-1'
    );

    expect(older.map((m) => m.id)).toEqual(['a', 'c']);
    expect(current.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(queuedMessageRepo.delete).not.toHaveBeenCalled();
  });

  it('reports the withheld rows once for a device, not on every pull of an older session', async () => {
    table = [row('a', 10, 0), { ...row('b', 10, 1), addressed: true }];
    const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    const withheldLines = () =>
      logSpy.mock.calls.filter(([m]) => String(m).includes('WITHHELD')).length;

    await service.fetchMessages('u1', 'd1', 'u1', undefined, 500, undefined);
    await service.fetchMessages('u1', 'd1', 'u1', undefined, 500, undefined);
    expect(withheldLines()).toBe(1);

    // A second row waiting is a change: told again, once.
    table.push({ ...row('c', 10, 2), addressed: true });
    await service.fetchMessages('u1', 'd1', 'u1', undefined, 500, undefined);
    await service.fetchMessages('u1', 'd1', 'u1', undefined, 500, undefined);
    expect(withheldLines()).toBe(2);

    expect(warnSpy.mock.calls.filter(([m]) => String(m).includes('WITHHELD'))).toHaveLength(0);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('always sends at least one row, however big that row is', async () => {
    // A frame larger than the whole budget must remain deliverable. Trimming it to nothing would
    // block its device's queue for ever - the failure being fixed, not a smaller version of it.
    table = [row('huge', PENDING_PAGE_MAX_BYTES * 3, 0), row('next', 10, 1)];

    const page = await fetch(500);

    expect(page.map((m) => m.id)).toEqual(['huge']);
  });

  it('reads the table in small chunks, so answering never loads the whole backlog', async () => {
    // Without this the service reads `limit` rows before trimming: 500 rows at 88 kB is 44 MB
    // pulled out of Postgres to return 1 MB, once per request, per device.
    table = Array.from({ length: 400 }, (_, i) => row(`m${i}`, 100 * 1024, i));

    await fetch(500);

    expect(asked.every((a) => a.take <= PENDING_FETCH_CHUNK_ROWS)).toBe(true);
    // 1 MB of 100 kB rows is reached inside the first chunk, so exactly one read happens.
    expect(asked).toEqual([{ skip: 0, take: PENDING_FETCH_CHUNK_ROWS }]);
  });

  it('keeps paging across chunks while the rows are small, up to the row limit', async () => {
    // Small frames must still fill a page: the byte budget is a ceiling, never a new, lower
    // row limit. 120 rows of 100 bytes is 12 kB - nothing here should stop before the limit.
    table = Array.from({ length: 500 }, (_, i) => row(`m${i}`, 100, i));

    const page = await fetch(120);

    expect(page).toHaveLength(120);
    // Chunks are a fixed size: the read cannot be clamped to what is left of the row limit, because
    // the page may have to reach PAST that limit to finish a group of rows sharing one instant.
    expect(asked).toEqual([
      { skip: 0, take: 50 },
      { skip: 50, take: 50 },
      { skip: 100, take: 50 },
    ]);
  });

  it('never ends a page inside a group of rows sharing one createdAt', async () => {
    // The client resumes with `createdAt > <last row seen>`, which is STRICT - so a page split
    // inside such a group drops the rest of it from every later page and the frame is never
    // delivered at all. `@CreateDateColumn` writes millisecond precision from the application, so
    // this is measured rather than theoretical: one colliding pair sat in the live queue the day
    // the byte cap shipped, and byte-capping is what makes truncation the normal case.
    const big = 100 * 1024;
    // Ten rows fill the megabyte; rows 9, 10 and 11 share an instant, so the cut cannot fall
    // between them and all three must travel together.
    table = Array.from({ length: 20 }, (_, i) => row(`m${i}`, big, i < 9 ? i : 9));

    const page = await fetch(500);

    expect(page.map((m) => m.id)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
      'm8',
      'm9',
      'm10',
      'm11',
      'm12',
      'm13',
      'm14',
      'm15',
      'm16',
      'm17',
      'm18',
      'm19',
    ]);
  });

  it('lets the row limit be exceeded too, rather than splitting such a group', async () => {
    // Same rule, the other cap: a page of exactly `limit` rows is not worth losing a frame for.
    table = [
      ...Array.from({ length: 4 }, (_, i) => row(`m${i}`, 10, i)),
      row('tie1', 10, 99),
      row('tie2', 10, 99),
      row('after', 10, 100),
    ];

    const page = await fetch(5);

    expect(page.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'tie1', 'tie2']);
  });

  it('hands every row exactly once when a createdAt tie spans a chunk boundary - the id breaks it', async () => {
    // One transaction writes a whole fan-out under one `now()`, so a device's queue can hold more
    // rows sharing one `createdAt` than a chunk reads. The chunks page with OFFSET, and an OFFSET
    // over an order with ties may hand one row twice and skip another, because the database owes
    // the tied rows no order and need not repeat it. `q.id` after `createdAt` makes it total;
    // without it this fake, ordering only by what it was told, duplicates and drops rows here.
    honourOrder = true;
    const tied = PENDING_FETCH_CHUNK_ROWS * 2 + 7;
    // Ids that sort in a different order than they were inserted, so insertion order is no help.
    table = Array.from({ length: tied }, (_, i) =>
      row(`r${String((i * 37) % tied).padStart(3, '0')}`, 10, 5)
    );

    const page = await fetch(1000);

    const ids = page.map((m) => m.id as string);
    expect(asked.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(table.map((r) => r.id as string).sort());
  });

  it('serves a shared record with its payload, and WITHHOLDS one whose payload is gone', async () => {
    // Never an empty frame: the device would ACK it, and the record - the only evidence of the
    // loss - would go with it.
    table = [
      {
        ...row('shared', 0, 0),
        proto: undefined,
        payloadId: 'p-1',
        payload: { proto: 'U0hBUkVE' },
      },
      { ...row('orphan', 0, 1), proto: undefined, payloadId: 'p-gone', payload: null },
      row('inline', 10, 2),
    ] as Array<Partial<QueuedMessage>>;
    const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    const page = await fetch(500);

    expect(page.map((m) => [m.id, m.proto])).toEqual([
      ['shared', 'U0hBUkVE'],
      ['inline', 'x'.repeat(10)],
    ]);
    expect(errorSpy.mock.calls.map(([m]) => String(m)).join('\n')).toContain('orphan->p-gone');
    expect(queuedMessageRepo.delete).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns what the queue holds and stops, when that is less than a page', async () => {
    table = [row('a', 10, 0), row('b', 10, 1)];

    const page = await fetch(500);

    expect(page.map((m) => m.id)).toEqual(['a', 'b']);
    // The short chunk proves the end of the queue; there is no second read to make.
    expect(asked).toEqual([{ skip: 0, take: PENDING_FETCH_CHUNK_ROWS }]);
  });

  it('returns nothing, and asks once, for a device with an empty queue', async () => {
    const page = await fetch(500);

    expect(page).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});
