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

  const queryBuilder = () => {
    const state = { skip: 0, take: 0 };
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      skip: (n: number) => {
        state.skip = n;
        return qb;
      },
      take: (n: number) => {
        state.take = n;
        return qb;
      },
      getMany: async () => {
        asked.push({ ...state });
        return table.slice(state.skip, state.skip + state.take);
      },
    };
    return qb;
  };

  const queuedMessageRepo = {
    createQueryBuilder: jest.fn(() => queryBuilder()),
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
