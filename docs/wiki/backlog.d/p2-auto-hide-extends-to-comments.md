## P2 - a massively reported comment stays up until a human acts

target: 1.8.4

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md#comments-plain-anonymous-in-an-associations-name),
decision 17): auto-hide extends to comments, with the same threshold. That a moderator restores one
is the lead's reading, reversible (the post's rule).
Live chat lines stay with the broadcaster and the bureau - no auto-hide for them.

**Today** five pending reports hide a POST (`createReport`, `apps/social-service/src/moderation/moderation.service.ts`,
`AUTO_HIDE_THRESHOLD`), and never a comment.

**The change.**

- The same threshold, read from the same constant, counts the pending `comment` reports of a comment
  and marks it hidden in the `posts.comments` jsonb (no migration), under the post row's lock
  (`writeComments`, `posts/comment-write.ts`), in the transaction that inserts the fifth report.
- A hidden comment is served like a moderation tombstone to readers (no text, no writer, no rights),
  its replies kept; its moderators (`moderatesComment`) still read it and restore it - a restore clears
  the mark and the pending reports stay for review.
- Not a delete: nothing is erased, no media released, the writer is not told (no one acted; the notice
  of [its entry](p2-a-moderated-person-is-told-which-place-acted.md) comes only if a moderator then
  deletes).

**Proof.** A PostgreSQL spec: four reports leave the comment, the fifth hides it in the same
transaction; a reader is served a tombstone, a moderator of the post the full comment; a restore shows
it again; a comment of another post is untouched; a live chat line is never auto-hidden. The
`[AUTOHIDE]` rows of the [grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
