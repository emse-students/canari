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
`mailAddress()`, the account's OWN school address - so lot 3 wires it to the signed-in Canari
session; nothing here reaches into the session modules.

- **The sign-in asks ONLY the password** (owner, 2026-11-27): `signIn(password, remember)` takes the
  address from `mailAddress()`, read client-side from the account's MiConnect identity (whether the
  id_token the OIDC callback hands the client carries `email` is lot 1's open check), never from what
  a user typed. No address is `address_unknown`. **D1 comes from that same address**
  (`MailSession.eligibility()`, `MailStore.loadEligibility()`): the tab's verdict before any mail
  sign-in, not a relay refusal.
- An address off `MAIL_DOMAINS` is refused BEFORE a byte is sent (`not_eligible`); then `AuthRequest`, then `GetInfoRequest`, whose canonical
  address is checked again (an alias may differ from what was typed - an ineligible one ends the new
  session on the server and is refused).
- **Renewal is driven by the server's answer, never a clock.** The token lasts about two days
  (measured) and the `lifetime` Zimbra sends is NOT read. A call answered `service.AUTH_EXPIRED` or
  `service.AUTH_REQUIRED` renews the session from the remembered password and is sent ONCE more: a
  fault is a refusal before the call ran, so the resend cannot do it twice (a connection lost
  mid-call is still never re-sent - lot 1's rule). Calls that saw the same token end share ONE
  renewal (a single promise; a call whose failure arrives after it finds the newer token and uses
  it). A renewal the network failed keeps the old token, so the next call is refused again and
  renews again - driven by that answer. A renewal that cannot succeed drops the token and the state
  asks for the password, saying why (`PasswordAskReason`: not remembered, refused by the server,
  unopenable under this device key, device locked).
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
- the plaintext is `{account, password}`, so a password is never tried against another mailbox;
- the entry is `localStorage` `ACCOUNT_KEY.mailSealedPassword(userId)` - ciphertext only, never the
  password in the clear - written and read INSIDE the storage gate (`withDeviceKeyHeld`,
  `liveDeviceKey`), so a key change running meanwhile either re-seals it or is already done;
- every device key change re-seals it beside the stores (`moveRememberedMailPassword` in
  `pinChange.ts`, at both call sites of `moveDeviceRecoveryCode`), idempotently, and NEVER fatally:
  a password that could not move costs one password prompt, not a half-moved key change;
- the account deletion sweeps it (`exactKeys` in `accountLocalKeys.ts`).

Unticked, nothing is written and any earlier entry is removed: the token lives in memory only and
the password is asked again when it lapses.

#### D7 - the typed errors

`mailErrors.ts`: `classifyMailFailure` turns what a lower layer threw into ONE `MailError` by CLASS
and CODE, at the one seam every call goes through. The screens switch on `kind`.

| `kind` | From | What the session does |
|---|---|---|
| `bad_credentials` | `account.AUTH_FAILED` | at a renewal: forgets the remembered password, asks for it |
| `password_change_required` | `account.CHANGE_PASSWORD` | the same |
| `account_closed` | `account.ACCOUNT_INACTIVE`, `account.NO_SUCH_ACCOUNT` | D8 erasure, state `closed` |
| `maintenance` | `account.MAINTENANCE_MODE` | nothing: temporary, nothing erased |
| `session_expired` | `service.AUTH_EXPIRED`, `service.AUTH_REQUIRED`, HTTP 401 on upload/download | one renewal, one resend; if that fails, asks for the password |
| `not_found` | `mail.NO_SUCH_MSG` / `_CONV` / `_FOLDER` / `_ITEM` / `_PART` / `_UPLOAD`, HTTP 404 | - |
| `invalid_query` | `mail.QUERY_PARSE_ERROR` | - |
| `too_large` | `mail.MESSAGE_TOO_BIG`, `mail.UPLOAD_REJECTED`, HTTP or servlet 413 | - |
| `quota_exceeded` | `mail.QUOTA_EXCEEDED` | - |
| `address_unknown` | the account's identity carries no address | refused before sending |
| `not_eligible` | an address off `MAIL_DOMAINS` (D1) | refused before sending |
| `not_signed_in` | a call with no token | - |
| `transport` | `MailTransportError`, `MailTlsError`, `HttpProtocolError` | - |
| `server` | any other fault code, an unreadable answer, an answer missing what the call is for | - |
| `internal` | a throw no layer typed - logged as a defect | - |

#### D8 - a closed account

`account_closed`, met on ANY call or renewal, erases `mailLocalKeys(userId)` - an explicit
allowlist, today the one sealed-password key, never a prefix - and nothing else on the device, then
sets the state `closed`; `MailStore` empties itself on that state. `resume()` leaves a closed
mailbox closed: only a new sign-in reopens one. **A lot that persists mail adds its key to
`mailLocalKeys`**, and `mailLocalData.test.ts` asserts the list.

### The API (`mailApi.ts`)

One or two calls through the session per method, returning the small types of `mailTypes.ts`
(Zimbra's abbreviations are read in `zimbraParse.ts` only):

- `folders()` - the tree under the root, mail views only, system roles by Zimbra's fixed ids (2
  inbox, 3 trash, 4 junk, 5 sent, 6 drafts); `u` absent is 0 unread.
- `conversations(...)` / `messages(...)` - `SearchRequest` newest first, paged by `offset`/`limit`,
  `more` read; the folder is named by ID (`inid:"2"`, never a localised name) and the reader's query
  is ANDed in parentheses.
- `conversation(id)` (`GetConv`, `fetch: 'all'`, `html: 1`), `message(id)` (`GetMsg`, `html: 1`):
  the defanged HTML (D9 still sandboxes it in lot 3), the text, attachments and inline images.
- `act(target, op, ids, ...)` - ONE `MsgAction` / `ConvAction` for every id (bulk), ops `read`,
  `unread`, `flag`, `unflag`, `move` (`l`), `trash`, `spam`, `not_spam`, `delete`. A conversation
  action carries Zimbra's target constraint `tcon`: it leaves alone the messages in Trash, Junk,
  Sent and Drafts unless that is the folder listed (the webmail's rule).
- `send(...)` / `saveDraft(...)` - `multipart/alternative` when there is HTML, uploads by `aid`,
  existing parts by `mid` + `part`, reply/forward by `origid` + `rt` + `irt`, the draft deleted on
  send (`did`) or overwritten on save (`id`).
- `upload(...)` / `download(...)` - plain HTTP on the SAME connection (`ZimbraSoapClient.exchange`,
  added in this lot): `POST /service/upload?fmt=raw,extended` and
  `GET /service/home/~/?auth=co&id=..&part=..`, both with the `ZM_AUTH_TOKEN` cookie. The filename
  goes in `Content-Disposition` with every non-ASCII character, `"` and `&` as an HTML numeric entity
  (the webmail's own encoding; measured to round-trip `é`).
- `directory(text)` - `AutoCompleteRequest` with the school directory (`includeGal`).

`mailCompose.ts` prefills reply, reply-all and forward: the recipients (Reply-To first, the
original's recipients when the account sent it, never the account itself, no duplicates), `Re:` /
`Fwd:` (not translated, as in every client; never doubled), the quote in text (`> `) and in HTML
(`<blockquote type="cite">`), and every attachment of a forward by reference. The attribution line
and the forwarded header are Paraglide strings (`mail_quote_attribution`, `mail_forward_*`).

### The store (`mailStore.svelte.ts`)

`MailStore` (Svelte 5 runes, memory only): the session state, the folder tree, the folder listed
and its search, the conversations (every page loaded, de-duplicated across pages), `hasMore`,
`loading`, the last typed `error`, the selection, and two derived values - `inboxUnread` (the D10
badge) and `eligibility` (D1, from the address the session names: `unknown` / `eligible` /
`not_eligible`). A list answer is applied only to the list it was asked for: every open bumps a
generation and an older answer is dropped. `act()` sends ONE call for the selection, applies it to
the rows in place, then reloads the counts. A sign-out or a closed account empties it.

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
never committed. It reads `GetInfo`, `GetFolder` and a search restricted to
`subject:"[test Canari]"` (no real mail is read). With `CANARI_MAIL_TEST_SEND=1` it uploads a small
attachment with a non-ASCII name, sends ONE mail to the account ITSELF (subject
`[test Canari] ...`), reads it back and downloads the attachment. The transport is the relay when
`CANARI_MAIL_E2E_RELAY` is set, otherwise a plain TCP socket from the test process to
`partage.emse.fr:443` (the TLS is still the WASM's). Needs `bun run wasm:build`.

**Run 2026-11-27, passed** (Windows workstation, direct socket): read-only in 5.5 s, then with the
send in 4.1 s - the upload's entity-encoded filename, the send with HTML and an attachment, `GetMsg`
of the sent copy and the attachment download all round-tripped.

### Still open after lot 2

- **`MailContext.mailAddress()` has no implementation yet**: lot 3 wires it to the address the
  MiConnect identity carries, once lot 1 has confirmed the id_token holds `email`. Until then the
  store's `eligibility` is `unknown` before a sign-in.
- **Archive** is a `move` to a folder the caller names: Zimbra has no system archive folder, and
  which folder "Archiver" targets (an existing `Archives`, one created on first use) is a decision
  for lot 3.
- **A mail cache at rest** does not exist yet: everything but the sealed password is in memory. A
  lot that adds one adds its key to `mailLocalKeys` (D8) and decides whether it is sealed under the
  device key (and then re-sealed by a key change).
- `account.ACCOUNT_INACTIVE` / `account.NO_SUCH_ACCOUNT` as the closed-account answers are Zimbra's
  documented codes, not measured on Partage: no closed account was available to probe.
