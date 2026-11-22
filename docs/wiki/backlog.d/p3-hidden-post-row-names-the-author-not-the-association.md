## P3 - A hidden post's row names the author instead of the institution that published it (2026-11-18)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

In `/admin/moderation`, the "hidden" tab row (`frontend/src/routes/admin/moderation/+page.svelte`, the
`{#each hiddenPosts as post}` block) prints the post's `authorId` name and avatar whenever one is set,
and falls back to the generic association label only when there is none. A post published by an
association (institution) that carries its author's id therefore shows the person, not the association
that spoke. Fix: the row names the publishing association first (its name and logo), the author only as a
secondary line; the `HiddenPost` payload needs to carry the association id for that. Charter:
[principes](../../principes.md) (an institution's word is the institution's).
