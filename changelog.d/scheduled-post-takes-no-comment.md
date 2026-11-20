### Fixed - a post that is not published yet takes no comment

The comment write refuses a post not published yet (the database's own predicate, under the row lock), its own author included, with a typed 409 (`COMMENT_POST_NOT_PUBLISHED`), the app words it, and the card (the post page included) draws no comment control on a scheduled post. Decision in [moderation](docs/wiki/moderation-and-blocking.md#a-post-that-is-not-published-yet-takes-no-comment-owner-2026-11-19).
