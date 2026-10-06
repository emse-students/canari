### Fixed - a scheduled post is ordered and dated by when it went live

It sat behind newer posts with the time it was written; the feed now uses one `publishedAt` (migration 077 backfills it) ([posts](docs/wiki/frontend/modules/posts.md#one-notion-of-when-it-became-visible-publishedat-2026-10-06)).
