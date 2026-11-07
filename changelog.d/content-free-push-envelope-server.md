### Added - the push envelope, the server half of content-free push past MLS frames (switch off)

Salon, social, reaction and join-ask pushes can now be stored per device and replaced by a wake that
names nothing, fetched back over our own TLS; inert until a client declares wake version 2, behind
`push_mode`. Chat-delivery migration 046 adds `push_envelope` and `push_token.wakeVersion`
([content-free-push](docs/wiki/protocols/content-free-push.md#32-everything-sent-through-sendpushtouser---no-durable-row-exists-so-one-is-written)).
