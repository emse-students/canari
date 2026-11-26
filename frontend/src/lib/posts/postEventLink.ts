import { Log } from '$lib/utils/Log';

/**
 * WHICH AGENDA EVENT A POST MAY LINK, AS THE COMPOSERS KNOW IT (2026-11-26).
 *
 * A post is published in its association's name, so it links an event that association ORGANISES or
 * CO-ORGANISES (an accepted co-organiser, on `coOwners`); the server refuses any other with
 * {@link POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION} (`post-event-link.ts` there). The pickers apply the
 * same rule BEFORE sending - a fact the page already holds - so the refusal is the safety net of a
 * list read before the author changed, never how the author learns the rule.
 */

/** The server's stable code: the linked event is neither organised nor co-organised by the author. */
export const POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION = 'POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION';

/** The two fields of an agenda event the rule reads. */
export interface LinkableEvent {
  id: string;
  associationId: string;
  coOwners: { associationId: string }[];
}

/** Whether `authorAssociationId` organises or co-organises `event`. */
export function eventLinkableBy(event: LinkableEvent, authorAssociationId: string): boolean {
  return (
    event.associationId === authorAssociationId ||
    event.coOwners.some((co) => co.associationId === authorAssociationId)
  );
}

/**
 * The events a picker offers `authorAssociationId`. `keepId` is the event a post already carries
 * (an editor): it stays listed so the picker never shows "no event" under a post that has one.
 */
export function linkableEventsForAuthor<E extends LinkableEvent>(
  events: readonly E[],
  authorAssociationId: string | null,
  keepId?: string | null
): E[] {
  if (!authorAssociationId) return [];
  return events.filter((ev) => ev.id === keepId || eventLinkableBy(ev, authorAssociationId));
}

/**
 * The selected event when the CURRENT author cannot link it - a list read for another author, still
 * selected after the author changed - or `null` when the selection is fine or unknown. Logged: it is
 * the visible end of a stale list.
 */
export function unlinkableSelection<E extends LinkableEvent>(
  events: readonly E[],
  selectedId: string,
  authorAssociationId: string | null
): E | null {
  if (!selectedId || !authorAssociationId) return null;
  const selected = events.find((ev) => ev.id === selectedId);
  if (!selected || eventLinkableBy(selected, authorAssociationId)) return null;
  Log.d(
    'POST_COMPOSER',
    `selected event ${selectedId} is not organised nor co-organised by ${authorAssociationId}`
  );
  return selected;
}
