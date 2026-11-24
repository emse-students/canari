## An institution's "Personnel" calendar event reaches the staff of its ticked campuses (owner, 2026-11-19)

target: 1.9.0

**Decided by the owner on 2026-11-19** ([decisions](../decisions/owner-decisions-of-2026-11-19.md)): the door built on
2026-11-14 for an institution's POSTS ("Oui, par campus") opens on its CALENDAR EVENTS too. An event
whose public is "Personnel" or "Tous" reaches every staff account (a campus, no cursus) whose campus
is the campus of a space the event TICKS. The per-event choice of spaces stays as built
([as built](../profiles-and-access.md#an-institutions-reach-per-calendar-event-as-built-owner-2026-11-13)),
so an event for Saint-Etienne only reaches Saint-Etienne's staff only: *"on doit pouvoir choisir
l'audience comme les posts"*.

**Owed:** the same disjunct as `institutionReachStaffCampusDoorSql` added to `eventVisibleToUserSql`
(one shared SQL fragment, not a copy); its integration spec (a staff account of a ticked campus sees it,
one of another campus does not, a student outside the spaces does not); the agenda feed and its
subscription link re-read against it; the wiki's as-built section updated.

**Not part of it:** the institution as a whole (shop, partnerships, directory, lives) stays as
[open-questions](../open-questions.md) records.
