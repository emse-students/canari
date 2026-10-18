### Fixed - a post with two forms took the whole feed behind the error boundary

Each attached form was read and drawn twice when its answers arrived apart (`each_key_duplicate`, production 1.2.9); forms are now asked once and keyed by form, and one card that fails no longer hides the feed ([posts](docs/wiki/frontend/modules/posts.md#a-post-with-two-forms-took-the-whole-feed-down-asked-and-answered-are-two-records-2026-10-18)).
