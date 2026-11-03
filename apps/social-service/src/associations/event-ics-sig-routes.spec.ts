import { AssociationsController } from './associations.controller';
import type { AssociationsService } from './associations.service';
import { signEventIcs } from './agenda-signature';
import { FormsController } from '../forms/forms.controller';
import { PostsController } from '../posts/posts.controller';

/**
 * EVERY ROUTE THAT SERVES A VALIDATED EVENT SERVES ITS `icsSig` (2026-11-02): the client builds the
 * "add to my calendar" link from it and builds none without it, so a route that forgets the wrap
 * silently loses the link for every event it opens. One case per route that answers events -
 * the aggregated feed, one association's events, a post's linked event and a form's - each with the
 * service mocked, so removing `withEventIcsSig` / `withOneEventIcsSig` from any of them fails here.
 */
describe('the routes that serve an event serve its .ics signature', () => {
  const KEY = 'agenda-test-key-0123456789abcdef0123456789';
  const previousKey = process.env.AGENDA_SIGNING_KEY;
  beforeAll(() => {
    process.env.AGENDA_SIGNING_KEY = KEY;
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.AGENDA_SIGNING_KEY;
    else process.env.AGENDA_SIGNING_KEY = previousKey;
  });

  const POST = '00000000-0000-4000-8000-000000000001';
  const FORM = '00000000-0000-4000-8000-000000000002';
  const validated = { id: 'ev-validated', status: 'validated', title: 'Soiree' };
  const pending = { id: 'ev-pending', status: 'pending', title: 'Projet' };

  function associationsController(service: Record<string, jest.Mock>) {
    return new AssociationsController(
      service as unknown as AssociationsService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
  }

  it('GET /calendar/feed', async () => {
    const controller = associationsController({
      listAggregatedCalendarFeed: jest.fn(() => Promise.resolve([validated, pending])),
    });
    const rows = (await controller.aggregatedCalendarFeed(
      undefined,
      undefined,
      undefined,
      undefined,
      'reader'
    )) as Array<{ id: string; icsSig?: string }>;
    expect(rows[0].icsSig).toBe(signEventIcs('ev-validated'));
    expect(rows[1].icsSig).toBeUndefined();
  });

  it('GET /associations/:id/events', async () => {
    const controller = associationsController({
      listCalendarEvents: jest.fn(() => Promise.resolve([validated, pending])),
    });
    const rows = (await controller.listCalendarEvents(
      'asso',
      undefined,
      undefined,
      undefined,
      undefined,
      'reader'
    )) as Array<{ id: string; icsSig?: string }>;
    expect(rows[0].icsSig).toBe(signEventIcs('ev-validated'));
    expect(rows[1].icsSig).toBeUndefined();
  });

  it('GET /posts/:postId/calendar-link', async () => {
    const controller = new PostsController(
      { assertVisible: jest.fn(() => Promise.resolve()) } as never,
      {} as never,
      {} as never,
      { findCalendarEventByLinkedPost: jest.fn(() => Promise.resolve(validated)) } as never,
      {} as never
    );
    const { linkedEvent } = await controller.getPostCalendarLink(POST, 'reader');
    expect(linkedEvent?.icsSig).toBe(signEventIcs('ev-validated'));
  });

  it('GET /forms/:id/calendar-link, for a reader the event reaches', async () => {
    const findCalendarEventByLinkedForm = jest.fn(() => Promise.resolve(validated));
    const controller = new FormsController(
      {} as never,
      { findCalendarEventByLinkedForm } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const { linkedEvent } = await controller.getFormCalendarLink(FORM, 'reader');
    expect(linkedEvent?.icsSig).toBe(signEventIcs('ev-validated'));
    // The audience is the service's to apply, so the controller hands it the reader.
    expect(findCalendarEventByLinkedForm).toHaveBeenCalledWith(FORM, {
      userId: 'reader',
      isGlobalAdmin: false,
    });
  });

  it('GET /forms/:id/calendar-link answers null for a reader outside the audience', async () => {
    const controller = new FormsController(
      {} as never,
      { findCalendarEventByLinkedForm: jest.fn(() => Promise.resolve(null)) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(controller.getFormCalendarLink(FORM, 'outsider')).resolves.toEqual({
      linkedEvent: null,
    });
  });
});
