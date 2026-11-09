import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssociationCalendarEventPresentation } from './entities/association-calendar-event.entity';

/**
 * NEUTRAL CAMPUS EVENTS (owner, 2026-11-08; docs/wiki/frontend/modules/calendar.md, "Neutral campus
 * events").
 *
 * A BDE's agenda managers may file an event that is not branded BDE: readers see the label "Campus"
 * and no association. The BDE STAYS THE OWNER - the row's `associationId` is the BDE, so the edit
 * and delete rights, the validation queue, the audience (the BDE's spaces) and every notice keep
 * working through the paths they always used. The presentation changes only what a reader is TOLD,
 * and this file is the one place that decides it:
 *
 * - **who is told the owner**: the event's STEWARDS - a platform admin, a holder of `PROPOSE_EVENT`
 *   in the owner (the people who file the BDE's events), and a holder of the BDE agenda right over
 *   it (its validators). Everybody else, anonymous `.ics` readers included, reads a row whose owner
 *   fields are blank and whose creator, validator and rejecter are gone.
 * - **where a neutral event is not listed at all**: on the owner's OWN agenda (its page, or the global
 *   agenda filtered on it) for a non-steward - a list "the BDE's events" that contains it would name
 *   the owner as surely as a field.
 * - **what a neutral event may not carry**: co-organisers (each is a named association on the event),
 *   a linked form (the form page names its association; migration 144's CHECK holds this one too)
 *   and a post linking it (the post is the BDE's).
 */

/** The label a server-built text gives a neutral event: the `.ics` SUMMARY suffix. */
export const NEUTRAL_EVENT_LABEL = 'Campus';

/** The stable codes the client maps to its own sentence (`calendarErrors.ts`). */
export const CALENDAR_NEUTRAL_ERROR_CODES = {
  /** Only a BDE files a neutral event. */
  NOT_A_BDE: 'CALENDAR_NEUTRAL_NOT_A_BDE',
  /** A neutral event has no co-organiser. */
  NO_PARTNERS: 'CALENDAR_NEUTRAL_NO_PARTNERS',
  /** A neutral event links no registration form. */
  NO_FORM: 'CALENDAR_NEUTRAL_NO_FORM',
  /** A post links this event, so it cannot turn neutral (and a post cannot link a neutral one). */
  LINKED_POST: 'CALENDAR_NEUTRAL_LINKED_POST',
} as const;

/** Whether a row is presented as "Campus" rather than as its owner. */
export function isNeutralEvent(row: { presentation?: string | null }): boolean {
  return row.presentation === AssociationCalendarEventPresentation.Neutral;
}

/** What a write would make of the event, read before anything is saved. */
export interface NeutralPresentationRequest {
  presentation: AssociationCalendarEventPresentation;
  /** The OWNER is the BDE of at least one space (`Association.isBDE`). */
  ownerIsBde: boolean;
  /** Co-organisers asked or accepted, the owner excluded. */
  partnerCount: number;
  linkedFormId: string | null;
  /** A post already links this event (`posts.linkedCalendarEventId`); `false` for a new one. */
  linkedByPost: boolean;
}

/**
 * Refuses a neutral event the rules above exclude, typed at the throw. An `association` event
 * passes untouched, so every existing write path keeps its behaviour.
 */
export function assertNeutralPresentationAllowed(req: NeutralPresentationRequest): void {
  if (req.presentation !== AssociationCalendarEventPresentation.Neutral) return;
  if (!req.ownerIsBde) {
    throw new ForbiddenException({
      code: CALENDAR_NEUTRAL_ERROR_CODES.NOT_A_BDE,
      message: 'Only a BDE may file a neutral campus event',
    });
  }
  if (req.partnerCount > 0) {
    throw new BadRequestException({
      code: CALENDAR_NEUTRAL_ERROR_CODES.NO_PARTNERS,
      message: 'A neutral campus event has no co-organiser',
    });
  }
  if (req.linkedFormId) {
    throw new BadRequestException({
      code: CALENDAR_NEUTRAL_ERROR_CODES.NO_FORM,
      message: 'A neutral campus event links no form',
    });
  }
  if (req.linkedByPost) {
    throw new BadRequestException({
      code: CALENDAR_NEUTRAL_ERROR_CODES.LINKED_POST,
      message: 'A post links this event, so it cannot be neutral',
    });
  }
}

/** Which owners' events a reader may see unmasked. */
export interface EventStewardship {
  mayManage(associationId: string): boolean;
}

/** A reader who stewards nothing: an anonymous `.ics` read, or a student. */
export const NO_EVENT_STEWARDSHIP: EventStewardship = { mayManage: () => false };

/** A platform admin. */
export const EVERY_EVENT_STEWARDSHIP: EventStewardship = { mayManage: () => true };

/** The stewardship of a reader who manages the agenda of `associationIds`. */
export function eventStewardshipOf(associationIds: Iterable<string>): EventStewardship {
  const ids = new Set(associationIds);
  return { mayManage: (associationId) => ids.has(associationId) };
}

/** The fields of an agenda row that name its owner or a person; every listing shape carries a subset. */
export interface PresentableEventRow {
  associationId: string;
  presentation?: string | null;
  createdBy: string;
  validatedBy: string | null;
  rejectedBy: string | null;
  coOwners: unknown[];
  associationName?: string;
  associationSlug?: string;
  associationColor?: string | null;
  associationLogoUrl?: string | null;
}

/**
 * A neutral row as a non-steward reads it: no owner, no person. `associationId` is `''` rather than
 * absent so the row keeps its shape (the client keys and filters on the field); the client draws
 * "Campus" from `presentation`, never from these blanks.
 */
function maskNeutralEvent<T extends PresentableEventRow>(row: T): T {
  return {
    ...row,
    associationId: '',
    createdBy: '',
    validatedBy: null,
    rejectedBy: null,
    coOwners: [],
    ...('associationName' in row
      ? {
          associationName: '',
          associationSlug: '',
          associationColor: null,
          associationLogoUrl: null,
        }
      : {}),
  };
}

/**
 * The rows `stewardship` may read, masked where it may not see the owner. `listedFor` is the
 * association whose OWN agenda this list is (`null` for the whole agenda): a neutral event of that
 * association is dropped for a non-steward, since the list itself would name its owner.
 */
export function presentEventsForReader<T extends PresentableEventRow>(
  rows: T[],
  stewardship: EventStewardship,
  opts: { listedFor: string | null }
): T[] {
  const out: T[] = [];
  for (const row of rows) {
    if (!isNeutralEvent(row) || stewardship.mayManage(row.associationId)) {
      out.push(row);
      continue;
    }
    if (opts.listedFor !== null && row.associationId === opts.listedFor) continue;
    out.push(maskNeutralEvent(row));
  }
  return out;
}
