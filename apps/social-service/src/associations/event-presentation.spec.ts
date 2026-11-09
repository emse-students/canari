import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { buildAggregatedCalendarIcs } from './calendar-ics.util';
import { AssociationCalendarEventPresentation } from './entities/association-calendar-event.entity';
import {
  assertNeutralPresentationAllowed,
  CALENDAR_NEUTRAL_ERROR_CODES,
  EVERY_EVENT_STEWARDSHIP,
  eventStewardshipOf,
  NO_EVENT_STEWARDSHIP,
  presentEventsForReader,
} from './event-presentation';

/**
 * NEUTRAL CAMPUS EVENTS (owner, 2026-11-08): the BDE stays the owner, and no field a non-steward
 * reads names it. These are the rules in isolation; the service paths that call them are pinned in
 * `associations.service.neutral-event.spec.ts`.
 */

const BDE = '00000000-0000-4000-8000-0000000000b1';
const CLUB = '00000000-0000-4000-8000-0000000000c1';

const NEUTRAL = AssociationCalendarEventPresentation.Neutral;
const ASSOCIATION = AssociationCalendarEventPresentation.Association;

function row(id: string, associationId: string, presentation: string) {
  return {
    id,
    associationId,
    presentation,
    createdBy: 'bde-secretary',
    validatedBy: 'bde-validator',
    rejectedBy: null,
    coOwners: [] as unknown[],
    associationName: 'BDE',
    associationSlug: 'bde',
    associationColor: '#123456',
    associationLogoUrl: '/api/media/public/bde-logo',
  };
}

const OK = {
  presentation: NEUTRAL,
  ownerIsBde: true,
  partnerCount: 0,
  linkedFormId: null,
  linkedByPost: false,
};

describe('assertNeutralPresentationAllowed', () => {
  it('lets every association event through untouched, whatever it carries', () => {
    expect(() =>
      assertNeutralPresentationAllowed({
        presentation: ASSOCIATION,
        ownerIsBde: false,
        partnerCount: 3,
        linkedFormId: 'form-1',
        linkedByPost: true,
      })
    ).not.toThrow();
  });

  it('accepts a neutral event of a BDE with nothing naming it', () => {
    expect(() => assertNeutralPresentationAllowed(OK)).not.toThrow();
  });

  it('refuses a neutral event whose owner is not a BDE, as a typed 403', () => {
    const attempt = () => assertNeutralPresentationAllowed({ ...OK, ownerIsBde: false });
    expect(attempt).toThrow(ForbiddenException);
    expect(attempt).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: CALENDAR_NEUTRAL_ERROR_CODES.NOT_A_BDE }),
      })
    );
  });

  it.each([
    ['a co-organiser', { partnerCount: 1 }, CALENDAR_NEUTRAL_ERROR_CODES.NO_PARTNERS],
    ['a linked form', { linkedFormId: 'form-1' }, CALENDAR_NEUTRAL_ERROR_CODES.NO_FORM],
    ['a post linking it', { linkedByPost: true }, CALENDAR_NEUTRAL_ERROR_CODES.LINKED_POST],
  ])('refuses a neutral event with %s, as a typed 400', (_what, change, code) => {
    const attempt = () => assertNeutralPresentationAllowed({ ...OK, ...change });
    expect(attempt).toThrow(BadRequestException);
    expect(attempt).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code }) })
    );
  });
});

describe('presentEventsForReader', () => {
  it('masks every owner field and every person of a neutral event for a non-steward', () => {
    const [ev] = presentEventsForReader([row('ev-1', BDE, NEUTRAL)], NO_EVENT_STEWARDSHIP, {
      listedFor: null,
    });
    expect(ev).toMatchObject({
      id: 'ev-1',
      presentation: NEUTRAL,
      associationId: '',
      associationName: '',
      associationSlug: '',
      associationColor: null,
      associationLogoUrl: null,
      createdBy: '',
      validatedBy: null,
      rejectedBy: null,
      coOwners: [],
    });
    // Nothing anywhere in the row names the BDE.
    expect(JSON.stringify(ev)).not.toContain(BDE);
    expect(JSON.stringify(ev)).not.toContain('bde');
  });

  it('leaves a neutral event whole for a steward of its owner, and for a platform admin', () => {
    const rows = [row('ev-1', BDE, NEUTRAL)];
    for (const stewardship of [eventStewardshipOf([BDE]), EVERY_EVENT_STEWARDSHIP]) {
      const [ev] = presentEventsForReader(rows, stewardship, { listedFor: null });
      expect(ev.associationId).toBe(BDE);
      expect(ev.createdBy).toBe('bde-secretary');
    }
  });

  it('masks it for a steward of ANOTHER association', () => {
    const [ev] = presentEventsForReader([row('ev-1', BDE, NEUTRAL)], eventStewardshipOf([CLUB]), {
      listedFor: null,
    });
    expect(ev.associationId).toBe('');
  });

  it('drops it from its owner own agenda for a non-steward, where the list itself names the owner', () => {
    const rows = [row('ev-1', BDE, NEUTRAL), row('ev-2', BDE, ASSOCIATION)];
    const listed = presentEventsForReader(rows, NO_EVENT_STEWARDSHIP, { listedFor: BDE });
    expect(listed.map((e) => e.id)).toEqual(['ev-2']);
  });

  it('never touches an association event', () => {
    const rows = [row('ev-2', CLUB, ASSOCIATION)];
    expect(presentEventsForReader(rows, NO_EVENT_STEWARDSHIP, { listedFor: CLUB })).toEqual(rows);
  });
});

describe('buildAggregatedCalendarIcs - a neutral event', () => {
  it('is named "Campus" and links the agenda, never an association page', () => {
    const ics = buildAggregatedCalendarIcs(
      [
        {
          id: 'ev-1',
          title: 'Soiree',
          description: null,
          startsAt: '2026-11-20T19:00:00.000Z',
          endsAt: null,
          associationName: '',
          associationSlug: '',
          presentation: NEUTRAL,
        },
      ],
      { frontendBaseUrl: 'https://example.test' }
    );
    expect(ics).toContain('SUMMARY:Soiree - Campus');
    expect(ics).toContain('URL:https://example.test/calendar');
    expect(ics).not.toContain('/associations/');
  });
});
