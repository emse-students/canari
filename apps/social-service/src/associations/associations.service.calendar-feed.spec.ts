import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssociationsService } from './associations.service';

/**
 * Focused unit tests for `listAggregatedCalendarFeed`'s `from`/`to` handling, plus the
 * malformed-`associationId` guard in `findById` that this feed's `associationId` filter goes
 * through. Only `calendarRepo` is exercised (via a chainable query-builder stub); every other
 * constructor dependency is unused for the `from`/`to` cases since no `associationId` filter is
 * passed there and the stub always returns zero rows (so `batchLoadCoOwners([])` short-circuits
 * without touching `coOwnerRepo`). The malformed-id case never reaches `assoRepo` either - the
 * guard rejects it before any repository call.
 */
function makeQueryBuilder() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['innerJoin', 'where', 'andWhere', 'orderBy', 'select', 'addSelect']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn(() => Promise.resolve([]));
  return qb;
}

function makeService(promoRows: unknown[] = []) {
  const qb = makeQueryBuilder();
  // `manager` is only reached when a viewer is passed - every other case short-circuits in
  // `promoCutoffFor` before it is touched, which is why the older cases below need no rows.
  const manager = { query: jest.fn(() => Promise.resolve(promoRows)) };
  const calendarRepo = { createQueryBuilder: jest.fn(() => qb), manager };
  // POSITIONAL, AND THIRTEEN LONG - so a constructor change silently shifts every argument after
  // the one it touched. The comments are the guard: keep them aligned with the parameter list in
  // `associations.service.ts`, and change them in the same commit that changes it.
  const service = new AssociationsService(
    undefined as never, // assoRepo
    undefined as never, // memberRepo
    calendarRepo as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never // userTagService
  );
  return { service, qb };
}

describe('AssociationsService.listAggregatedCalendarFeed', () => {
  it('defaults the window instead of throwing when from/to are omitted (subscribe-by-URL feeds carry none)', async () => {
    const { service, qb } = makeService();
    const result = await service.listAggregatedCalendarFeed();
    expect(result).toEqual([]);

    const [, params] = qb.where.mock.calls[0] as [string, { from: Date; to: Date }];
    expect(params.from).toBeInstanceOf(Date);
    expect(params.to).toBeInstanceOf(Date);
    expect(params.from.getTime()).toBeLessThan(params.to.getTime());
    // The defaulted window must actually straddle "now" - checked relatively, never against a
    // hardcoded wall-clock value.
    const now = Date.now();
    expect(params.from.getTime()).toBeLessThan(now);
    expect(params.to.getTime()).toBeGreaterThan(now);
  });

  it('still honors an explicit from/to when both are given', async () => {
    const { service, qb } = makeService();
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-02-01T00:00:00.000Z';
    await service.listAggregatedCalendarFeed(from, to);

    const [, params] = qb.where.mock.calls[0] as [string, { from: Date; to: Date }];
    expect(params.from.toISOString()).toBe(from);
    expect(params.to.toISOString()).toBe(to);
  });

  it('defaults only the side that is missing when the other is explicit', async () => {
    const { service, qb } = makeService();
    // 60 days ahead of "now" - close enough to stay within CALENDAR_FEED_MAX_MS of the
    // defaulted `from` (~3 months back), far enough to unambiguously sit in the future.
    const to = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    await service.listAggregatedCalendarFeed(undefined, to);

    const [, params] = qb.where.mock.calls[0] as [string, { from: Date; to: Date }];
    expect(params.to.toISOString()).toBe(to);
    expect(params.from.getTime()).toBeLessThan(Date.now());
  });

  it('still rejects an unparsable explicit from', async () => {
    const { service } = makeService();
    await expect(
      service.listAggregatedCalendarFeed('not-a-date', '2026-02-01T00:00:00.000Z')
    ).rejects.toThrow(BadRequestException);
  });

  it('still rejects from after to', async () => {
    const { service } = makeService();
    await expect(
      service.listAggregatedCalendarFeed('2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    ).rejects.toThrow(BadRequestException);
  });

  it('cuts a signed-in reader at their own promo, as a clause of its own', async () => {
    const { service, qb } = makeService([{ promo: 2025 }]);
    await service.listAggregatedCalendarFeed(undefined, undefined, undefined, {
      viewer: { userId: 'u1' },
    });

    const clause = qb.andWhere.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('promoCutoff')
    ) as [string, { promoCutoff: string }] | undefined;
    expect(clause).toBeDefined();
    // `startsAt`, not `createdAt`: what a reader means by "how far back does the agenda go" is the
    // date of the event, never the day somebody typed it in.
    expect(clause?.[0]).toContain('e.startsAt >=');
    expect(clause?.[1].promoCutoff).toBe('2025-08-01');
  });

  it('adds no such clause for an anonymous reader - the route is public and carries no identity', async () => {
    const { service, qb } = makeService([{ promo: 2025 }]);
    await service.listAggregatedCalendarFeed();
    const clause = qb.andWhere.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('promoCutoff')
    );
    expect(clause).toBeUndefined();
  });

  it('adds no such clause for a global admin, who is shown the whole archive on purpose', async () => {
    const { service, qb } = makeService([{ promo: 2025 }]);
    await service.listAggregatedCalendarFeed(undefined, undefined, undefined, {
      viewer: { userId: 'u1', isGlobalAdmin: true },
    });
    const clause = qb.andWhere.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('promoCutoff')
    );
    expect(clause).toBeUndefined();
  });

  it('reports a malformed associationId as not-found instead of a raw database error', async () => {
    const { service } = makeService();
    // Not a UUID - previously reached `assoRepo.findOne` and surfaced Postgres's
    // "invalid input syntax for type uuid" as an uncaught 500 (confirmed live on prod).
    await expect(
      service.listAggregatedCalendarFeed(undefined, undefined, 'does-not-exist')
    ).rejects.toThrow(NotFoundException);
  });
});
