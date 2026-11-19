import { describe, expect, it } from 'vitest';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import { eventAccentColor, eventOwners } from '$lib/calendar/feedEvents';
import { buildPreviewInnerHtml } from '$lib/utils/calendarExport';

/**
 * A BDE CHOOSES THE COLOUR OF ITS NEUTRAL EVENTS (owner, 2026-11-14): the server's
 * `neutralEventColor` is the colour every surface paints (they all read `eventOwners`), even when
 * the owner is masked; no choice keeps the derived accent.
 */
function neutral(over: Partial<AssociationCalendarFeedEvent> = {}): AssociationCalendarFeedEvent {
  return {
    id: 'e1',
    associationId: '',
    title: 'Gala',
    description: null,
    startsAt: '2026-11-20T19:00:00.000Z',
    endsAt: null,
    createdBy: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    kind: 'event',
    linkedFormId: null,
    status: 'validated',
    imageUrl: null,
    coOwners: [],
    presentation: 'neutral',
    associationName: '',
    associationSlug: '',
    associationColor: null,
    associationLogoUrl: null,
    ...over,
  } as unknown as AssociationCalendarFeedEvent;
}

describe('the colour of a neutral event', () => {
  it('is the BDE chosen colour on the grid, panel and list accent, masked owner or not', () => {
    expect(eventAccentColor(neutral({ neutralEventColor: '#336699' }))).toBe('#336699');
    expect(eventOwners(neutral({ neutralEventColor: '#336699' }))[0].color).toBe('#336699');
  });

  it('keeps the derived accent when the BDE chose nothing', () => {
    expect(eventAccentColor(neutral({ neutralEventColor: null }))).toBe(
      eventAccentColor(neutral())
    );
    expect(eventAccentColor(neutral())).not.toBe('#336699');
  });

  it('is the fill of the printed sheet too', () => {
    const html = buildPreviewInnerHtml([neutral({ neutralEventColor: '#336699' })], 2026, 10);
    expect(html).toContain('51,102,153');
  });
});
