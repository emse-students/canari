### Fixed - the social-service integration job no longer prints a fault it provoked or a double it forgot

The specs' Redis doubles now implement `incr` (the feed-cache sweep calls it, so every sweep logged `redis.incr is not a function`), and the specs that provoke `[LIVE_SEAT]`, `[LIVE_ARRIVAL]` and `[LIVE_GC]` lines on purpose capture and assert them instead of printing them.
