## P2 - an institution chooses the reach of each post: its spaces and its public (decided by the owner on 2026-11-10, built the same day, readings owed)

The owner amended D19 ("an audience is FIXED BY THE AUTHOR, never chosen",
[profiles-and-access](../profiles-and-access.md#2-the-model-the-user-decided)) **for institutions only** - not
associations, not lists, not personal posts. It is the posts half of the reform's C1 / WP-I
([reform section 3](../spaces-and-audiences-reform.md#3-per-item-audience-for-institutions-only-c1)),
with the owner's own shape of it.

### The decisions (owner, 2026-11-10)

1. **Spaces.** The institution ticks the spaces (formation x campus) the post targets, with
   shortcuts "a whole campus" and "a whole formation". **Never wider than the audience the admin gave
   the institution**: it restricts inside its own audience, and the server refuses anything else
   (typed, at the throw).
2. **Public**, a second choice: **Tous / Étudiants / Personnel** - everyone in the ticked spaces,
   only students (an account with a cursus), or only staff (no cursus).
3. **No default.** Nothing is pre-selected, the choice is mandatory at every post: "Publier" stays
   disabled until the spaces and the public are chosen.
4. **Editable after publishing, both ways.** Narrowing withdraws the post from the excluded readers at
   once, widening gives it back; no new notification is sent on an edit.
5. **Everything a post reaches follows the rule** - feed, search, the post by id, comments,
   reactions, votes, notifications and announcements, trends - so it belongs in the ONE visibility
   predicate, like "Entre étudiants". **An event announced by the post keeps its own visibility**
   (as decided for "Entre étudiants").
6. The owner's requirement on the result: "clair, propre, user-friendly" - one compact block.

### Built (2026-11-10, migration 161, not held)

Two columns on `posts` (`"reachPublic"`, `"reachSpaces"`), a public gate beside "Entre étudiants" and
a space filter on the post's own institution door, both inside `postVisibleToUserSql`; the write,
its four typed refusals, the options route, the picker, the chip, the five reversible decisions taken
in the build and the test that proves it are in
[profiles-and-access](../profiles-and-access.md#an-institutions-reach-per-post-as-built-owner-2026-11-10).
One question is parked for the owner: whether "Personnel" should also reach every staff account of a
ticked campus ([open-questions](../open-questions.md#question---should-an-institutions-personnel-public-reach-every-staff-account-of-its-campuses-2026-11-10)).

### Owed before this entry is deleted (it ships with the first release carrying migration 161)

1. On dev, on a pre-release: an institution member publishes with two spaces and "Étudiants", and
   the post is read by a student of a ticked space, NOT by a student of an unticked space of the
   institution's audience, NOT by a named reader whose cell covers a ticked space (feed, search, the
   post by its link, its bell row); then the member edits it to "Personnel" and the named reader
   reads it at once while the student no longer does.
2. The picker, its hint line and the disabled "Publier" read on both phones (Mi 9T, iPhone 12) in
   the composer, the reel publish step and the edit form, light and dark - "clair, propre,
   user-friendly".
3. The chip read on both phones on a card and in the CanaReels viewer.
4. After the stable: `SELECT "reachPublic", count(*) FROM posts WHERE "reachPublic" IS NOT NULL
   GROUP BY 1`, a week in.
