## P1 - `/posts/hidden` serves an association post's raw writer, while the card hides it from every moderator

target: 1.8.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md), decision 11): the writer of
an association's post is visible to its moderators - the platform admin and the BDE in scope, and the
institution's IM for its own posts once
[the institution entry](p1-institution-moderators-moderate-their-own-content-not-students.md) lands -
the same as an association COMMENT's writer already is (`seesAccount`, `posts/comment-identity.ts`).
And the raw `authorId` of `/posts/hidden` is closed.

**Today.** `shapeListRow` and `toPublicPostFromEntity` (`apps/social-service/src/posts/posts.service.ts`)
delete `authorId` from every association post for every reader, a moderator's included; but
`getHiddenPosts` selects `p."authorId"` and `GET /posts/hidden` (`posts.controller.ts`) returns the rows
unshaped. Which officer wrote in an association's name is hidden on one screen, served on another,
and served for a comment.

**The change.** ONE served field for "the writer behind a name", decided by ONE predicate: a post is
served its `authorId` when the viewer moderates it (`moderatedPostIds`, the set
`mustHideAnonymousAuthor` already reads) or is its own writer - for an association's post as for an
anonymous one. `getHiddenPosts` returns its rows through the same shaping, never a raw `SELECT`
column, so the list and the card agree by construction. A regular reader and the association's other
holders are served no writer (nothing decided otherwise). The client draws it like the anonymous
reveal (`RevealedAuthorLine`): the association's name big, the writer small, for moderators only.

**Proof.** A `posts.service` spec on PostgreSQL: an association post read by a BDE moderator in scope,
the platform admin, a BDE moderator out of scope, another holder and a reader - `authorId` present for
the first two only, on the card, by id, in search and in `/posts/hidden`; and an assertion that
`getHiddenPosts` builds its rows through the shaping function, so a new raw column cannot pass. The
`[WR]` rows of the [grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
