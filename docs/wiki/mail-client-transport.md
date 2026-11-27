# The mail client's transport - as built, lot 1

**What this page is.** The design of the school mailbox in Canari is `docs/wiki/mail-client.md`
(lot 0, decisions D1-D12; pull request #4193 at the time of writing - once it is merged this page's
references to it become links). This page is what lot 1 BUILT of it: the pipe that carries bytes
from a Canari client to `partage.emse.fr` and back, with TLS ended IN THE CLIENT (D3), so no Canari
server ever holds a mail password, a session token or a message. **Nothing in lot 1 is visible to a
user**: no tab, no string, no route a page calls. Lot 2 builds the session on top of it.

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
`certificate`, `peer_alert`, `protocol`, `closed` - and the TypeScript side reads the kind, never the
message (`asMailTlsError`; anything else is `internal`).

It is built exactly like `mls-wasm` and, like it, NOT committed: `bun run wasm:build` builds both
(`wasm-pack build mail-tls --target web --out-dir ../src/lib/wasm/mail-tls`, after `mls-wasm`, whose
out-dir is the parent), the CI action `.github/actions/build-mls-wasm` builds and verifies both, and
`frontend/src/lib/wasm/` stays gitignored ([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)).
The page loads it with a DYNAMIC import (`loadMailTlsEngine`), so the module and its binary are their
own chunk, fetched when the first mail connection is made and never by a page that does not open one.

**Its size, measured 2026-11-27:** `mail_tls_bg.wasm` is 561,849 bytes, 260,753 gzipped (`-9`),
release profile `opt-level = "z"`, LTO, one codegen unit, `panic = "abort"`. About a quarter of
`mls_wasm_bg.wasm` (2.48 MB).

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

Eight, against an in-process rustls server with an `rcgen` certificate: the ClientHello carries the
SNI; a full handshake carries plaintext both ways; an untrusted root, another root and a wrong name
are each refused as `certificate`; non-TLS bytes are `protocol`; the peer's close_notify is seen and a
write after `close` is refused; the error codes are distinct.

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

**Its caps, in one place** (constants at the top of `mail_relay.rs`):

| Cap | Value | When reached |
|---|---|---|
| connections per account | 4 | 503 before the upgrade |
| connections in all | 400 | 503 before the upgrade |
| bytes per connection, both ways | 256 MiB | closed with code 4001 |
| one client frame | 1 MiB | refused by the WebSocket layer |
| upstream TCP connect | 10 s | 502 |
| eligibility question | 12 s | 503 |

