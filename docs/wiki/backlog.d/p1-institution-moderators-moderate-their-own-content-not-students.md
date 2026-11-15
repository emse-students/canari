## P1 - an institution's MODERATE member moderates the students of a space it governs, and not the institution's own content

target: 1.8.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md), decisions 3 and 4): an
institution's `MODERATE` member does NOT moderate students - the door and the scope count governors
of type `association` only (`governorIsAnAssociationSql`), and a space with no BDE stays with the
platform admin. And an institution's own `MODERATE` members moderate THAT institution's content (its
posts, its lives, the comments under them, and the comments in its name), the platform admin keeping
recourse.

**Today, the reverse.** Since WP-D1 a space's governor may be an institution:

- the DOOR: `isContentModerator` -> `callerHasAnyBdeFlag(MODERATE)`
  (`apps/social-service/src/associations/associations.service.ts`) filters the type for `MANAGE_ASSO`
  only, so an institution governing a space passes it;
- the SCOPE over people: `bdeModeratesUserSql` (`spaces/bde-moderation.ts`) reads
  `bdeStandingInSpaceSql` (`spaces/bde.ts`), which tests no type - so the institution's staff mute
  students for the whole platform, withdraw their broadcast right, hide and delete their personal
  posts, cut their lives and read their anonymous authors;
- the institution's OWN content: `bdeModeratesPublisherSql` -> `governingBdeJoinSql` excludes
  institutions, so only the platform admin hides it, cuts it or moderates the comments on it
  (`MODERATION_RESERVED_TO_PLATFORM_ADMIN`).

**The change.** One predicate each, so every consumer inherits it:

1. `callerHasAnyBdeFlag` adds the type test for `MODERATE` as it does for `MANAGE_ASSO`;
   `bdeModeratesUserSql` adds `governorIsAnAssociationSql` on the space's governor. The agenda's
   `holdsBdeAgendaRightOverSql` is NOT touched: an institution keeps its agenda right (owner, 2026-11-03).
2. An institution half of the publisher predicate: the user holds `MODERATE` IN the institution that
   published the content. The content predicate ORs it in, so posts, lives, comments in its name,
   comments under its posts, live chat lines and `reportInBdeScopeSql` follow. `MODERATION_RESERVED_SQL`
   then reserves an institution's content to the platform admin only for a caller who is not its IM.
3. The door becomes "moderates somewhere": a BDE's `MODERATE` or an institution's (the IM must reach
   `/api/moderation/*` and the post controls), while the acts aimed at a PERSON (mute, broadcast
   withdrawal, a `user` report) stay the BDE's.
4. The served capabilities (`canManage`, `canUnmaskAnonymous`, a comment's `canDelete`, the anonymous
   reveal) follow from the predicates. Enumerate every consumer of `moderatedAssociationIds` and
   `moderatedPostIds`, never only the ones that mention institutions.

**Proof.** In `bde-moderation.integration.spec.ts` (PostgreSQL): with an institution governing a space
that has no BDE, its IM cannot mute, withdraw, hide or cut a student of that space (403
`MODERATOR_REQUIRED` or `MODERATION_OUT_OF_SCOPE`), and the platform admin can; its IM hides, unhides,
deletes and cuts the institution's own post and live, deletes a student's comment under its post and
sees its writer; a BDE still cannot. The `[IM]` rows of the
[grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md) turn from `it.todo`
into assertions. [moderation-and-blocking](../moderation-and-blocking.md#who-may-read-the-queue) and
[profiles-and-access D23](../profiles-and-access.md#d23-amended---moderate-is-scoped-and-only-the-author-edits-a-post-2026-11-02)
lose their "today" notes in the same pull request.
