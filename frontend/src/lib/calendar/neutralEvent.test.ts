import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { SocialApiError, type AssociationCalendarFeedEvent } from '$lib/associations/api';
import { calendarErrorMessage } from './calendarErrors';
import {
  blankEventFormValues,
  eventFormValuesFrom,
  isNeutralForm,
  toCreatePayload,
  toUpdatePayload,
  type EventFormValues,
} from './eventForm';
import {
  eventAccentColor,
  eventOwners,
  eventOwnersLabel,
  eventSummary,
  NEUTRAL_EVENT_OWNER_KEY,
} from './feedEvents';

/**
 * NEUTRAL CAMPUS EVENTS ON THE CLIENT (owner, 2026-11-08): a neutral event reads "Campus" on every
 * surface that draws an event's owner, whoever reads it; the form offers the choice only where the
 * server would take it, and never sends a partner or a form link with a neutral event.
 */

/** A neutral event as a READER receives it: the server has blanked every owner field. */
function maskedNeutral(): AssociationCalendarFeedEvent {
  return {
    id: 'ev-1',
    title: 'Soiree',
    startsAt: '2026-11-20T19:00:00.000Z',
    endsAt: null,
    presentation: 'neutral',
    associationId: '',
    associationName: '',
    associationSlug: '',
    associationColor: null,
    associationLogoUrl: null,
    coOwners: [],
  } as unknown as AssociationCalendarFeedEvent;
}

/** The same event as one of its BDE's agenda managers receives it: the owner is named. */
function managerNeutral(): AssociationCalendarFeedEvent {
  return {
    ...maskedNeutral(),
    associationId: 'bde-id',
    associationName: 'BDE',
    associationSlug: 'bde',
    associationColor: '#123456',
    associationLogoUrl: '/api/media/public/bde-logo',
  };
}

describe('a neutral event on the agenda', () => {
  it('shows ONE identity, "Campus", with no page and no logo, to a reader', () => {
    const owners = eventOwners(maskedNeutral());
    expect(owners).toEqual([
      {
        associationId: NEUTRAL_EVENT_OWNER_KEY,
        name: m.calendar_neutral_label(),
        slug: '',
        color: null,
        logoUrl: null,
        neutral: true,
      },
    ]);
  });

  it('shows the same "Campus" to the BDE managers, who receive the owner', () => {
    const [owner] = eventOwners(managerNeutral());
    expect(owner.name).toBe(m.calendar_neutral_label());
    expect(owner.logoUrl).toBeNull();
    expect(JSON.stringify(eventOwners(managerNeutral()))).not.toContain('bde');
  });

  it('labels the row and the calendar entry "Campus", even on the BDE own page', () => {
    expect(eventOwnersLabel(managerNeutral(), 'bde-id')).toBe(m.calendar_neutral_label());
    expect(eventSummary(maskedNeutral())).toBe(`Soiree - ${m.calendar_neutral_label()}`);
  });

  it('wears one accent whoever reads it, never the BDE colour', () => {
    expect(eventAccentColor(managerNeutral())).toBe(eventAccentColor(maskedNeutral()));
    expect(eventAccentColor(managerNeutral())).not.toBe('#123456');
  });
});

describe('the neutral choice in the event form', () => {
  const NEUTRAL: EventFormValues = {
    ...blankEventFormValues(),
    title: 'Soiree',
    presentation: 'neutral',
    coOwnerIds: ['club-1'],
    linkedFormId: 'form-1',
    targetAssociationId: 'bde-id',
  };
  const CAN = { canSetPresentation: true, canLinkForm: true };

  it('opens on the association presentation, and an existing event keeps its own', () => {
    expect(blankEventFormValues().presentation).toBe('association');
    expect(eventFormValuesFrom(managerNeutral()).presentation).toBe('neutral');
  });

  it('sends a neutral creation with no partner and no form link', () => {
    expect(toCreatePayload(NEUTRAL, CAN)).toMatchObject({
      presentation: 'neutral',
      coOwnerIds: [],
    });
    expect(toCreatePayload(NEUTRAL, CAN)).not.toHaveProperty('linkedFormId');
  });

  it('never sends the choice from a surface that may not make it', () => {
    expect(isNeutralForm(NEUTRAL, {})).toBe(false);
    expect(toCreatePayload(NEUTRAL, {})).not.toHaveProperty('presentation');
    expect(toCreatePayload(NEUTRAL, {}).coOwnerIds).toEqual(['club-1']);
  });

  it('turning an event neutral leaves its partners and its form UNSENT, never withdrawn', () => {
    const payload = toUpdatePayload({ ...NEUTRAL, writeSide: 'organiser' }, CAN);
    expect(payload.presentation).toBe('neutral');
    expect(payload).not.toHaveProperty('coOwnerIds');
    expect(payload).not.toHaveProperty('linkedFormId');
  });

  it('is the organiser side only on an existing event', () => {
    expect(toUpdatePayload({ ...NEUTRAL, writeSide: 'partner' }, CAN)).not.toHaveProperty(
      'presentation'
    );
  });
});

describe('the refusals of a neutral event', () => {
  it.each([
    ['CALENDAR_NEUTRAL_NOT_A_BDE', m.calendar_error_neutral_not_a_bde],
    ['CALENDAR_NEUTRAL_NO_PARTNERS', m.calendar_error_neutral_no_partners],
    ['CALENDAR_NEUTRAL_NO_FORM', m.calendar_error_neutral_no_form],
    ['CALENDAR_NEUTRAL_LINKED_POST', m.calendar_error_neutral_linked_post],
  ])('reads %s as its own sentence', (code, sentence) => {
    const refusal = new SocialApiError('refused', code, 400);
    expect(calendarErrorMessage(refusal, () => 'fallback')).toBe(sentence());
  });
});
