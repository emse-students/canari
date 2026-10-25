### Fixed - a fault disarmed right after a rewrite fired no longer loses the rewrite, and the fixes' new lines are classified

`disarm` now waits for in-flight `rewrite` answers before `Fetch.disable`; GAP-2's capture had been cut by it and recorded INVALID. The `[QUEUE] … re-fetching` rules name all five triggers and every `UnackedReason`. The abandoned-Add, commit-race and Remove lines of #2414/#2416 are NOTABLE by anchored rules, and GAP-2 now asserts #2421's own-echo line exactly once instead of only the absence of a loss ([cross-client-testing](docs/wiki/cross-client-testing.md)).
