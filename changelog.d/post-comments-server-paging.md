### Added - comments: a 2000-character limit, "edited" on an edited comment, and a paged `GET /posts/:id/comments`

The server refuses a longer comment, stamps `editedAt` on an edit, and serves comments as whole threads by cursor; the client gets `fetchComments` and a per-post draft store. First of the comment-sheet rework ([posts](docs/wiki/frontend/modules/posts.md#comment-sheet-rework-2026-10-21)).
