## P3 - chat-gateway and call-service share no crate, so two modules are copied between them

target: 1.10.0

`log_repeat.rs` (a recurring log line said once, then at each power of ten) exists in both
`apps/chat-gateway/src/` and `apps/call-service/src/`, held byte-identical by an `exact` group of
`.github/scripts/lib/declared-duplicates.mjs`, so it cannot drift, but it is still a copy. Any
other module the two services come to carry in common (`origin.rs`, which origins a socket upgrade
may name) is declared the same way and belongs to the same crate.

**What a shared crate needs, and why it was not done with the copies:** each service is built from
its own directory, so a `path` dependency outside it changes both Dockerfiles' build context, the
CI path filters that decide which crate is tested, and the two `Cargo.lock` files. `models.rs`'s
`decode_access_claims` is a third candidate for the same crate (both services carry it).

Done when the crate exists, both services depend on it, and their groups are deleted from
`declared-duplicates.mjs` in the same change ([chat-gateway](../services/chat-gateway.md),
[call-service](../services/call-service.md)).
