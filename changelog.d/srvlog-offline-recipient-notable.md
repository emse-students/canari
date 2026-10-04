### Fixed - the harness reports an MLS frame queued for an offline device instead of leaving it unexplained

`srvlog.mjs` gives the gateway's `message stays in DB queue` line its own `notable` rule (a non-empty `queuedId` only), with its cases in `srvclassify-selftest.mjs`; `[DEVICE_MEMBERSHIPS] stranded>0` stays unexplained on purpose ([harness README](tools/cross-client-harness/README.md)).
