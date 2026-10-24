### Fixed - the test rig knows the dev estate and refuses production outright

`estate.mjs` routed every estate that was not local to production's containers; it now accepts the local estate or dev (found by its `canari-dev` compose label) and refuses any other `SITE` before a line runs ([harness README](tools/cross-client-harness/README.md#the-target-the-local-estate-or-dev-and-production-is-refused)).
