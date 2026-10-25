### Fixed - the row kernel accepts the server's user id shape

`mlsrow.mjs` `displayNameOf` refused every user id because it tested for a uuid, and the server keys an account by a 64-hex digest - every 1.4.1 FLOOR draw died before acting ([harness](tools/cross-client-harness/README.md#the-141-row-runners---mlsrowmjs-rowkitmjs-one-table-per-group)).
