# The mail client's transport - as built, lot 1

**What this page is.** The design of the school mailbox in Canari is `docs/wiki/mail-client.md`
(lot 0, decisions D1-D12; pull request #4193 at the time of writing - once it is merged this page's
references to it become links). This page is what lot 1 BUILT of it: the pipe that carries bytes
from a Canari client to `partage.emse.fr` and back, with TLS ended IN THE CLIENT (D3), so no Canari
server ever holds a mail password, a session token or a message; and who may use it (D1). **Nothing
in lot 1 is visible to a user**: no tab, no string, no route a page calls. Lot 2 builds the session
on top of it.

```
  web page                                          Tauri app (desktop, Android, iOS)
  ZimbraSoapClient   (JSON SOAP, frontend/src/lib/mail/soapClient.ts)
  Http1Connection    (HTTP/1.1 keep-alive on BYTES, http1.ts)
  TlsConnection      (rustls in WASM, tlsConnection.ts + frontend/mail-tls)
        |                                                 |
  relayTransport (WebSocket)                    tauriSocketTransport (native TCP)
        |                                                 |
  nginx /api/mail/relay -> chat-gateway          mail_socket.rs, ONE compile-time host:port
  (blind relay, ONE upstream)                             |
        +--------------------> partage.emse.fr:443 <------+
```

## The TLS client (`frontend/mail-tls`)

A sans-IO rustls `ClientConnection`, wrapped for wasm-bindgen (`src/wasm.rs`, `MailTlsClient`) and
usable natively as a plain Rust library (`src/lib.rs`, `MailTls`). The page feeds it what the
transport received (`feedCiphertext`), sends what it owes (`takeCiphertext`), and reads and writes
plaintext. It knows ONE name, `partage.emse.fr` (`SERVER_NAME`): the certificate must carry it, and
the ClientHello's SNI names it. A failure is TYPED at the throw, as `kind` on the error -
`certificate`, `peer_alert`, `incompatible`, `protocol`, `closed` - and the TypeScript side reads the
kind, never the message (`asMailTlsError`; anything else is `internal`). The rustls errors are
classified by VARIANT (`From<rustls::Error>`): an invalid certificate and NO certificate are both
`certificate`; a server offering nothing this client accepts (`PeerIncompatible`) is `incompatible`;
an alert the server sent is `peer_alert`; everything else is `protocol`.

**TLS 1.3 only.** The crate's rustls features are `ring` and `std`, and `tls12` is NOT enabled:
`partage.emse.fr` answers TLS 1.3, and a 1.2 code path nobody exercises is attack surface. A server
that ever offered 1.2 only would be refused as `incompatible`, typed.

**What the engine buffers, and why.** rustls caps the plaintext it holds unread at 16 KiB and stops
processing records past it, so a server answer larger than that would stall a sans-IO client that
reads only between feeds. `feed_ciphertext` therefore DRAINS: read_tls, process the records, move the
plaintext into the crate's own buffer, repeat until the input is consumed - so a feed of any size is
processed whole. On the send side `set_buffer_limit(None)` lifts rustls's 64 KiB cap on unsent
ciphertext, so a `write_plaintext` of any size is accepted in one call; a write failure is
`protocol`, never mistyped. The peer's `close_notify` is recorded (`peer_closed`), which is what the
HTTP layer needs to tell a complete connection-framed body from a cut one (below).

It is built exactly like `mls-wasm` and, like it, NOT committed: `bun run wasm:build` builds both
(`wasm-pack build mail-tls --target web --out-dir ../src/lib/wasm/mail-tls`, after `mls-wasm`, whose
out-dir is the parent), the CI action `.github/actions/build-mls-wasm` builds and verifies both, and
`frontend/src/lib/wasm/` stays gitignored ([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)).
The page loads it with a DYNAMIC import (`loadMailTlsEngine`), so the module and its binary are their
own chunk, fetched when the first mail connection is made and never by a page that does not open one.
A load that fails is a `MailTlsLoadError`, typed `http_status` (the binary answered a non-2xx) or
`unavailable` (the import or the instantiation failed).

**Its size, measured 2026-11-27:** `mail_tls_bg.wasm` is 561,849 bytes, 260,753 gzipped (`-9`),
release profile `opt-level = "z"`, LTO, one codegen unit, `panic = "abort"`. About a quarter of
`mls_wasm_bg.wasm` (2.48 MB). Measured before `tls12` was dropped, which only shrinks it.

### The crypto provider

**ring 0.17**, with its `wasm32_unknown_unknown_js` feature, for both targets. Why:

- it is rustls's own provider and builds for `wasm32-unknown-unknown` and every native target the
  apps ship, so one configuration serves both (`provider()` in `lib.rs`);
- the pure-Rust alternative (`rustls-rustcrypto`) drags `rsa` and `crypto-bigint`, which carry open
  RUSTSEC advisories - and the audit blocks on what we ship ([cicd](cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17));
- `aws-lc-rs` does not build for `wasm32-unknown-unknown`.

**Its cost: ring compiles C for wasm32**, so the build needs a clang with the WebAssembly backend.
LLVM's clang has it (Windows and Linux runners); Apple's clang does not, so the action finds one on
macOS (Homebrew `llvm`) and exports `CC_wasm32_unknown_unknown` / `AR_wasm32_unknown_unknown`, after
a probe that compiles one C file for the target and fails the step loudly if it cannot.

Randomness is `getrandom` through the browser's `crypto.getRandomValues` (ring's `js` feature). The
clock, which rustls reads for certificate validity, is `rustls-pki-types`' `web` feature
(`Date.now()`): without it rustls's std code does not compile for wasm32 at all.

### The roots

