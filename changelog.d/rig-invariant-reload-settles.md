### Fixed - the invariant's reload pass judged a group its own reload was still moving

A reloaded client may commit at its connection (the stray-leaf sweep removes a leaver's leaf there), so the second pass now waits, bounded, until every member reaches the server epoch before it judges, and records the wait. RM-8 also reads the exit replay of #2259 as narration ([README](tools/cross-client-harness/README.md)).
