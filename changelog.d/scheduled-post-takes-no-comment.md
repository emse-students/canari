### Fixed - a post that is not published yet takes no comment

The comment route refuses a post whose `publishedAt` is in the future, its own author included, with a typed 409 (`COMMENT_POST_NOT_PUBLISHED`), and the card no longer opens a comment sheet on a scheduled post. Decision in [moderation](docs/wiki/moderation-and-blocking.md#a-post-that-is-not-published-yet-takes-no-comment-owner-2026-11-19).
