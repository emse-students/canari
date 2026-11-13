## Reading owed - an institution chooses the reach of each calendar event (owner, 2026-11-13)

target: 1.7.0

The owner's decision of 2026-11-13: an institution chooses the spaces and the public of every
calendar event it files, as it does for posts since `1.6.10`; one model, the posts' picker, refusals
and chip. Built for `1.6.12` (migration 165, not held); the mechanism, the co-organiser decision and
the proof are in [profiles-and-access](../profiles-and-access.md#an-institutions-reach-per-calendar-event-as-built-owner-2026-11-13).

### Readings owed, on a pre-release

1. **The form**: filing as an institution from the global agenda and from its own page, the picker
   shows, nothing is pre-selected, "Déposer" stays disabled until a space and a public are chosen;
   filing as an association shows no picker.
2. **A ticked-space student** sees the event in the agenda, its detail and the `.ics`; **an
   unticked-space student** of the institution's audience does not.
3. **The public**: a "Personnel" event is absent for a student; an "Étudiants" event is absent for a
   staff account that is not a member of the institution.
4. **An edit after validation**: narrowing withdraws the event from a reader at once (agenda reload),
   widening gives it back, the event stays validated, and nobody receives a notification.
5. **A co-organised event**: the partner's members still see it, and the partner side shows no picker.
6. **A post linking the event**: a reader the event's reach excludes sees the post without its event card.
7. **The chip** on the event's detail names the public and the space, on both phones.
8. **A signed campus `.ics`** (the agenda's subscribe link with a campus chosen) leaves out a
   "Étudiants" and a "Personnel" event of a space it selects.
9. **The version gate**: on an estate whose `/api/version` lacks `eventReach`, the form files an
   institution's event with no picker (read on dev before its deploy, or by a stubbed answer).

Closes when the nine are read, then this file is deleted.
