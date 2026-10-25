### Fixed - a fault disarmed right after a rewrite fired no longer loses the rewrite, and every re-fetch trigger is classified

`disarm` now waits for in-flight `rewrite` answers before `Fetch.disable`; GAP-2's capture had been cut by it and recorded INVALID. The `[QUEUE] … re-fetching` rules name all five triggers and every `UnackedReason` ([cross-client-testing](docs/wiki/cross-client-testing.md)).
