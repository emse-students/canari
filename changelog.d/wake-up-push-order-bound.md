### Fixed - the wake-up push's ordering on Android cannot strand a push or count a Welcome late

A wake ticket whose deadline cannot be scheduled is settled at once, a timeout is one log line, the bound is counted in awake time on one clock, and a release batch counts every Welcome before the lane runs any of its tasks ([design](docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md)).
