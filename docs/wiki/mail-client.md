# The mail client - the school mailbox inside Canari

**Status: DECIDED by the owner on 2026-11-27, planned for `1.10.0`
([entry](backlog.d/the-mail-client-for-the-school-mailbox.md)), built in lots, behind a server switch
that is off by default.** It started as an open question the same day ("could Canari carry a mail
client like Thunderbird?"). The measurements below answered it and the owner validated the mockups.
**Lot 1, the transport, is built** ([mail-client-transport](mail-client-transport.md), the page of
what was built); the decisions below are written as it built them, and each deviation from the first
design is marked as decided, with its reason.

## What it is, and for whom

A conventional mailbox (folders, conversations, reading, writing, search, attachments, the school
directory, swipe and bulk actions) in Canari's own style, on the web, the phones and the desktop app
([entry](backlog.d/a-desktop-app-for-windows-macos-and-linux.md)). It reads and writes the account's
**RENATER Partage** mailbox (`partage.emse.fr`) and nothing else.

**Eligible accounts** (owner, 2026-11-27): students (`@etu.emse.fr`) and staff (`@emse.fr`), as
D1 says how it is known.

**The charter, cited** ([principes](../principes.md)):

- **1 - your messages are yours.** Mail is not end-to-end encrypted, so the design keeps every
  Canari SERVER out of the mailbox: no server stores the password, a session token or a byte of
  plaintext, and the relay carries ciphertext only (D4, D5). The device speaks TLS to Partage
  itself. **What this does not cover, said plainly** (lead, 2026-11-28): on the web, the code that
  reads the password from the field and hands it to the WASM TLS is JavaScript SERVED BY OUR
  SERVER. A compromise of that server, or of what serves its files, could serve code that captures
  the password as it is typed. That is the threat model of every web page that takes a password,
  and the reason the device never STORES the password (D6): what a compromise can take is the
  passwords typed while it lasts, never a store of them. The Tauri apps ship their code in the
  store-signed package, so a server compromise does not change what they run.
- **2 - the essential is not lost.** The school's announcements, the administration and the teaching
  staff live in this mailbox. Having them in the same place as the rest is the point of the feature.
- **3 - your attention is not for sale.** Remote images are blocked by default (tracking pixels).
  Mail notifications are their own type and are switched off in one gesture.
- **4 - independent.** No third party is added: Partage is the school's provider, and the relay is
  ours. Cloudflare Email Routing was weighed for notifications and NOT taken (D11).
- **7 - simple.** One account, the school's, with no IMAP-generic multi-account client.

## The decisions

| #   | Decision | Why |
| --- | --- | --- |
| D1  | **Eligibility is the account's mail CLASS (`student`, `staff`), learnt from MiConnect's `school_mail` claim and stored on `users."mailClass"`**. The claim carries the account's address only if the CAS created the account and the address is on `etu.emse.fr` or `emse.fr`; the domain-to-class list is ONE contract, `libs/contracts/mail-domains.json`, held equal by a test on each side. The server keeps the class, never the address; the device keeps the address for the sign-in's prefill. **Deviation from the first design ("the account's address domain"), decided 2026-11-27**: MiConnect's `email` claim is synthetic (`<username>@canari.emse.fr`) and cannot answer, and an Alumni-created account carries the Alumni address ([eligibility](mail-client-transport.md#eligibility)) | owner (the two populations); a fact both sides read, never a status inferred |
| D2  | **One protocol everywhere: Zimbra JSON SOAP over HTTPS to `partage.emse.fr:443`** | the production host's egress allows 443 only (measured on the CURRENT host; re-measured on the migration target before the relay goes on there, [precondition](backlog.d/the-mail-relay-before-production-renater-limits-and-the-register.md)); one protocol for web and apps |
| D3  | **TLS in the client: rustls, ONE crate (`frontend/mail-tls`), compiled to WASM and run by the page on EVERY platform**, the Tauri apps included: their native side carries ciphertext bytes only. **Deviation from the first design ("natively in Tauri"), decided 2026-11-27**: one TLS code path means the same bytes, the same certificate judgement and the same typed errors everywhere; the crate still builds natively, as a library, for its tests. TLS 1.3 only, the ring provider, Mozilla's roots compiled in | production-grade TLS; the prototype's `subtls` is "not ready for production" in its own words |
| D4  | **Two transports, one client**: web = a WebSocket to a blind relay in `chat-gateway`; apps and desktop = a native TCP socket opened by Tauri. The TLS bytes are the same | the relay never terminates TLS, and the apps put no load on our server |
| D5  | **The relay, as built**: exactly ONE destination (`MAIL_RELAY_UPSTREAM`, one `host:port`; anything else stops the gateway at boot); signed-in ELIGIBLE accounts only (D1, asked of core-service per connection); the `/api/ws` origin and token checks; **per account** at most 4 connections held, 20 NEW connections per rolling minute and 512 MiB over a rolling hour, both ways and all its connections together; 400 connections in all; 256 MiB per connection; nginx's 10 opens per second per address in front; an idle close at 90 s, below every hop. An ACCOUNT is refused after the upgrade with a typed close code (4005 not eligible, 4006 a cap, 4007 eligibility unknown), because a browser cannot read the status of a refused upgrade. One line per connection end, naming the account by the first 8 characters of its id, with byte and TLS record counts, never content. **Deviations, decided**: the per-user byte cap became a per-CONNECTION cap plus a per-account budget over a window (lead, 2026-11-28: a per-connection cap alone let an account reopen and pull without end through the one egress address), the rate per account was added for the same address, and the refusals became close codes (lead, 2026-11-28) ([the relay](mail-client-transport.md#the-relay)) | a destructive or open proxy needs an allowlist, never a denylist; ONE egress address carries every student towards RENATER |
| D6  | **"Retenir la connexion" seals the Zimbra AUTH TOKEN, never the password** (lead, 2026-11-28, replacing the owner's first version of 2026-11-27, which sealed the password). The password is typed at sign-in and lives in memory for the `AuthRequest` call only, then is dropped. Ticked: the token (mail-only, about two days, measured) is sealed under the Canari device key (hardware-held on a phone, PIN-derived on web and desktop) and reused across restarts; when it lapses, the password is ASKED again. Unticked: the token lives in memory only | charter principle 1 (below); the owner's "confortabilité au maximum" is kept for two days at a time, at the cost of one password a lapse |
| D7  | Errors are TYPED where they are thrown, from the Zimbra fault code: bad password, account closed or inactive, transport, server fault; the relay's refusals from its close code (D5) | never branch on a message |
| D8  | An account closed (D7) erases the mail store and the sealed token on the device, and says why, using an allowlist of what it may delete | staff and students leave the school; nothing is kept on our side anyway |
| D9  | HTML mail is shown in a sandboxed frame (no scripts, no remote loads). Remote images are blocked until the reader allows them for that message | principle 3; Zimbra's defanging is a first layer only |
| D10 | A tab "Mail" in the navigation, with the inbox unread count as its badge | owner |
| D11 | **Notifications, first version**: Android keeps one persistent connection from the phone (the Thunderbird / K-9 model), behind a settings switch and after a battery measurement on the bench Mi 9T; iOS refreshes when the system allows; desktop is live while the tray app runs. **Parked**: a server-side signal (Zimbra's new-mail alert sent to a service mailbox the school would create, read by our backend over 443, turned into an empty push) | no third party, no password on a server; the service mailbox needs the school's IT |
| D12 | **Two switches, both off by default.** The RELAY's is an environment variable of chat-gateway, `MAIL_RELAY_ENABLED` (read at boot; an unreadable value stops the gateway): off, `/api/mail/relay` answers 404. The TAB's is a server mode published to clients like the others, lot 3's `mail_mode`. Dev first, then production. **Deviation from the first design ("a server switch published to clients"), decided 2026-11-27**: the relay is a route of a gateway that has no platform-config reader, and a switch read at boot cannot be flipped half-way through a connection; the tab's switch is the published one | the usual path for a feature |

## Why the device never seals the password (D6, lead, 2026-11-28)

**The review's finding (F0-1).** The first D6 sealed the school SSO password on the device. That
password is not a mail password: it is the key to the person's whole school account (the ENT, the
CAS, every school service behind it). Principle 1 asks what a compromise costs, and a sealed
password turns a theft of the device's key - offline guessing of a PIN on the web and the desktop -
into the whole school account, for as long as the person keeps that password.

**What is sealed instead: the Zimbra auth token.** It opens the MAILBOX only (Zimbra's SOAP, not
the CAS), and it lapses by itself in about two days (measured, 2026-11-27). A stolen token is two
days of one mailbox, never the school account. The cost is one password prompt each time the token
lapses, which the owner's "comfort" decision is weighed against and which the lead takes, reversibly.

**Where the password goes.** Typed into the sign-in field, held in memory for the one `AuthRequest`,
and dropped once Zimbra answers - never written, never logged, never sent anywhere but into the TLS
session to Partage. The threat model of the web page that holds it is in principle 1 above.

**What it changes.** Lot 1 holds no password and no token: nothing in its code changes. Lot 2
(#4205) built the first D6 (`sealedMailPassword.ts`) and is rewritten to seal the token: the renewal
from a remembered password becomes "ask the password when the token lapses".

## The lead's decisions of the review (lead, 2026-11-28)

Each is reversible and was taken under the owner's absence rule (the recommended option when
reversible, written here). The review's finding is in brackets.

- **Lot 0 folded into lot 1 [owner rule, no standalone docs PRs].** This page, its backlog entry, the
  roadmap line and the index line ship in lot 1's pull request (#4198); #4193 is closed.
- **D6 seals the token, never the password [F0-1].** Above.
- **The relay's per-account rate and byte budget [F0-2, F1-1, F1-3].** Every relay connection leaves
  through ONE egress address, which RENATER sees for every student at once: one account's loop could
  spend that address's standing for all. D5 now caps each account's new connections per minute and
  its bytes over a rolling hour, server-side (`mail_relay.rs`), each refusal a typed close and each
  line naming the account. **Before `MAIL_RELAY_ENABLED` goes on in production, RENATER's per-IP
  limits are measured and the egress address exempted** - an owner action, in the
  [precondition entry](backlog.d/the-mail-relay-before-production-renater-limits-and-the-register.md).
- **D1, D3, D5 and D12 rewritten as built [F0-3]**, each deviation marked decided, with its reason
  (the table above).
- **D2 is re-measured on the migration target host [F0-4]**: an open item of the precondition entry.
- **The MiConnect terms version moves [F1-2]**: the school address to Canari is a NEW PURPOSE, a
  material change, so `acceptedVersion` and the version literal of `45-consent.yaml` move together
  (2026-11-28) and every account is asked once more.
- **The idle close at 90 s [F1-4]**: clearly below the Cloudflare edge's 100 s and nginx's 120 s,
  both held by `mail-relay-route.test.mjs`.
- **The refusals are close codes [F1-5]**: 4005, 4006, 4007, read by `relayTransport.ts` as a type
  (`MailTransportError` `refused`, with its `refusal`).
- **A call never sent is sent once more [F1-6]**: `ZimbraSoapClient.call` re-sends exactly once, on a
  fresh connection, a call that failed `not_sent` (it never left the device); never one that failed
  `ended`.
- **The owed readings planned [F1-7]**: [an entry](backlog.d/the-mail-eligibility-readings-once-lot-1-ships.md)
  in `1.10.0`.
- **The macOS build measured [F1-8]**: the ring build's Homebrew LLVM ran in CI (run 46019027381) and
  costs about 45 s and 457 MB on a cache miss ([transport](mail-client-transport.md#the-crypto-provider)).
- **The sign-in answer keeps its behaviour [F1-9]**: only the mail class waits for its write before it
  joins the returned row; the other claims join it as before (`findOrCreateFromOidc`, pinned by its test).
- **The register and the device's copy [F1-10]**: the relay's connection log is declared in the
  register by the pull request that turns `MAIL_RELAY_ENABLED` on on dev (precondition entry); the
  school address leaves the device at sign-out, as the privacy policy says ("jusqu'à votre
  déconnexion") and [the transport page](mail-client-transport.md#eligibility) details.

## What was measured (2026-11-27)

From public DNS, anonymous probes, and the owner's own account with the owner's approval. A session
token was used; the password never entered a transcript.

- `partage.emse.fr` is RENATER Partage, Zimbra `9.0.0_ZEXTRAS_9046` (CNAME
  `emse.partage.renater.fr`; the MX is `relay.renater.fr`).
- IMAP 993 and SMTP 465/587 answer; IMAP offers `AUTH=PLAIN` only (no OAuth); there is no JMAP. The
  ENT password logs in over IMAP and over SOAP (`AuthRequest`).
- The SOAP endpoint sends no `Access-Control-Allow-Origin`, so a web page cannot call it directly.
  The webmail sends `X-Frame-Options: sameorigin`, so it cannot be embedded.
- **From the production host, egress to Partage on 993, 465 and 587 is blocked; 443 is open.** That
  is the CURRENT host; the migration target is measured again (D2).
- The account's features: filters are enabled but **forwarding in filters is disabled**; the new-mail
  alert to an address is enabled (`zimbraFeatureNewMailNotificationEnabled`); app-specific passwords
  are enabled but two-factor is unavailable, so they are probably unusable; ActiveSync and the Zextras
  mobile push are disabled. Zimbra does not send its alert when the alert address is the account
  itself, so the alert's content is still unknown (measure it when D11's server path is taken up).
- **The prototype** (local, nothing deployed):
  - a ~60-line bun relay, WebSocket to TCP to `partage.emse.fr:443` only;
  - TLS 1.3 done in the client by `subtls` (pure JS on WebCrypto);
  - Zimbra JSON SOAP over HTTP/1.1 inside the tunnel.

  The results:
  - Partage negotiates `TLS_AES_128_GCM_SHA256`, P-256, RSA-PSS. Its chain (GEANT TLS RSA 1, then
    HARICA TLS RSA Root CA 2021) verifies from the HARICA root, and a wrong root is refused.
  - The relay saw handshake records, then application data only.
  - `GetInfo`, `GetFolder`, `Search`, `GetMsg` and `SendMsg` (to the account itself, accents intact,
    received) each took 80-225 ms, in bun and in headless Chrome.
  - `GetMsg` with `html: 1` returns Zimbra's defanged HTML.
  - A token from one login served every call. It lasts two days.

**Refused, and why.** A Roundcube-style webmail on our server would hold the password and read every
mail (principle 1), and would need a new service on a host we do not own. Mailu is a mail server, and
there is nothing to host. Framing the school's webmail is blocked by its own header.

## The lots

1. **Transport** (#4198, built) - the rustls crate, the relay route in `chat-gateway` (D5), the Tauri
   socket, HTTP/1.1 and Zimbra SOAP on bytes, the eligibility class (D1), and an end-to-end test
   against Partage with no credential ([as built](mail-client-transport.md)).
2. **The Zimbra client** (#4205) - sign-in, the token and its seal (D6), folders, search,
   conversations, reading, sending, drafts, actions (read, flag, move, trash, spam), the directory, and
   typed errors (D7, D8).
3. **The screens** (#4211) - the tab (D10) and the validated mockups, with Paraglide strings, the HTML
   sandbox (D9), and the register and privacy-policy lines for the relay's connection metadata.
4. **Android notifications** (#4212) - the persistent connection behind its switch, with the battery
   measurement.

## Open

- The content of Zimbra's new-mail alert, and whether the school would create a service mailbox
  (D11's server path).
- The date a student's or staff member's mailbox closes after they leave, to warn before D8 fires.
- Before production: RENATER's per-IP limits and the egress exemption, D2 on the migration target, and
  the register line ([precondition](backlog.d/the-mail-relay-before-production-renater-limits-and-the-register.md)).
