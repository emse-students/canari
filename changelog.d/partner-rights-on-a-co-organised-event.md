### Changed - a co-organiser edits an event's text and poster and may withdraw; the date, the partners and the delete are the organiser's

Until now an accepted partner could change the date and delete another campus's event. It is now refused with one typed 403, `CALENDAR_PARTNER_ORGANISER_ONLY`, and the event form hides the date and the partner list from a partner and offers "withdraw" instead ([profiles-and-access](docs/wiki/profiles-and-access.md#e2-partner-rights-on-a-co-organised-event-wp-q1-2026-11-03)).

A partner no longer owns the form link either, an edit, a validation and a rejection of one event are now serialised by one row lock, and withdrawing asks for confirmation ([profiles-and-access](docs/wiki/profiles-and-access.md#e2-partner-rights-on-a-co-organised-event-wp-q1-2026-11-03)).
