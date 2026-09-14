import { AssociationsService } from './associations.service';
import { AssociationCalendarEventStatus } from './entities/association-calendar-event.entity';

/**
 * `listCalendarEvents` returns the events an association OWNS **and** the ones it merely co-owns,
 * so the owner identity has to travel with each row.
 *
 * Until 2026-09-14 it did not, and the single caller stamped the page's own association onto every
 * event. On the co-owner's page that named the same association twice on one event - once as owner,
 * once as co-owner - and the calendar grid, keyed on that identity, threw `each_key_duplicate` and
 * crashed the whole page in production (`https://canari-emse.fr/associations/mitv`). These tests
 * pin the four fields, and pin that a co-owned event reports its REAL owner.
 */
const PAGE_ASSO = '11111111-1111-4111-8111-111111111111';
const OTHER_ASSO = '22222222-2222-4222-8222-222222222222';

function makeQueryBuilder(rows: unknown[]) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['innerJoin', 'where', 'andWhere', 'orderBy', 'select', 'addSelect']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn(() => Promise.resolve(rows));
  return qb;
}

function makeService(rows: unknown[]) {
  const qb = makeQueryBuilder(rows);
  const assoRepo = {
    findOne: jest.fn(() => Promise.resolve({ id: PAGE_ASSO, parentAssociationId: null })),
    find: jest.fn(() =>
      Promise.resolve([
        { id: PAGE_ASSO, name: 'MiTV', slug: 'mitv', color: '#111111', logoUrl: '/logo/mitv' },
        { id: OTHER_ASSO, name: 'Corpo', slug: 'corpo', color: null, logoUrl: null },
      ])
    ),
  };
  const coOwnerRepo = {
    find: jest.fn(() =>
      Promise.resolve([
        {
          eventId: 'ev-co-owned',
          associationId: PAGE_ASSO,
          association: { name: 'MiTV', slug: 'mitv', color: '#111111', logoUrl: '/logo/mitv' },
        },
      ])
    ),
  };
  // POSITIONAL, AND THIRTEEN LONG - keep these comments aligned with the constructor's parameter
  // list in `associations.service.ts`, and change them in the same commit that changes it.
  const service = new AssociationsService(
    assoRepo as never, // assoRepo
    { count: jest.fn(() => Promise.resolve(0)) } as never, // memberRepo
    { createQueryBuilder: jest.fn(() => qb) } as never, // calendarRepo
    coOwnerRepo as never, // coOwnerRepo
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
  return { service, assoRepo };
}

function eventRow(id: string, associationId: string) {
  return {
    id,
    associationId,
    title: 'CorpoPerm',
    description: null,
    startsAt: new Date('2026-09-15T20:00:00Z'),
    endsAt: null,
    createdBy: 'someone',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    status: AssociationCalendarEventStatus.Validated,
  };
}

describe('AssociationsService.listCalendarEvents owner identity', () => {
  it('reports the REAL owner of an event the association only co-owns', async () => {
    const { service } = makeService([eventRow('ev-co-owned', OTHER_ASSO)]);

    const [ev] = (await service.listCalendarEvents(PAGE_ASSO)) as unknown as {
      associationId: string;
      associationName: string;
      associationSlug: string;
      associationColor: string | null;
      associationLogoUrl: string | null;
      coOwners: { associationId: string }[];
    }[];

    expect(ev.associationId).toBe(OTHER_ASSO);
    expect(ev.associationName).toBe('Corpo');
    expect(ev.associationSlug).toBe('corpo');
    expect(ev.associationColor).toBeNull();
    expect(ev.associationLogoUrl).toBeNull();
    // The caller appears exactly once, and in the co-owner slot only: owner + co-owners is the
    // list the calendar grid keys on, so a repeat there is a crash rather than a cosmetic slip.
    expect(ev.coOwners.map((c) => c.associationId)).toEqual([PAGE_ASSO]);
    expect(ev.coOwners.map((c) => c.associationId)).not.toContain(ev.associationId);
  });

  it('carries the association own identity for an event it owns', async () => {
    const { service } = makeService([eventRow('ev-own', PAGE_ASSO)]);

    const [ev] = (await service.listCalendarEvents(PAGE_ASSO)) as unknown as {
      associationName: string;
      associationSlug: string;
      associationLogoUrl: string | null;
    }[];

    expect(ev.associationName).toBe('MiTV');
    expect(ev.associationSlug).toBe('mitv');
    expect(ev.associationLogoUrl).toBe('/logo/mitv');
  });

  it('asks for no owner at all when the window holds no event', async () => {
    const { service, assoRepo } = makeService([]);

    expect(await service.listCalendarEvents(PAGE_ASSO)).toEqual([]);
    // `findById` is the only lookup an empty window may cost.
    expect(assoRepo.find).not.toHaveBeenCalled();
  });
});
