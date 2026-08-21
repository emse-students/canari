import { BadRequestException } from '@nestjs/common';
import { AssociationsService } from './associations.service';

/**
 * Focused unit tests for `listAggregatedCalendarFeed`'s `from`/`to` handling. Only `calendarRepo`
 * is exercised (via a chainable query-builder stub); every other constructor dependency is
 * unused for this path since no `associationId` filter is passed (which would call `findById`)
 * and the stub always returns zero rows (so `batchLoadCoOwners([])` short-circuits without
 * touching `coOwnerRepo`).
 */
function makeQueryBuilder() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['innerJoin', 'where', 'andWhere', 'orderBy', 'select', 'addSelect']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn(() => Promise.resolve([]));
  return qb;
}

function makeService() {
  const qb = makeQueryBuilder();
  const calendarRepo = { createQueryBuilder: jest.fn(() => qb) };
  const service = new AssociationsService(
    undefined as never, // assoRepo
    undefined as never, // memberRepo
    calendarRepo as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // notifRepo
    undefined as never, // productRepo
    undefined as never, // redis
    undefined as never, // httpService
    undefined as never, // push
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
});
