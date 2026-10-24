### Added - the rig destroys on dev only what the campaign created

A per-estate ledger records every fixture, group, salon, community and device the rig creates, and every destructive gesture checks it first; `cleanup.mjs` on dev takes `--only <ids> --expect N`. `campaign-fixtures.mjs` builds the 1.4.1 fixtures through the product ([harness README](tools/cross-client-harness/README.md#what-a-row-may-destroy-on-dev-the-campaign-ledger-r5)).
