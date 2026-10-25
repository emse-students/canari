### Fixed - the invariant's reload pass judged a group its own reload was still moving

A reloaded client may commit at its connection (the stray-leaf sweep), so the second pass now waits until the server and every member agree on two rounds in a row; a group that never settles makes the row INCONCLUSIVE rather than judged. RM-8 names the exit replay and the lost `memberLeft` notice (a backlog P3) as its own expected lines ([backlog](docs/wiki/backlog.md)).
