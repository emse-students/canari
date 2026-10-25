### Added - the 1.4.1 CC rows (concurrent commits) have a runner

`archive/cc.mjs` plays CC-1..4 by holding each seat's commit before the server and releasing them together, judged on the gate's own `[COMMIT]` lines; CC-4 arms the leaf refresh on the device, and CC-5 waits for a fifth account ([harness](tools/cross-client-harness/README.md#the-141-row-runners---mlsrowmjs-rowkitmjs-one-table-per-group)).
