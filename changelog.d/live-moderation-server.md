### Added - live moderation, server half (WP-L8): report a live, staff cut, first-live rules

A live is reported through `content_reports` like a post, staff cut it for everyone (`POST /api/lives/:id/cut`, a `410` with `endReason: 'cut'`), and a member must accept the live rules before a first broadcast; dev-only behind `LIVE_ENABLED` ([lives](docs/wiki/services/lives.md#moderation-wp-l8-server-half), [store answers](docs/wiki/store-ugc-answers.md)).
