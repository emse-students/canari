## P2 - a person whose content was hidden or deleted is never told

target: 1.8.4

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md#the-journal-and-the-notice),
decision 14, *"Savoir seulement"*): the person whose content was hidden or deleted sees WHICH PLACE
acted - the association, the BDE, the institution or the platform admin - never the person who did,
and the reason when one was given. There is no appeal inside the app.

**Today** nothing tells them: a hidden post simply leaves the feeds, a deleted comment disappears or
becomes a tombstone, and the author learns it by noticing.

**The change.**

- An in-app notice (a row of the existing notifications, a new type) written from the journal row of
  the act ([the journal](p2-every-moderation-act-is-journaled-for-its-peers.md)), carrying the
  place's name and the reason code, never the actor's id or name. Its text is a Paraglide string per
  act and place kind.
- Acts that notify: a moderator's hide and delete of a post, a CanaReel or a replay, a moderator's
  delete of a comment, a live cut (already told to the broadcaster by the ladder - one notice, not
  two), a bio erasure, and - the lead's reading, reversible - a mute ([its entry](p2-a-moderator-erases-a-bio.md)). Acts that do NOT: a place
  owner's silent hide of a comment (decision 15), an auto-hide (no one acted; the notice comes if a
  moderator then deletes), a moderation read.
- **Reading their own hidden content** (the lead's reading, reversible, principle 1: it is theirs):
  the author of a hidden post or CanaReel, and the broadcaster of a hidden replay (any holder, for
  content in an association's name), may open it READ-ONLY - no reaction, comment or share - so the
  notice points at something they can see. Today a hidden post and a hidden replay are refused to
  everyone but the platform admin (`post-openable.ts`, the replay read in `lives.service.ts`).
- An anonymous post's author is told like any author, and the notice never names the post in a way
  that reaches anyone else.
- No reply, no appeal route; the reason is a code from the one reason list
  (`frontend/src/lib/moderation/reasons.ts`) plus the moderator's free text when given.
- **Design point, the lead's reversible reading:** the notice follows the person's existing
  notification settings like any other social notice (principle 3: each type turns off in one
  gesture), and pushes nothing by default.

**Proof.** A spec per notifying act: one notice, naming the place and never the actor (an assertion on
the stored row's fields); no notice for a silent hide, an auto-hide and a read; a client test that the
notice draws the place's name and the reason; the author and the broadcaster open their own hidden
post and replay read-only, and any other reader still gets the refusal. The `[NOTICE]` rows of the
[grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
