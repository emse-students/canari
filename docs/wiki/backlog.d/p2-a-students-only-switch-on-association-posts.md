## P2 - a "students only" switch on association and list posts (decided by the owner on 2026-11-04, not built)

The owner wants one community life for everyone AND a barrier that keeps student-only content
(jokes, student lore) away from staff and named readers, while staying as simple as possible to use.
An audience chosen per post was weighed and turned down as too heavy; the association's audience,
set once by its BDE or the administration, stays the base ([profiles-and-access](../profiles-and-access.md)).

The decisions (owner, 2026-11-04):

1. **One switch when publishing, "Entre étudiants"**, offered to associations and lists - not to
   institutions. **Default OFF** (the post is open), for every author; no per-association default.
2. **The rule is on WHO READS, never on how the post travels.** Republication by another entity,
   member reposts and pins stay allowed; wherever the post arrives, only students see it, plus the
   members of the publishing association.
3. **A student is an account with a cursus**: a campus and a formation from the identity provider,
   so a space. Staff without a cursus and named readers (read grants) never see such a post,
   whatever the path - feed, search, the post by id, its comments, reactions and votes, the agenda,
   notifications.
4. **It complements, and does not replace, the comments hidden from named readers** (decided the
   same day): on an ordinary post a named reader sees the post but not the discussion unless their
   switch in the read-access grid is on; on a "students only" post they see nothing.

**The owner's requirement on the result: clear, clean, and as user-friendly as possible.** One
switch with a plain label and a one-line explanation of who will and will not see the post, a chip
on the card that says the same thing to every reader, and no new screen; the named-reader comment
switch reads the same way in the admin grid.

To settle when it is built: whether the author may change the switch after publishing (narrowing
at once), the event of such a post in the agenda and its public calendar link, the chip shown on the
card, and its place in `postVisibleToUserSql` (ONE predicate every read path already goes through).
Built after the named-reader comments change, which edits the same predicate.
