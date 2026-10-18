### Added - the server half of live broadcasts (WP-L2, WP-L3), off on production

`/api/lives` starts a live, serves its key and a manifest, takes sealed segments in order and deletes everything at the end or by a 30-second sweep; every route is a 404 unless `LIVE_ENABLED`, rendered `true` on dev only ([lives](docs/wiki/services/lives.md)).
