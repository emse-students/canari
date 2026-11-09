import { ForbiddenException } from '@nestjs/common';

/**
 * WHICH SIDE OF AN EVENT A WRITE COMES FROM (owner decision E2, 2026-11-02; WP-Q1 of
 * `docs/wiki/spaces-and-audiences-reform.md`).
 *
 * An event has ONE organiser and up to three ACCEPTED partners (co-organisers, D39). A partner edits
 * the text and the poster and may withdraw; only the organiser changes the date, the audience or the
 * partner list, and only the organiser deletes. So every write on an existing event is made from one
 * of two sides, and the rule that tells them apart is written once, here.
 */
export type EventWriteSide = 'organiser' | 'partner';

/** The stable code the client maps to its own sentence (`calendarErrors.ts`). */
export const CALENDAR_PARTNER_ORGANISER_ONLY = 'CALENDAR_PARTNER_ORGANISER_ONLY';

/** What a partner asked for that only the organiser may do - named in the log, never in the reply. */
export type PartnerRefusedAction = 'date' | 'coOwnerIds' | 'delete' | 'linkedForm' | 'presentation';

/**
 * The side a caller writes from. A platform admin and a governing validator (`crossTier`) keep the
 * organiser's rights over every event they reach - E2 narrows the PARTNER, nobody above. Otherwise
 * the route decides: writing through the organiser association is the organiser side, writing
 * through any other (necessarily an accepted co-organiser, `findCalendarEventForAssociation`) is the
 * partner side.
 */
export function eventWriteSide(
  organiserId: string,
  viaAssociationId: string,
  crossTier: boolean
): EventWriteSide {
  if (crossTier) return 'organiser';
  return organiserId === viaAssociationId ? 'organiser' : 'partner';
}

const PARTNER_REFUSED_WHAT: Record<PartnerRefusedAction, string> = {
  date: 'its date',
  coOwnerIds: 'its partners',
  delete: 'it by deleting it',
  linkedForm: 'its linked form',
  presentation: 'how it is presented',
};

/** The ONE refusal of a partner doing what only the organiser may (403, typed at the throw). */
export function partnerOrganiserOnlyRefusal(action: PartnerRefusedAction): ForbiddenException {
  return new ForbiddenException({
    code: CALENDAR_PARTNER_ORGANISER_ONLY,
    message: `Only the organiser of an event may change ${PARTNER_REFUSED_WHAT[action]}.`,
  });
}
