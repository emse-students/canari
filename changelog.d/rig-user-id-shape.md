### Fixed - the row kernel accepts the server's user id shape

`mlsrow.mjs` `displayNameOf` refused every user id because it tested for a uuid, and the server keys an account by a 64-hex digest - every 1.4.1 FLOOR draw died before acting ([harness](tools/cross-client-harness/README.md#the-141-row-runners---mlsrowmjs-rowkitmjs-one-table-per-group)).

### Added - one named environment exception for the dev edge's injected script

The dev zone's Cloudflare detections inject an inline script our CSP refuses on every page, which made every dev row `PASS-DIRTY`; `watch.mjs` `DEV_EDGE_CSP_EXCEPTION` forgives exactly that refusal, on dev only, and every verdict that used it names it ([board](docs/wiki/cross-client-testing.md)).
