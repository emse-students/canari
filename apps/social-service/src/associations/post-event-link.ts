/**
 * THE RULE FOR WHICH AGENDA EVENT A POST MAY LINK (2026-11-26), and its stable refusal code.
 *
 * A post is published in its association's name, so the event it announces must be that
 * association's to announce: the event it ORGANISES, or one it CO-ORGANISES (an accepted row of
 * `association_calendar_event_co_owners`, which exists only once the association's publishers
 * consented - `AssociationCalendarEventCoOwner`). An event of an association that is neither is
 * refused with {@link POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION}, which the composer words from the
 * code (`publishFailure.ts`); a personal post links no event at all.
 *
 * The composer's picker is built from the same two relations (`linkableEventsForAuthor` on the
 * client), so reaching this refusal means a list read before a change of author.
 */
export const POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION = 'POST_EVENT_NOT_OF_AUTHOR_ASSOCIATION';
