import { AssociationsService } from './associations.service';
import { AssociationCalendarEventStatus } from './entities/association-calendar-event.entity';

/**
 * `findCalendarEventByLinkedPost` NOW ANSWERS WITH THE SAME SHAPE `listCalendarEvents` DOES.
 *
 * The caller opens the calendar's own `CalendarEventDetailModal` with whatever this returns, and
 * that modal renders `associationName`/`associationSlug`/`associationColor`/`associationLogoUrl`
 * - fields the bare `serializeCalendarEvent(ev)` this method used to return does not carry. A
 * post's "see the event" link would have opened a modal missing the very identity it shows,
 * rather than the calendar's own `AssociationCalendarFeedEvent` shape.
 */
describe('AssociationsService.findCalendarEventByLinkedPost feed shape', () => {
  const EVENT = {
    id: 'ev-1',
    associationId: 'asso-1',
    title: 'Soiree de rentree',
    description: null,
    startsAt: new Date('2026-09-20T18:00:00Z'),
    endsAt: null,
    createdBy: 'officer-1',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    status: AssociationCalendarEventStatus.Validated,
    validatedAt: null,
    validatedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    imageUrl: null,
  };

  function makeService(post: Record<string, unknown> | null) {
    const postRepo = { findOne: jest.fn(async () => post) };
    const calendarRepo = { findOne: jest.fn(async () => EVENT) };
    const assoRepo = {
      find: jest.fn(async () => [
        { id: 'asso-1', name: 'BDE', slug: 'bde', color: '#f5a623', logoUrl: null },
      ]),
    };
    const coOwnerRepo = { find: jest.fn(async () => []) };

    // POSITIONAL, THIRTEEN LONG - see associations.service.never-auto-validates.spec.ts.
    const service = new AssociationsService(
      assoRepo as never,
      undefined as never, // memberRepo
      calendarRepo as never,
      coOwnerRepo as never,
      undefined as never, // docRepo
      undefined as never, // reviewerGrantRepo
      postRepo as never,
      undefined as never, // formRepo
      undefined as never, // productRepo
      undefined as never, // redis
      undefined as never, // httpService
      undefined as never, // notifications
      undefined as never // userTagService
    );
    return service;
  }

  it('returns null when the post has no linked event', async () => {
    const service = makeService({ id: 'p1', linkedCalendarEventId: null });
    await expect(service.findCalendarEventByLinkedPost('p1')).resolves.toBeNull();
  });

  it('attaches the association identity the calendar detail modal renders', async () => {
    const service = makeService({ id: 'p1', linkedCalendarEventId: 'ev-1' });

    const result = await service.findCalendarEventByLinkedPost('p1');

    expect(result).toMatchObject({
      id: 'ev-1',
      associationName: 'BDE',
      associationSlug: 'bde',
      associationColor: '#f5a623',
      associationLogoUrl: null,
      coOwners: [],
    });
  });
});
