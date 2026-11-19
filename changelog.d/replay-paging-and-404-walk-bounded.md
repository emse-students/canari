### Fixed - a replay's listing and a seek's walk over missing segments always end

A page that adds nothing no longer makes the player request pages forever, and a long run of deleted segments is walked a bounded number of times before the seek lands ([live-replays](docs/wiki/live-replays.md#the-listing-and-the-walks-terminate-by-proof-2026-11-19)).

A fully purged replay is called gone from the probes' verdict instead of walking every segment, a probed gap running to the end is judged empty like `gone`, and a 404 answer ends a stale reconnecting screen.
