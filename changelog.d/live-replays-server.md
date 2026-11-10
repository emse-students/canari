### Added - live replays: the server (WP-R2), inert while the switch is off

A live started with `live_replays_mode = on` keeps its last 3 hours and, once ended and drained, becomes a three-day `kind = 'replay'` post served by `GET /api/lives/:id/replay` to the live's audience and to clients that send `withReplays`; never reposted, ended at once by a cut, held under `LIVE_REPLAY_TOTAL_MAX_GB` (20 GB) with a `[LIVE_REPLAY_CAP]` WARN and an admin storage line. [live-replays](docs/wiki/live-replays.md#wp-r2-as-built).