`webpki-roots` (Mozilla's set, compiled in). Not the platform's store: the WASM has none, and one set
on every platform means a certificate is judged the same everywhere. A change of CA on the school's
side breaks the client only if the new CA is outside Mozilla's set; the error is then `certificate`,
typed, and never retried.

### Its tests (`cargo test` in `frontend/mail-tls`)

Thirteen, against an in-process rustls server with an `rcgen` certificate: the ClientHello carries
the SNI; a full handshake carries plaintext both ways; an untrusted root, another root and a wrong
name are each refused as `certificate`; non-TLS bytes are `protocol`; the peer's close_notify is seen
and a write after `close` is refused; the error codes are distinct; a 200 KiB answer arrives whole
whether fed in 64 KiB pieces or at once (the drain); a 1 MiB write is accepted in one call; rustls's
failures are classified by variant (no certificate is `certificate`, `PeerIncompatible` is
`incompatible`, a bad record MAC is `protocol`); and a close_notify sent after plaintext leaves that plaintext readable.

## The relay

`GET /api/mail/relay` on chat-gateway (`apps/chat-gateway/src/mail_relay.rs`): a WebSocket whose
binary frames are piped, both ways, to a TCP connection to ONE upstream. It is BLIND: it reads no
byte for meaning, and the only thing it looks at is the TLS record HEADER (content type, length), to
count records by type for the end-of-connection line - never their content, which is ciphertext.

**Its admission, in order** (`mail_relay_handler`): the switch is off -> 404; the `Origin` is not in
`ALLOW_ORIGIN` -> 403 (the same check as `/api/ws`); no valid access token (cookie `canari_ws_token`,
else `?token=`, the same rule as `/api/ws`, through the shared `socket_token`) -> 401; no place left
-> 503; the account is not eligible -> 403, or its eligibility cannot be known -> 503; the upstream
refuses the TCP connection -> 502. Only then is the socket upgraded: every refusal is an HTTP status
the client can read, and no upgraded socket exists for a request that would be refused.

**Its destination is written once**: `MAIL_RELAY_UPSTREAM`, exactly one `host:port`. A list, a URL, a
wildcard, brackets or anything else STOPS the gateway at boot (`Upstream::parse`, `ConfigRefusal`),
as does an unreadable switch or an ON without its eligibility source: a relay whose destination is
anything but the one written down is an open door. Nothing a client sends names a destination.

**Its caps, in one place** (constants at the top of `mail_relay.rs`, and nginx's rate in front):

| Cap | Value | When reached |
|---|---|---|
| connections per account | 4 | 503 before the upgrade |
| connections in all | 400 | 503 before the upgrade |
| bytes per connection, both ways | 256 MiB | closed with code 4001 |
| one client frame | 1 MiB | refused by the WebSocket layer |
| nothing crossing, either way | 100 s | closed with code 4004 |
| upstream TCP connect | 10 s | 502 |
| eligibility question | 5 s | 503 |
| new relay sockets per client address (nginx) | 10/s, burst 100 | 429 before the gateway |

**The rate in front (nginx).** `limit_req_zone $binary_remote_addr zone=mail_relay:1m rate=10r/s`,
applied in `location = /api/mail/relay` with `burst=100 nodelay` and `limit_req_status 429`
(`infrastructure/local/Dockerfile.frontend`). Every admission refusal above costs the gateway a token
check and, past it, a core-service question: the rate bounds what one address can make it do. It is
keyed by ADDRESS, and the campus reaches Canari through a NAT, so it is sized for a building, not a
person: an honest client opens a handful of sockets per session, never ten a second. A test reads the
lines back (`.github/scripts/tests/mail-relay-route.test.mjs`, in `make test-ci-scripts`), and checks
that the idle close below stays under the location's `proxy_read_timeout`.

**How it ends, by close code** (`close_code`, read by `relayEnd` in `relayTransport.ts` - the CODE,
never the reason text): 4000 the upstream closed, 4001 the byte cap, 4002 the upstream failed, 4003 a
non-binary frame, 4004 the connection was idle for `IDLE_DEADLINE`. **The idle close is the relay's
own, at 100 s, BELOW nginx's 120 s** (`proxy_read_timeout`): an idle keep-alive connection then ends
as an ordinary end the client reads (`peer_closed`, like 4000) instead of as nginx's cut, which would
reach it as an unexplained 1006. **One line per connection end**, never one per frame: the account
(8 characters of its id), the duration, the bytes and the record counts each way, and why it ended.
An ordinary end (the client or the upstream closed, or idle) is INFO; a cap or a fault is WARN - the
level depends on how the socket ended, as for `/api/ws`
([chat-gateway](services/chat-gateway.md#how-a-socket-ended-and-why-the-level-of-the-line-depends-on-it)).
A repeated refusal is counted rather than repeated.

**It is OFF unless switched on** (`MAIL_RELAY_ENABLED`, D12), and nginx carries it through a
`location = /api/mail/relay` with the same lines as `/api/ws` plus the rate above.

Its tests (`apps/chat-gateway/src/mail_relay/tests.rs`, 20): the upstream parser and the switch, the
contract equality below, eligibility answers from a fake core, record counting across split frames,
the place caps, and served-route tests against a local TCP echo - bytes piped both ways, ineligible
403, unknown 503, off 404, no token 401, foreign origin 403, the account cap and its place given
back, the byte cap closing with 4001, a text frame closing with 4003, the upstream closing with 4000,
an idle connection closing with 4004, a refused connect 502.

### Eligibility

**D1, as the owner decided it on 2026-11-27: the mail tab is for an account MiConnect hands a SCHOOL
address for - and only those.** MiConnect's `email` claim is SYNTHETIC
(`<username>@canari.emse.fr`, [identity-sources](infrastructure/identity-sources.md#what-the-applications-receive-from-miconnect)),
so it cannot answer; a new claim does:

```
MiConnect --sign-in, scope school_mail (Canari's production and dev providers only)--> core-service
   school_mail = the account's email, ONLY IF the CAS created the account (its cas-emse link's
   identifier is the username) AND it is one address on etu.emse.fr or emse.fr; else ABSENT
   (in the userinfo only - never in the id_token)
core-service: users."mailClass" = student | staff | NULL
   written ONLY by a sign-in whose token answer GRANTED school_mail; any other leaves it untouched
core-service --sign-in answer { ..., school_mail } (ONE use, never stored; only for a STORED class)--> client
client: keeps the address on the device for the mail sign-in's prefill (schoolMailAddress())

chat-gateway --GET /api/internal/users/:id/mail-class (X-Internal-Secret)--> core-service
core-service --> { "mailClass": "student" | "staff" | null } | 404   (one row read, nobody else asked)
```

**The claim** (`infrastructure/authentik/blueprints/10-mappings.yaml`, `miconnect-claim-school-mail`,
its own scope `school_mail`, bound in `50-providers.yaml` to `miconnect-canari` and
`miconnect-canari-dev` and NO other provider). An Alumni-created account carries the ALUMNI address
in its `email` (D46), so the mapping refuses any account whose CAS link does not name it - even an
Alumni account linked to the CAS later: never the Alumni address. It sends ONE address: exactly one
`@`, a local part, no whitespace, a listed domain exactly - the same rule as core-service's
`readSchoolMail` and the client's `mailClassOf`.

**The rule, measured** (read-only on production MiConnect, 2026-11-27): 719 `cas-emse` links, every
one with identifier equal to its account's username (0 mismatches, 0 `alumni-*` usernames, all
accounts active); by the address's domain, 689 `etu.emse.fr`, 30 `emse.fr`, 0 other, none or
malformed. So "the CAS created the account" costs no CAS account, and every one of them gets a class
at its next sign-in granted the scope.

**Not the local provider** (`miconnect-canari-local`): its user is the cross-client harness, which
drives no mail and whose accounts hold no school address. A client asking it for the scope is not
refused: authentik grants the overlap (measured below).

**Never in the id_token.** authentik copies a scope's claims into the id_token by default, and the
client keeps the id_token (`canari_oidc_id_token`) for the sign-out's `id_token_hint`. Canari's three
providers set `include_claims_in_id_token: false`: the id_token carries the protocol claims only
(iss, sub, aud, times), and the client reads `iss` alone (`planMiconnectSignOut`, the only reader of
its claims). So the address is kept on the device in ONE place, `canari_school_mail`.

**Measured on the real endpoints** (`infrastructure/authentik/test-school-mail-claim.py`, inside
`test-blueprints.sh`, authentik 2026.8): the mapping evaluated on test accounts (CAS student and staff
get it; another domain, a subdomain, two `@`, whitespace, an Alumni account, an Alumni account
later linked to the CAS, no link get nothing), then a real authorize and code redemption: the token
answer's `scope` names `school_mail` when it was asked for and not otherwise, the userinfo carries
the address, the id_token does not, and the local provider grants the rest without it. Statically,
`.github/scripts/tests/school-mail-claim.test.mjs` holds the domains equal to the contract, the own
scope, the CAS link, the single `@`, the binding to exactly the two providers, and
`include_claims_in_id_token: false` on all three.

**What Canari keeps: the CLASS, never the address** (charter principle 1, "your messages are yours":
the server keeps what it needs to decide, and the address is not that). `parseProfileClaims` reads the
claim into `mailClass` through `readSchoolMail` (`apps/core-service/src/users/mail-class.ts`), the
upsert stores it on `users."mailClass"` (migration `032_users_mail_class.sql`, additive, nullable,
`lock_timeout 5s` - not held), and a sign-in granted the scope whose claim vanished sets it back to
NULL.

**Only a sign-in GRANTED the scope writes the class.** An older client does not ask for
`school_mail`; were its sign-in read as "no claim", it would clear the class, and the class would
flip with the device the person last signed in from. So core-service reads the GRANTED scopes from
the token answer's `scope` (RFC 6749 5.1; authentik 2026.8 always sends it, measured above), and a
sign-in without `school_mail` in it carries no class at all (`MiconnectProfile.mailClass` absent):
the stored one is left as it is. A token answer with no `scope` is accused at warn and treated the
same way.

**The address is handed out only for a STORED class.** The relay admits on the column, so an address
the client prefilled for a class the database refused would open a mail tab that is then refused.
The upsert returns the row as stored (changes join it only once written), and the callback hands
`school_mail` out only when that row's class is the claim's, accusing the mismatch at warn. The logs
name the class only, never the address.
A restore (account-restore) carries no MiConnect claim: it removes the device's copy, and the class
on the row stays as the last MiConnect sign-in left it.

**The device's copy.** `adoptSignedInSession` keeps the address in the OIDC store
(`canari_school_mail`, the same store as the id_token), set or removed by every MiConnect sign-in,
removed by a restore and by every sign-out that revokes the session. The documented accessor for
lot 2 is `schoolMailAddress()` in `frontend/src/lib/stores/auth.ts`: it PREFILLS the mail sign-in,
and the person still types their password.

**Existing accounts get the class at their next MiConnect sign-in, and lot 3 offers one** (lead's
decision, 2026-11-27, reversible). Nothing back-fills the column: the class exists only where a
sign-in granted the scope wrote it, so after the stable every account already signed in has NULL -
the mail not offered - until it signs in through MiConnect again. Canari's own sessions last, so that
could be weeks. Lot 3 therefore shows, when `schoolMailAddress()` is `null`, an "Activer le mail"
button calling `startSchoolMailActivation(returnTo)`: it is the ordinary sign-in entry point
(`startOidcLogin`), and since the MiConnect session is usually still alive it is one tap - the
callback stores the class and the device's address, then comes back. One path writes the class. An address the client classes as no school address
(`mailClassOf`, `frontend/src/lib/mail/eligibility.ts`) is not kept and accused at warn: core-service
validates against the same contract, so reaching that line is a disagreement between the two.

**Why the relay asks a route rather than reading a claim in the access token** ([sessions](sessions.md)).
The access token is re-minted at every refresh, which never sees MiConnect's claims - so a claim in
it would be this same column read anyway, only on every refresh instead of on every relay socket. And
the token rides on every request to every service and is readable by the client, while only the relay
needs the class: principle 1 keeps the fact where it is used. The route is one primary-key read with
no third party, so `ELIGIBILITY_DEADLINE` is 5 s and a slower answer is a fault (503), never an
admission. A stored value that is not a known class is answered `null` and logged at ERROR.

**What the class does NOT follow (accepted, 2026-11-27).** The class is refreshed only at a
MiConnect sign-in, so an account MiConnect deactivates, or a student who graduates, keeps relay
access for as long as its Canari session lives. No sweep resets it: core-service has none for
deactivated MiConnect accounts (the sign-in handoff asks MiConnect at the moment it hands over, and
nothing else does). This is accepted rather than built: the relay is a pipe to the school's own
mailbox, Partage still demands the person's password, and the school closes the mailbox itself when
the person leaves - so the relay lets nobody read a mailbox they could not already open.

**The rollout state, and why it is not a fallback.** The blueprint applies to MiConnect at a STABLE.
Until then MiConnect grants no `school_mail` (an authentik provider grants only the scopes it has a
mapping for), so every sign-in leaves the class as it is - NULL - and the relay refuses everyone with
403: the mail is simply not offered. That is the EXPECTED state of every estate before that stable, not a degraded path: nothing
substitutes for the missing claim, and the first sign-in after the blueprint applies fills the class.
Dev needs no new secret (the old design needed MiConnect's reader token on dev; it is gone).

**The list is data, written once**: `libs/contracts/mail-domains.json`, `classes` mapping each domain
to its class. Following the repository's contract convention, each side keeps a constant and a test
asserts it EQUALS the JSON: `MAIL_CLASS_BY_DOMAIN` in core-service (`mail-class.spec.ts`) and in the
frontend (`eligibility.test.ts`), `MAIL_CLASSES` in the gateway (`the_classes_are_the_contracts`),
and the blueprint's `SCHOOL_DOMAINS` (`school-mail-claim.test.mjs`). The gateway's Docker build
context does not contain `libs/contracts`, so nothing reads the file at run time.

## The native socket (Tauri)

`frontend/src-tauri/src/commands/mail_socket.rs`: four commands, `mail_socket_open`,
`mail_socket_write`, `mail_socket_close` and `mail_socket_close_all`, to ONE compile-time destination
(`MAIL_HOST`, `MAIL_PORT` = `partage.emse.fr:443`); nothing the page sends names a host. The bytes
cross the IPC raw: the write is an `InvokeBody::Raw` request with the socket id in the
`x-mail-socket` header, the reads arrive on a `Channel<InvokeResponseBody>` as raw bytes, never as
JSON number arrays ([durable-rules](durable-rules.md)). The connect races IPv6 and IPv4
(`happy_eyeballs::connect`, 15 s), and how the socket ended comes on a second channel as a tagged
`MailSocketEnd` (`peer_closed`, `closed_by_page`, `read_failed`, `write_failed`), mapped by
`nativeEnd`. A connection abandoned while its open is in flight closes the socket the moment the open
answers.

**At most `MAX_OPEN_SOCKETS` = 4**, open or connecting, per app - the relay's per-account cap, for
the same reason: a page that leaks connections stops at four instead of exhausting the process. The
fifth open is refused, typed (`TooManySockets`). **A reloaded page cannot reach the sockets of the
page before it**, so the first open of every document first calls `mail_socket_close_all`
(`closePreviousDocument` in `tauriSocketTransport.ts`, once per bridge): it closes every socket and
bumps a generation, so an open still in flight from the previous page is disowned (`Superseded`) and
its socket closed when it lands. Not on a page-load event in Rust: the first open of a document is
the one moment the page is known to hold none.

Eight unit tests (`cargo test --lib mail_socket`), the cap and the close-all of an open in flight
among them. **Compiled only for the Windows desktop target in lot 1**; Android, iOS, macOS and Linux
are compiled by their own CI jobs. **The app's OFF switch for the mail is `mail_mode`** (lot 3,
[below](#the-switch-d12)): off by default, and with it off no page opens a socket.

## The TypeScript layers (`frontend/src/lib/mail/`)

- `transport.ts` - `ByteTransport` (`send`, `close`) and how one ended (`TransportEnd`:
  `peer_closed`, `closed_by_us`, `byte_cap`, `failed`); `MailTransportError` is `unreachable` (could
  not open) or `closed`.
- `relayTransport.ts`, `tauriSocketTransport.ts` - the two implementations; `connect.ts` picks the
  platform's (`platformTransport`) and makes a stream opener (`mailStreamOpener`). The relay's idle
  close (4004) is an ordinary end, `peer_closed`.
- `tlsConnection.ts` - `TlsConnection`: one TLS session over one transport. It resolves once the
  handshake completes; a TLS error sends the alert the engine owes, then closes; `close` sends the
  close_notify, then closes the transport; the WASM session is freed exactly once. Its plaintext
  stream says HOW it ended (`end`): `tls_closed` when the server sent close_notify, otherwise the
  transport's end.
- `http1.ts` - HTTP/1.1 on BYTES: requests serialised one after the other on one connection,
  `Content-Length` counted in bytes, chunked bodies (extensions and trailers included), a body framed
  by the end of the stream, `1xx` skipped. **A body framed by the end of the connection is complete
  ONLY after close_notify** (`tls_closed`); any other end is a truncation, `HttpProtocolError`
  `ended` - otherwise an attacker on the path, or a cut, would hand the client a short body as whole.
  Bodies are capped at `MAX_BODY_BYTES` (64 MiB) and a chunk size at 8 hex digits. A request is
  refused before a byte is sent when its host or path holds CR, LF or a space, its path does not
  start with `/`, a header name is not a token, or it supplies `Content-Length`, `Host`,
  `Transfer-Encoding` or `Connection` itself (the serializer writes those). A connection that the
  server closes, that answered `Connection: close`, or that has bytes left over past an answer, is
  spent; a request on a spent connection is `not_sent` - it never left, so the caller may send it on
  a new connection.
- `soapClient.ts` - `ZimbraSoapClient`: JSON SOAP to `POST /service/soap` over ONE persistent
  connection, opened on first use and reopened when spent. A call is NEVER re-sent: `SendMsg` is not
  idempotent. A fault is a `ZimbraFault` typed by its `Detail.Error.Code` and the HTTP status; the
  fault's `Reason.Text` and an unparsable body are NEVER copied into an error or a log line (server
  prose may carry the user's own data) - a parse failure says only its size and the error's name.
- `eligibility.ts` - `mailClassOf`, the class of an address against the contract (above).

Vitest, with a fake transport, a fake TLS engine and a fake stream (`frontend/src/test/mailFakes.ts`)
across `http1`, `tlsConnection`, `soapClient`, `relayTransport`, `tauriSocketTransport` and
`eligibility`; the device copy of the school address in `auth.miconnectSignOut.test.ts`.

### The end-to-end test

`frontend/src/lib/mail/mail.e2e.test.ts`, SKIPPED unless `CANARI_MAIL_E2E_RELAY` names a running
relay's WebSocket URL, token included. It sends an UNAUTHENTICATED
`{"Body":{"GetInfoRequest":{"_jsns":"urn:zimbraAccount"}}}` twice over one connection and expects
Zimbra's `service.AUTH_REQUIRED` fault (HTTP 500) both times: proof that bytes crossed the relay, the
WASM TLS and the HTTP client to the real mailbox and back, with no credential anywhere. To run it:
`bun run wasm:build`, then a chat-gateway binary with `JWT_SECRET`, `MAIL_RELAY_ENABLED=1`,
`MAIL_RELAY_UPSTREAM=partage.emse.fr:443`, and a `CORE_SERVICE_URL` + `INTERNAL_SECRET` that answer
`{"mailClass":"student"}` on `/api/internal/users/:id/mail-class` (a twenty-line stand-in will do),
and an HS256 token signed with that secret.

**Run 2026-11-27, passed** (before the review fixes and the class route): one connection, two calls,
89 ms; the gateway's end line read
`up 782 bytes (hs=1 ccs=1 alert=0 app=4), down 8116 bytes (hs=1 ccs=1 alert=0 app=6)`.

## Still open

- **The claim reaches MiConnect at a stable**: until then no account is eligible (above). The first
  reading owed after it: one CAS student and one staff account sign in from a client that asks for
  the scope, their `mailClass` is filled; a sign-in from an older client leaves it; an
  Alumni-created account's stays NULL.
- **Lot 3's "Activer le mail" button** (`startSchoolMailActivation`), for the accounts signed in
  before the stable.
- The macOS runner's Homebrew LLVM path for the ring build is written but has not run in CI yet.

## As built - lot 2

Lot 2 is the Zimbra client on top of the pipe: a session, a typed API over every call the screens
of lot 3 will make, and a small store. **Still nothing a user sees**: no route, no tab, no screen
imports it. Every file is in `frontend/src/lib/mail/`.

```
  MailStore (mailStore.svelte.ts)       runes: folders, list, selection, inbox badge, D1
      |
  MailApi (mailApi.ts)                   folders, lists, read, actions, send, drafts, files, directory
      |                                  builders: zimbraRequests.ts   parsers: zimbraParse.ts
  MailSession (mailSession.ts)           the token, its renewal, D7 classification, D8
      |            \
      |             sealedMailPassword.ts (D6)   mailLocalData.ts (D8 allowlist)
  ZimbraSoapClient (lot 1) - call() for SOAP, exchange() for the upload servlet and downloads
```

### The session (D6, D7, D8)

`MailSession` holds the Zimbra token in its own memory and nowhere else. It is built with the SOAP
client and a `MailContext` - the Canari account id, a getter for the session's device key, and
`mailAddress()`, the account's OWN school address. It is wired in ONE place,
`canariMailContext(userId, deviceKey)` (`mailContext.ts`), whose `mailAddress` is lot 1's
`schoolMailAddress()` (`stores/auth.ts`); the session itself reaches into no session module.

- **The sign-in asks ONLY the password** (owner, 2026-11-27): `signIn(password, remember)` takes the
  address from `mailAddress()` - the `school_mail` claim MiConnect named at the Canari sign-in, kept
  client-side by lot 1 - never from what a user typed. No address is `address_unknown`. **D1 comes from that same address**
  (`MailSession.eligibility()`, `MailStore.loadEligibility()`): the tab's verdict before any mail
  sign-in, not a relay refusal.
- An address `mailClassOf` (lot 1's `eligibility.ts`, held to `libs/contracts/mail-domains.json`) gives no class is refused BEFORE a byte is sent (`not_eligible`); then `AuthRequest`, then `GetInfoRequest`, whose canonical
  address is checked again (an alias may differ from what was typed - an ineligible one ends the new
  session on the server and is refused). The renewal does the same before ANY byte: the remembered
  entry's address must be `mailAddress()`'s, and eligible - one for another address is removed.
- **A sign-out cannot be undone by an `await` in flight: the session EPOCH.** `signOut()`, a new
  `signIn()` and the erasure of a closed account bump it; a sign-in or a renewal captures it and
  re-checks it after every `await`. A token that comes back for an older epoch is ended on the server
  (`EndSessionRequest`) and never installed, and the call throws `not_signed_in`. The remembered
  write is gated too: `rememberMailPassword(..., stillWanted)` checks the epoch synchronously between
  the seal and `setItem`, inside the storage gate, so a sign-out that ran while the write waited
  behind a device-key change is not overwritten by it. Tested with the `AuthRequest` held, and with
  the write held behind `holdStorageForKeyChange`.
- A sign-in over a live session ends the session it replaces on the server. A password that cannot be
  stored (no device key, a storage that throws) still ends `ready`, typed `remembered: false` - never
  a session half open.
- **Renewal is driven by the server's answer, never a clock.** The token lasts about two days
  (measured) and the `lifetime` Zimbra sends is NOT read. A call answered `service.AUTH_EXPIRED` or
  `service.AUTH_REQUIRED` renews the session from the remembered password and is sent ONCE more: a
  fault is a refusal before the call ran, so the resend cannot do it twice (a connection lost
  mid-call is still never re-sent - lot 1's rule). Calls that saw the same token end share ONE
  renewal (a single promise; a call whose failure arrives after it finds the newer token and uses
  it). A renewal the network failed keeps the old token, so the next call is refused again and
  renews again - driven by that answer. A renewal that cannot succeed drops the token and the state
  asks for the password, saying why (`PasswordAskReason`: not remembered, refused by the server,
  unopenable under this device key, device locked, or `session_refused` - the server refused the
  token the renewal had just issued). In `needs_password`, a call throws `session_expired` at once and
  sends nothing: there is nothing to renew with. `resume()` goes through the same single renewal.
- **A remembered password the server refuses is FORGOTTEN at once** (`account.AUTH_FAILED` or
  `account.CHANGE_PASSWORD` at a renewal): a stale password replayed at every renewal would lock the
  school account.
- **Sign-out** drops the token and forgets the password before its first `await`, then sends
  `EndSessionRequest`, then closes the connection.

#### D6 - the remembered password, sealed under the device key

`sealedMailPassword.ts` is the backup recovery code's model, reused rather than reinvented
([auth](frontend/modules/auth.md#what-the-device-key-seals-and-what-a-pin-change-does-with-each)):

- the seal is `sealBytes` (AES-256-GCM, fresh IV) under the session's device key - on a phone the
  random key the hardware keystore holds, on the web and the desktop the PIN-derived key;
- the plaintext is `{userId, account, password}`: it opens only for the Canari account that sealed
  it, and a password is never tried against another mailbox;
- an entry the device key cannot open (or this build did not write) is REMOVED, at a renewal and in
  the re-seal of a key change: nothing will ever open it, and it is asked for again;
- the entry is `localStorage` `ACCOUNT_KEY.mailSealedPassword(userId)` - ciphertext only, never the
  password in the clear - written and read INSIDE the storage gate (`withDeviceKeyHeld`,
  `liveDeviceKey`), so a key change running meanwhile either re-seals it or is already done;
- every device key change re-seals it beside the stores (`moveRememberedMailPassword` in
  `pinChange.ts`, at both call sites of `moveDeviceRecoveryCode`), idempotently, and NEVER fatally:
  a password that could not move costs one password prompt, not a half-moved key change;
- the account deletion sweeps it (`exactKeys` in `accountLocalKeys.ts`).

Unticked, nothing is written and any earlier entry is removed: the token lives in memory only and
the password is asked again when it lapses.

**Offered everywhere, with no warning (owner, 2026-11-27, the review's I2).** The exposure: on the
web and the desktop the device key is derived from the PIN, so a stolen `localStorage` lets the
sealed password be guessed OFFLINE against the PIN; on a phone the key is the hardware keystore's.
The owner keeps "remember the password" on phones, web and desktop alike, with no warning: the ENT
sign-in itself requires a second factor, and this is no worse than a browser remembering the
password or keeping a session cookie. Measured on Partage: `AuthRequest` accepts the password ALONE,
no second factor - so on the web and the desktop the mailbox itself is protected by the PIN only.

#### D7 - the typed errors

`mailErrors.ts`: `classifyMailFailure` turns what a lower layer threw into ONE `MailError` by CLASS
and CODE, at the one seam every call goes through. The screens switch on `kind`.

| `kind` | From | What the session does |
|---|---|---|
| `bad_credentials` | `account.AUTH_FAILED` | at a renewal: forgets the remembered password, asks for it |
| `password_change_required` | `account.CHANGE_PASSWORD` | the same |
| `account_closed` | `account.NO_SUCH_ACCOUNT` answered to the session's OWN `AuthRequest` or `GetInfoRequest` (`FaultOrigin` `auth`) | D8 erasure, state `closed` |
| `account_unavailable` | `account.ACCOUNT_INACTIVE` (Zimbra's code for a locked or pending account too) | drops the token, state `unavailable`, NOTHING erased; the next `resume()` tries again |
| `maintenance` | `account.MAINTENANCE_MODE` | nothing: temporary, nothing erased |
| `session_expired` | `service.AUTH_EXPIRED`, `service.AUTH_REQUIRED`, HTTP 401 on upload/download | one renewal, one resend; if that fails, asks for the password |
| `not_found` | `mail.NO_SUCH_MSG` / `_CONV` / `_FOLDER` / `_ITEM` / `_PART` / `_UPLOAD`, `account.NO_SUCH_ACCOUNT` on any other call (it names ANOTHER account), HTTP 404 | - |
| `invalid_query` | `mail.QUERY_PARSE_ERROR`; a reader query whose parentheses do not balance, refused before sending | - |
| `not_sent` | lot 1's `HttpProtocolError` `not_sent`: the connection was spent before the request's turn | nothing; the request was never sent, so sending it again is safe, `SendMsg` included |
| `incompatible` | lot 1's `MailTlsError` `incompatible`: a TLS this build cannot speak | nothing; permanent until an update |
| `too_large` | `mail.MESSAGE_TOO_BIG`, `mail.UPLOAD_REJECTED`, HTTP or servlet 413 | - |
| `quota_exceeded` | `mail.QUOTA_EXCEEDED` | - |
| `address_unknown` | the account's identity carries no address | refused before sending |
| `not_eligible` | an address `mailClassOf` gives no class (D1) | refused before sending |
| `not_signed_in` | a call with no token | - |
| `transport` | `MailTransportError`, `MailTlsError` (other kinds), `MailTlsLoadError`, `HttpProtocolError` (other kinds) | - |
| `server` | any other fault code, an unreadable answer, an answer missing what the call is for | - |
| `internal` | a throw no layer typed - logged as a defect | - |

#### D8 - a closed account

`account_closed` - `account.NO_SUCH_ACCOUNT` answered to the session's OWN `AuthRequest` or
`GetInfoRequest`, and nothing else (the same code on another call names another account) - erases
`mailLocalKeys(userId)` - an explicit allowlist, today the one sealed-password key, never a prefix -
and nothing else on the device, then sets the state `closed`; `MailStore` empties itself on that
state. `account.ACCOUNT_INACTIVE` is NOT a closure: it also covers a locked or pending account, so
it erases nothing (`account_unavailable`).

**The erase waits for a probe on Partage.** Which code Partage answers for a deleted account is not
measured (no closed account was available). Zimbra may answer `account.AUTH_FAILED` to the
`AuthRequest` of an account that no longer exists, so as not to say it existed: then a closed account
looks like a refused password - the remembered password is forgotten and asked for, but the D8
erasure of other mail data would not run. Today the allowlist holds only that password, so the
outcome is the same; a lot that persists mail must settle it on Partage first. `resume()` leaves a closed
mailbox closed: only a new sign-in reopens one. **A lot that persists mail adds its key to
`mailLocalKeys`**, and `mailLocalData.test.ts` asserts the list.

### The API (`mailApi.ts`)

One or two calls through the session per method, returning the small types of `mailTypes.ts`
(Zimbra's abbreviations are read in `zimbraParse.ts` only):

- `folders()` - the tree under the root, mail views only, system roles by Zimbra's fixed ids (2
  inbox, 3 trash, 4 junk, 5 sent, 6 drafts); `u` absent is 0 unread.
- `conversations(...)` / `messages(...)` - `SearchRequest` newest first, paged by `offset`/`limit`,
  `more` read; the folder is named by ID (`inid:"2"`, quoted by `quoteSearchValue`, never a
  localised name) and the reader's query is ANDed in parentheses - refused as `invalid_query` when
  its own parentheses do not balance outside quotes, so a `)` cannot close the folder's scope. A
  screen that builds a term from text (`subject:...`) quotes it with `quoteSearchValue`.
- `conversation(id)` (`GetConv`, `fetch: 'all'`, `html: 1`), `message(id)` (`GetMsg`, `html: 1`):
  the defanged HTML (D9 still sandboxes it in lot 3), the text, attachments and inline images.
- `act(target, op, ids, ...)` - ONE `MsgAction` / `ConvAction` for every id (bulk), ops `read`,
  `unread`, `flag`, `unflag`, `move` (`l`), `trash`, `spam`, `not_spam`, `delete`. A conversation
  action carries Zimbra's target constraint `tcon`: it leaves alone the messages in Trash, Junk,
  Sent and Drafts unless that is the folder listed (the webmail's rule).
- `send(...)` / `saveDraft(...)` - `multipart/alternative` when there is HTML, uploads by `aid`,
  existing parts by `mid` + `part`, reply/forward by `origid` + `rt` + `irt`, the draft deleted on
  send (`did`) or overwritten on save (`id`). Every `OutgoingMessage` carries its own `suid`
  (`crypto.randomUUID()` when it is created), sent with `SendMsg`: Zimbra will not send one `suid`
  twice, so a second press or a resend cannot send the message twice.
- `upload(...)` / `download(...)` - plain HTTP on the SAME connection (`ZimbraSoapClient.exchange`,
  added in this lot): `POST /service/upload?fmt=raw,extended` and
  `GET /service/home/~/?auth=co&id=..&part=..`, both with the `ZM_AUTH_TOKEN` cookie. The filename
  goes in `Content-Disposition` with every non-ASCII character, `"`, `&` and `\` as an HTML numeric entity
  (the webmail's own encoding; measured to round-trip `é`).
- `directory(text)` - `AutoCompleteRequest` with the school directory (`includeGal`).

`mailCompose.ts` prefills reply, reply-all and forward: the recipients (Reply-To first, the
original's recipients when the account sent it, never the account itself - its address AND its
`zimbraMailAlias` aliases, read by `GetInfo` - no duplicates), `Re:` / `Fwd:` (not translated, as in
every client; never doubled), the quote in text (`> `) and in HTML (`<blockquote type="cite">`), and
every attachment of a forward by reference. The quoted HTML is ALWAYS rebuilt from the text,
escaped - never the server's HTML, whose `dfsrc` remote images and markup would travel on under the
account's name. The attribution line
and the forwarded header are Paraglide strings (`mail_quote_attribution`, `mail_forward_*`).

### The store (`mailStore.svelte.ts`)

`MailStore` (Svelte 5 runes, memory only): the session state, the folder tree, the folder listed
and its search, the conversations (every page loaded, de-duplicated across pages), `hasMore`,
`loading`, the last typed `error`, the selection, and two derived values - `inboxUnread` (the D10
badge) and `eligibility` (D1, from the address the session names: `unknown` / `eligible` /
`not_eligible`). A list answer is applied only to the list it was asked for: every open bumps a
generation and an older answer is dropped. `act()` sends ONE call for the selection; an answer that
arrives after the list changed is not applied. A row leaving the folder or a flag is applied in
place; `read` / `unread` re-read the listed rows from the server instead of guessing their counts.
Then the folder counts reload - a reload failing after a reset is ignored, not shown. A sign-out or a closed account empties it.

### Tests

Vitest, with `FakeZimbra` (`frontend/src/test/mailFakes.ts`: a fake mailbox at the HTTP level over
lot 1's `FakeStream`): every builder (`zimbraRequests.test.ts`) and parser (`zimbraParse.test.ts`),
every fault to its kind (`mailErrors.test.ts`), the session - the renewal exactly once for three
calls that saw the token end, the refused password forgotten, the network-failed renewal retried by
the next answer, D8 erasing only its allowlist, maintenance erasing nothing, the sign-out order
(`mailSession.test.ts`) - the API's bulk actions, upload and download with their renewal
(`mailApi.test.ts`), the seal and its move by a key change (`sealedMailPassword.test.ts`), the
allowlist (`mailLocalData.test.ts`), the composer (`mailCompose.test.ts`) and the store
(`mailStore.svelte.test.ts`).

#### The end-to-end test of lot 2

`frontend/src/lib/mail/mailApi.e2e.test.ts`, SKIPPED unless `CANARI_MAIL_TEST_TOKEN_FILE` names a
JSON file `{ "authToken", "account" }` - a session TOKEN of the test account, never a password,
never committed. It reads `GetInfo`, `GetFolder`, a search restricted to
`subject:"[test Canari]"`, and one search of 500 messages over the whole mailbox whose answer must
exceed 64 KiB - of which only the count and the byte length are read (no real mail is read). With `CANARI_MAIL_TEST_SEND=1` it uploads a small
attachment with a non-ASCII name, sends ONE mail to the account ITSELF (subject
`[test Canari] ...`), reads it back and downloads the attachment. The transport is the relay when
`CANARI_MAIL_E2E_RELAY` is set, otherwise a plain TCP socket from the test process to
`partage.emse.fr:443` (the TLS is still the WASM's). Needs `bun run wasm:build`.

**Run 2026-11-27, passed** (Windows workstation, direct socket): read-only in 5.5 s, then with the
send in 4.1 s - the upload's entity-encoded filename, the send with HTML and an attachment, `GetMsg`
of the sent copy and the attachment download all round-tripped. **Rerun 2026-11-27 on lot 1's
fixes merged** (WASM rebuilt, direct socket, read-only): passed; the large search answered 500
messages in 242,732 bytes (about 237 KiB), framed whole through the WASM TLS and lot 1's HTTP/1.1.

### Still open after lot 2

- ~~**Archive**~~ decided in lot 3: "Archiver" moves to a root-level folder named `Archives`,
  created on first use ([below](#archiver)).
- **A mail cache at rest** does not exist yet: everything but the sealed password is in memory. A
  lot that adds one adds its key to `mailLocalKeys` (D8) and decides whether it is sealed under the
  device key (and then re-sealed by a key change).
- **The closed-account answer is not measured on Partage** (see D8): `account.NO_SUCH_ACCOUNT` to
  the session's own sign-in is Zimbra's documented code, but Partage may answer `AUTH_FAILED`. A
  lot that persists mail probes it before relying on the erasure.

## As built - lot 3

Lot 3 is what a user sees: the Mail tab, its screens, the HTML sandbox (D9) and the server switch
(D12), on top of lot 2's session, API and store - nothing of the data layer is duplicated. The
screens follow the mockups the owner validated on 2026-11-27 (Gmail-like rows, a compose button on
the phone, swipes, long-press selection, a folder drawer, three panes on a desktop).

### The switch (D12)

`platform_config.mail_mode` (`off` | `on`, default `off`, migration
`apps/core-service/src/migrations/033_platform_config_mail_mode.sql`), set from the admin's platform
page and served by `/api/version` as `mail.mode`, like `calls_mode`
([core-service](services/core-service.md)). The client reads it through `serverMailMode()`
(`stores/appVersionCheck.svelte.ts`); `utils/mailModesAgree.test.ts` holds the two lists of modes
equal. **Off, nothing of the mail runs**: no client is built, no socket opened, the tab is not drawn,
and `/mail` says the mailbox is not open yet.

### The tab (D10)

`navigation/places.ts` carries a `mail` place with `gate: 'mail'`: `shownPlaces(places, gates)` and
`mobileNavPlaces(gates)` drop a gated place whose gate is shut, and the three bars (`BottomNav`,
`NativeTabBar`, `AppSidebar`) draw from them, so they cannot disagree. The gate is
`mailTabVisible()` (`mail/mailClient.svelte.ts`): the switch is `on`, AND the account's eligibility
has been READ (`MailClient.eligibilityRead`, so the tab is never drawn and then withdrawn), AND it is
not `not_eligible` - an eligible address, or no address yet (see below). Its badge is
`MailStore.inboxUnread` (`placeBadge.svelte.ts`). `/mail` is not in `MOBILE_SWIPE_PLACES`, so the
tab swipe never fights the row swipes, and it is a private prefix for robots
(`seo/resolve.ts`). The [section navigation](frontend/section-navigation.md) is unchanged otherwise.

`watchMailTab()` runs once per document (the bars call it): for the signed-in account with the
switch on, it builds the account's ONE `MailClient` (`mailClientFor`, which ends a previous
account's client first), reads its eligibility and, when eligible, resumes the session from a
remembered password so the badge has a count.

### The address, and "Activer le mail"

The session is built with lot 2's `canariMailContext(userId, deviceKey)` (`mail/mailContext.ts`),
whose address is lot 1's `schoolMailAddress()` - MiConnect's `school_mail` claim, never typed. The
sign-in (`MailSignIn.svelte`) shows the address read-only and asks for the password and "Retenir"
(ticked by default, on every platform, no warning - D6).

**No address is the ordinary state before rollout**: an account signed in before the claim existed
gets it only at its next full MiConnect sign-in. The screen then says so in plain words
(`mail_error_address_unknown`, drawn as information, not as an alert) and offers ONE button,
"Activer le mail", which calls lot 1's `startSchoolMailActivation('/mail')` (`stores/auth.ts`): the
MiConnect sign-in again, back to `/mail`. **The tab is shown in that state on purpose** (lead,
2026-11-27): it is how the reader reaches the button.

### The screens (`frontend/src/lib/components/mail/`)

| Component | What it draws |
| --- | --- |
| `MailScreen` | the state machine: sign-in, closed or unavailable account, or the mailbox - ONE column below `xl` (list, the conversation in its place, the folders in a drawer, the compose button), THREE from `xl` (folders, list, conversation), chosen by `overlayLayout()` so the column not drawn is not mounted |
| `MailList`, `MailRow` | search, filter pills (`all`, `unread`, `flagged`, `attachment` - Zimbra terms, `mailFormat.ts`), pull to refresh, paging on `nearViewport`, the row's avatar (a tap selects), long-press to select, swipes |
| `MailActionBar` | the selection bar (archive, trash, read or unread, more) and the conversation's bar |
| `MailFolderList` | system folders with unread counts, "Suivis" (`is:flagged` over the whole mailbox), "Archives", the user's folders; never a half list - no row before the tree first loads (a failed mailbox says so there), the last known tree kept when a refresh fails |
| `MailThread` | the conversation, oldest first: the newest open, earlier ones folded, beyond three a "N messages plus anciens" pill; marked read as it opens (through the store, so the badge follows); attachments downloaded with `saveBlobAs`; reply, reply all, forward |
| `MailCompose`, `MailRecipientField` | to/cc/bcc chips with the directory's suggestions (`MailApi.directory`, a request counter so a late answer never replaces a newer one), attachments uploaded as attached, sent as plain text through lot 2's `mailCompose.ts`; closing with content saves a draft |
| `MailHtmlFrame` | D9, below |
| `MailStatePanel` | every state: an error is an `alert` with "Réessayer" only when `mailErrorRetryable`, anything else a `status` |

Every typed failure has its sentence (`mail/mailErrorText.ts`, a `Record` over `MailErrorKind`, so a
new kind fails the build): `not_sent` is retryable (the request never left), `incompatible` is not
(an update is needed). An action is ONE call for every id (`MailStore.act`); its failure is a toast in
the reader's words.

#### Archiver

`MailStore.archive(ids)` moves to the root-level user folder named `Archives` (`isArchiveFolder`:
no role, no parent, the name case-insensitive), CREATED on first use with `CreateFolderRequest`
(`fie: 1`, so a folder made meanwhile elsewhere is returned rather than doubled). A folder the
school's webmail user already made is reused. `parseCreatedFolder` gives a folder created under the
root `parentId: null`, as the tree does.

#### The gestures (`mail/mailGestures.ts`)

Arithmetic the row only paints: a swipe RIGHT archives, LEFT trashes; nothing to archive in the
archive folder, nothing to trash in the trash or junk (deleting for good is a press, never a slip).
The direction is decided once under the reply swipe's measured slop (`REPLY_SWIPE_LOCK_PX`); a
vertical stroke is the list's scroll. Past 96 px letting go acts; the row stops following at 160 px.
The touch listener is non-passive only on a coarse pointer.

### D9 - the HTML sandbox (`mail/mailHtml.ts`, `MailHtmlFrame.svelte`, `security/mailFrameScript.js`)

**Redesigned after the independent security review (lead, 2026-11-27).** A first idea - granting
`allow-same-origin` so the app could measure the frame - was REFUSED: it joins the mail's document
to the app's origin (the MLS keys, the sealed mail password), makes a same-site image load carry
the app's cookies, and sizing from `scrollHeight` loops without end on a `min-height: 100vh` or
`height: 150vh` mail. ONE mechanism now does the sizing AND the links. Layers, none trusted alone:

1. **The frame**: `<iframe sandbox="allow-scripts" srcdoc>` and nothing else - an OPAQUE origin
   (never `allow-same-origin`), no popup, no top navigation, no form. `allow-scripts` is for OUR
   one script.
2. **A CSP `<meta>`** in the frame's own head: `default-src 'none'; script-src 'sha256-<our
   script>'; img-src data: [https: after "Afficher les images"]; style-src 'unsafe-inline';
   font-src data:; form-action 'none'; base-uri 'none'`. A script of the mail revived past the
   cleaning pass is
   refused by the hash. A `srcdoc` frame also inherits its parent's policy, so the SAME hash is in
   the web page's (`WEB_POLICY_DIRECTIVES` in `security/cspDirectives.js`, which nginx's
   `csp.conf` in `infrastructure/local/Dockerfile.frontend` must equal) and the native WebView's
   (`tauri.conf.json`, `csp` and `devCsp`). The hash is written ONCE as a value
   (`MAIL_FRAME_SCRIPT_HASH`, next to the script's text); `mailFrameScript.test.ts` computes it
   from the text and fails, naming the new one, if any of the four disagrees. **The page's own
   `frame-src 'self'` is LOAD-BEARING for the mail frame** (second review, I-3): the frame is a
   frame of the app's page, so a change of that directive (web or Tauri) decides whether the mail
   is drawn at all, and must be re-read against `MailHtmlFrame` on every platform -
   `mailFrameScript.test.ts` holds it to `'self'`.
3. **A cleaning pass** over an inert `DOMParser` document: scripts, frames, plugins, forms,
   `base`/`meta`/`link` removed; every `on*` attribute, `ping`, `target` and `autofocus` removed.
   **EVERY
   `href`, on any element, by local name** (SVG `<a>`, `area`, `xlink:href` - review I1) is
   removed: a link's `https:`/`http:`/`mailto:` address (`isSafeMailLink`) moves to
   `data-mail-href` (with `role="link"`, `tabindex="0"`), anything else is dropped. An SVG
   `<image>` keeps its source only through the image rules. **Viewport-height lengths** (`vh`,
   `dvh`, `svh`, `lvh`, `vmin`, `vmax`) in style attributes and sheets become pixels (1vh = 8px),
   so a length cannot grow with the frame it sizes.

**Our script** (`MAIL_FRAME_SCRIPT`) posts two messages to the parent:
`{type:'mail-frame-height', h}` - the CONTENT's height, when it changed - and
`{type:'mail-frame-link', href}` when a `data-mail-href` element is clicked or gets Enter (a held
key's `repeat` ignored, M-1). **The height is read at a zero-height marker the script keeps last in
the body** (plus the body's bottom padding, border and margin), never from the html or body boxes:
those follow the frame's own height, and `html,body{height:100%} body{padding-bottom:1px}` made a
box measure grow the frame by one pixel a round up to the cap (second review, I-1). It is measured
on load, on every resource load (a capturing `load` listener - a body of fixed height does not
resize when an image arrives) and on a resize of the root or body. The
parent (`MailHtmlFrame`) accepts a message ONLY when `event.source` is its own frame's window, and
only in the two shapes `mailFrameMessages.ts` reads (a finite height; an address `isSafeMailLink`
accepts again). The height is drawn as is, CAPPED at 20000 px (`MAIL_FRAME_MAX_HEIGHT_PX`; beyond
it the frame scrolls inside, and the cap is logged): the cap is what proves the sizing ends,
whatever the mail's CSS. A link goes through `openExternal(href, { siteHandoff: false })` - the
app's ONE link path, Safe Browsing gate included, but NEVER the sibling-site sign-in handoff
(`openEcosystemSiteLink`): a mail is written by anyone on the internet (second review, I-2). The same
address pressed again while it is still opening is dropped - one gesture, opened once (M-1, an
in-flight marker, no clock). **A `mailto:` link opens Canari's own composer** (decided, lead
2026-11-27, M-6): `mailtoMessage` (`mailCompose.ts`) parses it by RFC 6068 by hand (`+` stays a
plus), keeps `to`, `cc`, `bcc`, `subject` and `body` only - a stranger's link chooses no sender,
reply-to or attachment - and only plain addresses; no Safe Browsing lookup and no `window.open`.
`window.open`'s `null` is NOT read as a failure (second review, M-2, not applied): with
`noopener` the HTML spec returns `null` even when the tab opened, so it cannot tell a blocked popup
from an opened one, and logging it would accuse every success.
Checked in headless Chrome on the preview: the frame reported its height, and a real click on the
gala mail's link opened it through `openExternal` in a new tab, the frame navigating nowhere.

**Remote images are blocked by default** (charter principle 3: a tracking pixel tells the sender
when and where the mail was read). `remoteImageCount` counts them - Zimbra's defanged `dfsrc`,
backgrounds and SVG images included - and "Afficher les images" adds `https:` to `img-src` for THAT
message only; an `http:` image is fetched as `https:` (review M1). **`cid:` images resolve only from
the message's own parts**: the reader downloads the inline parts it carries and passes them as data
URLs; a `cid:` it does not carry stays empty. A part is drawn inline only when it is an image
(`isImageMediaType`, which parses the media type off its parameters - review M3) with a
`Content-ID`, up to 5 MiB (`isInlineImagePart`, review M4); every other part, a bigger image
included, is listed as an attachment, so each part is either drawn or downloadable.

**The frame is drawn once its document is final, and each document is a new frame.** Drawn at once
and given the resolved `cid:` images a moment later, Chrome kept the FIRST document on screen - the
inline logo of the preview stayed broken although the frame's `srcdoc` held its data URL, and
setting the same `srcdoc` again showed it. So `MailHtmlFrame` waits until THIS message's inline parts
are settled (loaded or failed: `inlineFor === inlineKey`, which also keeps a previous message's
images from ever being used), and a new document ("Afficher les images") replaces the element
(`{#key}`) rather than navigating it in place. A download that never settles leaves the pending
state drawn and is logged after 15 s - a log, never a cut: no clock decides the document.

The frame's own default style (`mailFrameDocument`) has LITERAL values, not the app's tokens: the
frame is another document, which `app.css` never reaches, and a mail is written for a light page,
so the frame stays light in the dark theme.

**An attachment is saved under a bare basename** (`attachmentFileName`, review I4 and M-3):
directory parts, `:`, the characters Windows reserves (`<>"|?*`), control characters, the
bidirectional controls (U+202A-202E, U+2066-2069, U+200E/F - `exe.pdf` drawn as `fdp.exe`), leading
dots and trailing dots or spaces are removed before `saveBlobAs`.

### The sign-out

`auth.ts`'s `clearAuthUnderway` (every Canari sign-out: by choice, expiry, revocation) calls
`endMailOnSignOut(reason, leavingUserId)` (`mail/mailSignOut.ts`), which runs the sign-out the
current `MailClient` registered - `MailSession.signOut()`: the token dropped, the remembered
password forgotten, the server told. **The leaving account's sealed mail password is forgotten
FIRST, in every case** (`forgetMailPassword`, review I3 and M-4): before any await, so a server that
does not answer cannot leave it behind, and whether or not this visit built a client - a password
sealed in an earlier visit is on the device either way. It never throws. `auth.ts` does not import
the mail client's graph. An account switch ends the previous client too (`mailClientFor`).

**The server's switch turned off** (`followMailSwitch`, review M5) ends the in-memory client and
the server session, but **KEEPS the sealed remembered password** (decided, lead 2026-11-27, M-5):
the switch is a kill switch, not the reader's choice to forget, so the mailbox resumes when it is
turned back on. Only a reader's sign-out of the mailbox, a Canari sign-out or D8 forget it
(`MailSession.signOut({ keepRemembered: true })` is the switch's alone).

### The dev preview

`/dev/mail-preview?view=` (`inbox`, `thread`, `html`, `compose`, `folders`, `selection`, `signin`,
`pending`, `error`) runs the real `MailScreen`, client, session, API and store over an INVENTED
mailbox (`src/test/mailPreview/mailDemoMailbox.ts` - every name and message made up - answering
through the tests' `FakeZimbra`). `+page.ts` answers 404 outside `vite dev`, and the preview is
imported behind `import.meta.env.DEV`, so no build contains it; `isSignedOutPath` lets `/dev/*`
through the sign-in guard under the same constant. The colours in its demo mails are the mails'
own (another document, out of the tokens' reach).

### Tests

`mailHtml.test.ts` (only our script survives; remote images blocked, then allowed and upgraded;
`cid:` from the message's own parts only; every link inert, SVG and `xlink:href` included, unsafe
schemes and `fr.emse.canari://` dropped; viewport units; media types; the inline cap),
`mailFrameMessages.test.ts` (the two shapes, the cap), `security/mailFrameScript.test.ts` (the hash
is the text's, and the same in the frame's, the web page's, nginx's and Tauri's policies),
`mailGestures.test.ts`, `mailFormat.test.ts` (including the saved filename),
`mailErrorText.test.ts` (every kind said, which ones retry), `mailSignOut.test.ts` (the password
forgotten with no client registered), `mailClient.svelte.test.ts` (the switch turned off ends the
client), the store's archive (created once at the root, reused) and whole-mailbox list,
`CreateFolder`'s request and answer, the gated places (`bottomNavNames.test.ts`), and the
components `MailSignIn` (no address field; the pending state and its button), `MailStatePanel` and
`MailHtmlFrame` (no frame before the inline parts settle, then ONE carrying them; a failed part
still draws it; allowing images is a new frame; the sandbox is `allow-scripts` alone; height and
links accepted only from its own frame, the height capped; a link opened without the handoff and
once per gesture; a `mailto:` to the composer). After the second review: the frame script run
against stand-ins (the content measured, so a frame grown one pixel a round reports nothing new; a
held Enter sends one link), `frame-src 'self'` held, `mailtoMessage` (`mailCompose.test.ts`),
`openExternal`'s `siteHandoff: false` (`openExternal.test.ts`), the password forgotten before the
server is told, and kept by the switch (`mailSession.test.ts`, `mailClient.svelte.test.ts`).

### Still open after lot 3

- **Links on a phone**: the path is `openExternal` on every platform now (no WebView default), but
  it has not been pressed on a device yet.
- **A v1 LIMIT, decided (lead, 2026-11-27): the composer sends plain text.** A reply quotes the
  original as `> ` lines; an HTML composer is not built in v1.
- **No reading on a phone yet**: the screens were seen only in the dev preview (headless Chrome).
