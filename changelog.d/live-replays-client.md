### Added - live replays: the client (WP-R4, WP-R5), inert while the switch is off

A finished live is a CanaReel page and a feed card: played from its own segments in the shared player (`ReplayPlayer`, seekable, with the time left drawn on a replay only), saved segment by segment as one MP4 (a second part when the camera changed), no repost; the client asks `withReplays` only when `/api/version` publishes `liveReplays.mode = on`, and the broadcaster's texts name the replay only then. [live-replays](docs/wiki/live-replays.md#wp-r4-and-wp-r5-as-built).
