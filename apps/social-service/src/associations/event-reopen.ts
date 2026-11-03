/**
 * WHY A VALIDATED EVENT WENT BACK TO THE QUEUE - a typed cause, carried from the write that did it
 * (F7 of `docs/wiki/spaces-and-audiences-reform.md`), never a sentence parsed afterwards.
 *
 * Two writes return a validated event to `pending` today:
 * - `date_moved`: an edit that really moved `startsAt` or `endsAt` (`updateCalendarEvent`);
 * - `coorganiser_joined`: a partner association ACCEPTED to co-organise it
 *   (`CoorganisationService.apply`, WP-Q2) - its audience was added with no validation behind it.
 *
 * WP-E later cuts the queue per space governor and replaces both with a per-slice reopening; the
 * cause stays, and so does the rule that whoever the event concerns is told WHY.
 */
export type EventReopenReason = 'date_moved' | 'coorganiser_joined';

/**
 * The bell and push type each cause is announced under. The type IS the sentence's key on every
 * surface (the bell row, the three native tables), so each cause owns one.
 */
export const EVENT_REOPEN_NOTIFICATION_TYPE: Record<EventReopenReason, string> = {
  date_moved: 'event_pending',
  coorganiser_joined: 'event_pending_coorganiser',
};

/** The columns the announcement needs of the event, read AFTER the write has committed. */
export interface ReopenedEvent {
  id: string;
  associationId: string;
  title: string;
}
