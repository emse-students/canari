## P2 - a post's owner cannot act on another person's comment under it

target: 1.8.4

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md), decision 5): the author of
a post - or the `POST_AS_ASSO` holders, for an association's post - may HIDE, never delete, another
person's comment under that post. It shows as a tombstone, like moderation's, and never reveals an
anonymous writer.

**Today** `commentRights` (`apps/social-service/src/posts/comment-identity.ts`) knows the comment's
author and its moderators only; no column and no route hide a comment. A comment out of place under
an association's post waits for a report and a BDE moderator or the platform admin.

**The change.**

- A marker in the `posts.comments` jsonb (no migration), written under the post row's lock
  (`writeComments`, `posts/comment-write.ts`), never a delete: the row, its likes and its replies
  stay; its text, media and writer are not served to readers.
- Served like the moderation tombstone, with its own Paraglide wording ("hidden by the post's
  author"), no `userId` and no rights for readers; exempt from the block filters like a tombstone
  (`commentShownDespiteBlocks`), for the same reason - hiding it from the blocker would answer who
  wrote it.
- WHO: `isPublisherOf(post, viewer)`, the one predicate that already makes a holder "the author". It
  never grants `seesAccount`: the place owner learns nothing about an anonymous or association writer.
- The place owner's own comments, and those in its own association's name, are outside the hide: they
  edit or delete them as their author.
- **Restoring it, the owner's answer of 2026-11-15** (decision 15, *"Auteur ou moderateur, en
  silence"*): the place owner (any holder, for an association) or any moderator of the post restores
  it, and the writer is told neither of the hide nor of the restore. It does not contradict decision
  14: the place owner's hide is a lighter act than moderation, like a broadcaster hiding a line of
  their chat, so the moderation notice
  ([its entry](p2-a-moderated-person-is-told-which-place-acted.md)) does not apply; the act IS
  journaled for the place's peers ([the journal](p2-every-moderation-act-is-journaled-for-its-peers.md)).
  The replies under a hidden comment stay shown.
- A served `canHide` per comment; the client draws "Masquer" in the comment menu.

**Proof.** `comment-identity.spec.ts` (the rights table: the place owner hides, never deletes, never
sees the writer), `comment-write.integration.spec.ts` (a hide racing a reply under the held lock), a
block spec (a hidden comment of a blocked writer is no probe), a client test that the tombstone shows
no name. The `[HIDE]` rows of the [grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
