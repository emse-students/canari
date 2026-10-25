### Changed - DUP-7 names its unmet premise instead of failing

When W1 never commits the Add of the new device, DUP-7 now reports that the row did not happen. On `1.4.1-alpha.3` the device joined by its own external commit, so the Add whose answer is lost and the held Welcome were never exercised; this used to be judged FAIL. Pinned in `devrows-selftest.mjs` ([README](tools/cross-client-harness/README.md)).
