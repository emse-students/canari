## P2 - a "students only" switch on association and list posts (decided by the owner on 2026-11-04, built the same day, readings owed)

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

Settled by the owner later the same day:

5. **The author may change the switch after publishing, both ways.** Closing withdraws the post from
   outside readers at once; reopening gives it back.
6. **The post and its event are independent.** The switch governs the post alone; an event announced
   by such a post keeps its own visibility, set on the event, in the agenda and the public calendar.
7. **Associations and lists only** - not institutions, not personal posts.
8. **A republished "students only" post keeps its chip and its rule, and republishing is not
   blocked or warned**: the chip on the card is the whole signal, to the republisher as to everyone.

Left to the build: its place in `postVisibleToUserSql` (ONE predicate every read path already goes
through). Built after the named-reader comments change, which edits the same predicate.

**BUILT (2026-11-04, migration 133)**: the gate is `studentsOnlyAdmitsUserSql`, one conjunct of
`postVisibleToUserSql`; every consumer, the test proving it, the five reversible decisions taken in
the build and what happens to notifications already delivered are in
[profiles-and-access](../profiles-and-access.md#the-students-only-switch-as-built-owner-2026-11-04).

**Owed before this entry is deleted** (it ships with the first release carrying migration 133):

1. On dev, on a pre-release: a list officer publishes with the switch ON, and the post is read by a
   student account, by a member of the list without a cursus, and NOT by a staff account that is a
   member of a carrier, nor by a named reader whose cell covers the list's space (feed, search, the
   post by its link, its bell row); then the officer turns it OFF from the edit form and the staff
   account and the named reader read it at once, with no wait.
2. The chip read on both phones (Mi 9T, iPhone 12): on a card, on a republished card and in the
   CanaReels viewer, in light and dark.
3. The switch and its one line read on both phones in the composer, the reel publish step and the
   edit form - the owner's "clair, propre, le plus user-friendly possible".
4. After the stable: the count of posts carrying it (`SELECT count(*) FROM posts WHERE "studentsOnly"`)
   a week in, to know whether it is used.
