## P2 - the commit-time floor is anchored on a record that can predate the admission, so it can hand out one commit, or a stretch, from before it

`GET mls/commits/:groupId/accepted-at` refuses the time of any commit older than the one that admitted
the requester (`commitFloorOf`, [chat](../frontend/modules/chat.md#a-visible-notice-is-dated-by-its-frame-never-by-when-this-device-learnt-of-it)).
The admitting commit is read as "the last commit accepted at or before the arrival", and the arrival
is a record that can be written EARLIER than the admission (review of #2890, LOW-D):

- **Group conversation**: the open stretch's `joinedAt` is written by the enrolment, before the Add
  commit that admits the person. The floor then lands on the commit BEFORE the Add, and its time is
  answered: one commit early, routinely.
- **Key-distribution group**: the device row's `createdAt`. A device kicked and re-added keeps its
  row (the kick stamps `kickedAt`, the re-add inserts `orIgnore`), so the floor stays at its FIRST
  admission, and it is answered the commit times from while it was out.

What leaks is a commit's acceptance time (ordering metadata), never content; the device lines it
dates are about devices the requester's own tree already shows.

**Why it was not fixed in #2890.** The tempting fix - "the first commit accepted at or AFTER the
arrival" - refuses the requester its OWN admitting commit wherever the arrival is written after the
commit (`dateArrivalAtAdmission` re-dates `joinedAt` from the service clock after the member's Add is
accepted), so it trades a leak for a silent undated line. The right anchor is the admission itself:
the base epoch of the commit that admitted the device, recorded when the commit gate admits it (the
gate already knows it: `admits`, the `kickedAt` clear) and kept past activation - a column, not a
clock comparison. Owed: that column, written by the gate on every admission (first and re-add), the
floor read from it, and a PostgreSQL spec with the two cases above (`commit-time.integration.spec.ts`).
