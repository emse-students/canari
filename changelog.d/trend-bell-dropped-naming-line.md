### Fixed - the campus-trend bell no longer logs a dropped naming at every read

The bell is polled every 60 s per open client and re-drops the same stale naming each time, so the `[TREND] bell: N of N naming(s) no longer hold` debug line repeated about 37 times in 15 minutes on dev with nothing new behind it. The read decides nothing, so it no longer says anything ([engagement](docs/wiki/engagement.md)).
