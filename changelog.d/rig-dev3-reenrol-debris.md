### Added - DEV-3 records a revoked seat's re-enrolment as its own debris

When the revoked seat comes back under a fresh device id of the same account, read from that seat's own storage, the row now records the id in the campaign ledger so the device purge may remove it. No other device is recorded. A new assertion fails the row on such a re-enrolment, pinned with its controls in `devrows-selftest.mjs` ([README](tools/cross-client-harness/README.md)).