**How it ends, by close code** (`close_code`, read by `relayEnd` in `relayTransport.ts` - the CODE,
never the reason text): 4000 the upstream closed, 4001 the byte cap, 4002 the upstream failed, 4003 a
non-binary frame. **One line per connection end**, never one per frame: the account (8 characters of
its id), the duration, the bytes and the record counts each way, and why it ended. An ordinary end
(the client or the upstream closed) is INFO; a cap or a fault is WARN - the level depends on how the
socket ended, as for `/api/ws` ([chat-gateway](services/chat-gateway.md#how-a-socket-ended-and-why-the-level-of-the-line-depends-on-it)).
A repeated refusal is counted rather than repeated.

**It is OFF unless switched on** (`MAIL_RELAY_ENABLED`, D12), and nginx carries it through a
`location = /api/mail/relay` with the same lines as `/api/ws` (`infrastructure/local/Dockerfile.frontend`).

Its tests (`apps/chat-gateway/src/mail_relay/tests.rs`, 19): the upstream parser and the switch, the
contract equality below, eligibility answers from a fake core, record counting across split frames,
the place caps, and served-route tests against a local TCP echo - bytes piped both ways, ineligible
403, unknown 503, off 404, no token 401, foreign origin 403, the account cap and its place given
back, the byte cap closing with 4001, a text frame closing with 4003, the upstream closing with 4000,
a refused connect 502.

### Eligibility

**D1: the mail tab is for an account whose MiConnect address is on `etu.emse.fr` or `emse.fr`,
exactly.** Canari stores NO e-mail address - the sign-in carries none by design - so the relay asks:

```
chat-gateway --GET /api/internal/users/:id/mail-domain (X-Internal-Secret)--> core-service
core-service --MiconnectReaderClient.findAccount(miconnectUuid), read-only reader token--> MiConnect
core-service --> { "domain": "etu.emse.fr" } | { "domain": null } (inactive) | 404 | 503
```

`apps/core-service/src/internal/internal-mail.controller.ts` hands back the DOMAIN only, never the
address; an account whose MiConnect identity does not match its row is a 409, logged as an error. The
gateway admits on `domain` in `MAIL_DOMAINS`; 404 or a null domain is ineligible (403); anything else
- core unreachable, a 5xx, a malformed answer - is UNKNOWN, a 503, and never an admission.

**The list is data, written once**: `libs/contracts/mail-domains.json`. Following the repository's
contract convention, each side keeps a constant (`MAIL_DOMAINS` in `mail_relay.rs` and in
`frontend/src/lib/mail/eligibility.ts`) and a test asserts it EQUALS the JSON - the gateway's Docker
build context does not contain `libs/contracts`, so nothing reads the file at run time.

## The native socket (Tauri)

`frontend/src-tauri/src/commands/mail_socket.rs`: three commands, `mail_socket_open`,
`mail_socket_write`, `mail_socket_close`, to ONE compile-time destination (`MAIL_HOST`, `MAIL_PORT`
= `partage.emse.fr:443`); nothing the page sends names a host. The bytes cross the IPC raw: the write
is an `InvokeBody::Raw` request with the socket id in the `x-mail-socket` header, the reads arrive on
a `Channel<InvokeResponseBody>` as raw bytes, never as JSON number arrays
([durable-rules](durable-rules.md)). The connect races IPv6 and IPv4 (`happy_eyeballs::connect`,
15 s), and how the socket ended comes on a second channel as a tagged `MailSocketEnd`
(`peer_closed`, `closed_by_page`, `read_failed`, `write_failed`), mapped by `nativeEnd`. A
connection abandoned while its open is in flight closes the socket the moment the open answers.

Six unit tests (`cargo test --lib mail_socket`). **Compiled only for the Windows desktop target in
lot 1**; Android, iOS, macOS and Linux are compiled by their own CI jobs.

## The TypeScript layers (`frontend/src/lib/mail/`)

- `transport.ts` - `ByteTransport` (`send`, `close`) and how one ended (`TransportEnd`:
  `peer_closed`, `closed_by_us`, `byte_cap`, `failed`); `MailTransportError` is `unreachable` (could
  not open) or `closed`.
- `relayTransport.ts`, `tauriSocketTransport.ts` - the two implementations; `connect.ts` picks the
  platform's (`platformTransport`) and makes a stream opener (`mailStreamOpener`).
- `tlsConnection.ts` - `TlsConnection`: one TLS session over one transport. It resolves once the
  handshake completes; a TLS error sends the alert the engine owes, then closes; `close` sends the
  close_notify, then closes the transport; the WASM session is freed exactly once.
- `http1.ts` - HTTP/1.1 on BYTES: requests serialised one after the other on one connection,
  `Content-Length` counted in bytes, chunked bodies (extensions and trailers included), a body framed
  by the end of the stream, `1xx` skipped. A connection that the server closes, or that answered
  `Connection: close`, is spent.
- `soapClient.ts` - `ZimbraSoapClient`: JSON SOAP to `POST /service/soap` over ONE persistent
  connection, opened on first use and reopened when spent. A call is NEVER re-sent: `SendMsg` is not
  idempotent. A fault is a `ZimbraFault` typed by its `Detail.Error.Code`.

Vitest, with a fake transport, a fake TLS engine and a fake stream (`frontend/src/test/mailFakes.ts`):
39 tests across `http1`, `tlsConnection`, `soapClient`, `relayTransport`, `tauriSocketTransport` and
`eligibility`.

### The end-to-end test

`frontend/src/lib/mail/mail.e2e.test.ts`, SKIPPED unless `CANARI_MAIL_E2E_RELAY` names a running
relay's WebSocket URL, token included. It sends an UNAUTHENTICATED
`{"Body":{"GetInfoRequest":{"_jsns":"urn:zimbraAccount"}}}` twice over one connection and expects
Zimbra's `service.AUTH_REQUIRED` fault (HTTP 500) both times: proof that bytes crossed the relay, the
WASM TLS and the HTTP client to the real mailbox and back, with no credential anywhere. To run it:
`bun run wasm:build`, then a chat-gateway binary with `JWT_SECRET`, `MAIL_RELAY_ENABLED=1`,
`MAIL_RELAY_UPSTREAM=partage.emse.fr:443`, and a `CORE_SERVICE_URL` + `INTERNAL_SECRET` that answer
an eligible domain (a twenty-line stand-in will do), and an HS256 token signed with that secret.

**Run 2026-11-27, passed**: one connection, two calls, 89 ms; the gateway's end line read
`up 782 bytes (hs=1 ccs=1 alert=0 app=4), down 8116 bytes (hs=1 ccs=1 alert=0 app=6)`.

## Still open

- **The reader token is production-only, by decision.** `MICONNECT_READER_TOKEN` is set on
  production and NOT on dev (lead, 2026-11-11, `infrastructure/MIGRATION.md`: a read-all-users
  credential on a test estate "for no use"). On dev core therefore answers 503 and the relay admits no
  one, which blocks D12's "dev first". The relay is now a use: either that decision is revisited for
  dev, or dev gets another eligibility source - a choice for the lead or the owner, not made here.
- **The page has no source for its own domain yet**: the tab (lot 2/3) needs a route answering the
  signed-in account's mail domain, or the relay's refusal as the signal.
- The privacy register and policy owe a line for this new use of the MiConnect address (lot 3).
- The macOS runner's Homebrew LLVM path for the ring build is written but has not run in CI yet.
