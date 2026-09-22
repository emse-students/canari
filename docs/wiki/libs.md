# Shared libraries

**Source**: `libs/`

Canari shares ONE thing across services: the protobuf schema. Two other libraries lived here
and both are deleted - their entries are at the foot of this page, kept because what they cost
while dead is the reason to look for the next one.

## libs/proto

**Source**: `libs/proto/canari.proto`

The canonical protobuf schema for Canari's WebSocket transport and application message payload. See [`protocols/websocket-protocol.md`](protocols/websocket-protocol.md) for the full wire format.

### Schema sections

| Section | Messages | Purpose |
|---|---|---|
| Transport envelope | `WsEnvelope`, `InboundMsg`, `Recipient` | Client ↔ Gateway binary frames |
| Application payload | `AppMessage`, `TextMsg`, `ReplyMsg`, `ReactionMsg`, `MediaMsg`, `SystemMsg` | E2E-encrypted plaintext inside MLS ciphertext |

### Code generation

```bash
cd frontend
bun run proto:gen
```

Generates `frontend/src/lib/proto/canari.{js,d.ts}` from `canari.proto` with `pbjs`/`pbts`. Those two
files are GENERATED and not in git; `bun run generate` builds them alongside the MLS WASM bundle.

---

## See also

- [`protocols/websocket-protocol.md`](protocols/websocket-protocol.md) — Full binary protocol specification
- [`protocols/mls-protocol.md`](protocols/mls-protocol.md) — How `AppMessage` fits into MLS encryption

---

## libs/contracts

**Source**: `libs/contracts/`

**A rule three implementations must agree on, shared as DATA rather than as code.** The apps are
standalone packages - there is no TypeScript workspace here, and the page below records why a shared
package was deleted rather than kept - so a helper cannot be imported across them. What CAN cross is
a table of cases, read from disk by one test per implementation. A case added to the file fails
everywhere at once; an implementation that does not read the file is one nobody is asserting.

### `user-display-name.cases.json`

The one precedence for a person's name, out of the three name columns of the `users` table:
**`firstName lastName`, then `firstName` alone, then `lastName` alone, then `displayName`.** The
pair wins because it is the STRUCTURED identity - initials, the trombinoscope's surname sort and the
chat's first-name-only label are all derived from it, so preferring anything else names a person one
way and abbreviates them another. `displayName` is Authentik's free-form `name` claim, the fallback
for an account whose parts never arrived.

Three implementations read it, one per estate that has to name somebody:

| Implementation | Its answer when the row carries no name |
| --- | --- |
| `apps/chat-delivery-service/src/utils/user-display-name.ts` | `''` - every caller treats the name as decoration and already falls back from empty |
| `apps/social-service/src/utils/user-display-name.ts` | `''`, and each caller supplies its own: the actor id for a notification, `null` on a roster row |
| `frontend/src/lib/utils/users/displayName.ts` | the localized unknown-user label - a person has to read something |

That last column is why the contract pins `expected: null` for the empty row rather than a string:
the three answers are legitimately different, and only the PRECEDENCE is shared.

**TWO MECHANISMS, BECAUSE THE THREE ARE NOT THE SAME KIND OF COPY.** The two server files are
BYTE-IDENTICAL and declared in `.github/scripts/lib/declared-duplicates.mjs`, so a change to one
that is not made to the other fails CI outright. The frontend's cannot be a copy of them - different
runtime, a localized fallback, and a module full of caching and backoff around it - so what ties it
in is this contract, read by all three specs. **Identical text on one side, identical ANSWERS on
the other**, and neither mechanism alone would have caught the divergence that was reported: the
servers agreed with each other perfectly.

**It was written because the two servers preferred `displayName` and the client preferred the pair**
(reported by the user 2026-09-18, backlog `G2`), so one account could be titled one way in a push
notification and another way in the screen that notification opened. The divergence was invisible in
the field: Authentik's `name` claim is exactly `firstName lastName` for **all 436 production
accounts** (measured 2026-09-22), so no user has ever seen the two answers differ - which is also
why nothing could be inferred from them agreeing.

**A FOURTH COPY IS THE SIGNAL TO RECONSIDER THE PACKAGE, not to add a fourth spelling of the rule.**
The same trade `shared-ts` was deleted over applies here, and it is the same paragraph below.

---

## libs/shared-ts, deleted 2026-08-27

There was a third library, `@canari/shared-ts`. It exported three Kafka topic names, a Redis envelope
builder, and re-exports of the three `ts-rs` types. **Nothing imported it** - not one `src/` file in
any of the four NestJS services, not the frontend. Its only mention outside its own directory was a
Jest `moduleNameMapper` in `chat-delivery-service` pointing at the library's SOURCE, which no test
ever resolved, plus a build stage in that service's Dockerfile that compiled it and copied the output
nowhere. Its only commits in its last year were version bumps.

It cost more than it looks: a CI matrix entry, a build step before EVERY backend test job, two CD
path filters, a Dependabot directory, a Makefile target, two Husky branches and a lockfile.

The two things it would have been useful for are duplicated on purpose instead, with the reason
written at the head of each copy: `internal/service-urls.ts` and `internal-secret.util.ts`, in
`core-service` and `social-service`. That trade is still the right one - a shared package would add a
build stage to two more production images to save four lines each. A THIRD copy is the signal to
reconsider, and recreating the package is a twenty-minute job.

---

## libs/shared-rust, deleted 2026-08-31

The second dead library, removed the same day as the broker it existed for. It defined three Kafka
event structs (`MessageSentEvent`, `MessageReadEvent`, `PostCreatedEvent`), their three topic
constants, and a `ts-rs` mirror of each into committed TypeScript bindings.

**Nothing in the repository read a line of it.** `apps/chat-gateway/Cargo.toml` named it as a path
dependency and the gateway's source contained no `shared_rust`; no TypeScript imported the generated
bindings. The one consumer that ever existed - the gateway's Kafka subscriber - never used the
constant, nor even its spelling: it subscribed to `post.created` while `TOPIC_POST_CREATED` is
`post_created`, so a producer written against this crate would have published past its only reader.
See [chat-gateway](services/chat-gateway.md#no-kafka-consumer-and-no-broker---removed-2026-08-31).

It cost the same shape of tax `shared-ts` did: a CI matrix entry with its own change-propagation
flag, two CD path filters, a Dependabot directory, a CODEOWNERS line, a `git add` in the version
bump, a `LOCAL_CRATES` entry in `bump-app-version.sh`, a Makefile target inside `make test`, a branch
in both Husky hooks, and a `COPY` in two Dockerfiles. **A dead dependency is not free because it is
small; it is expensive because every mechanism that enumerates the repo has to name it.**

The `ts-rs` mirror is worth remembering as a mechanism even though its subject is gone: `cargo test`
regenerated the bindings and they were COMMITTED, so drift showed up as a dirty working tree in the
same commit as the Rust change. That is a good pattern for a contract written in two languages - it
was simply guarding a contract nobody spoke.
