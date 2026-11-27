# The mail client - the school mailbox inside Canari

**Status: DECIDED by the owner on 2026-11-27, planned for `1.10.0`
([entry](backlog.d/the-mail-client-for-the-school-mailbox.md)), built in lots, behind a server switch
that is off by default.** It started as an open question the same day ("could Canari carry a mail
client like Thunderbird?"). The measurements below answered it and the owner validated the mockups.

## What it is, and for whom

A conventional mailbox (folders, conversations, reading, writing, search, attachments, the school
directory, swipe and bulk actions) in Canari's own style, on the web, the phones and the desktop app
([entry](backlog.d/a-desktop-app-for-windows-macos-and-linux.md)). It reads and writes the account's
**RENATER Partage** mailbox (`partage.emse.fr`) and nothing else.

**Eligible accounts** (owner, 2026-11-27): students (`@etu.emse.fr`) and staff (`@emse.fr`). The list
of domains is DATA, written once and read by the client (to show the tab) and by the relay (to admit
a socket). It is never re-derived from a status.

**The charter, cited** ([principes](../principes.md)):

- **1 - your messages are yours.** Mail is not end-to-end encrypted, so no Canari server ever holds
  the password, a session token or a byte of plaintext. The device speaks TLS to Partage itself; on
  the web, our server relays ciphertext only (D4).
- **2 - the essential is not lost.** The school's announcements, the administration and the teaching
  staff live in this mailbox. Having them in the same place as the rest is the point of the feature.
- **3 - your attention is not for sale.** Remote images are blocked by default (tracking pixels).
  Mail notifications are their own type and are switched off in one gesture.
- **4 - independent.** No third party is added: Partage is the school's provider, and the relay is
  ours. Cloudflare Email Routing was weighed for notifications and NOT taken (D11).
- **7 - simple.** One account, the school's, with no IMAP-generic multi-account client.

## The decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D1  | Eligibility is the account's address domain: `etu.emse.fr`, `emse.fr`, as one shared list                                                                                                                                                                                                                                                                                                                                                                 | owner; a fact both sides read, never a status inferred                                        |
| D2  | **One protocol everywhere: Zimbra JSON SOAP over HTTPS to `partage.emse.fr:443`**                                                                                                                                                                                                                                                                                                                                                                         | the production host's egress allows 443 only (measured); one protocol for web and apps        |
| D3  | **TLS in the client: rustls**, compiled to WASM for the web and natively in Tauri, from ONE crate                                                                                                                                                                                                                                                                                                                                                         | production-grade TLS; the prototype's `subtls` is "not ready for production" in its own words |
| D4  | **Two transports, one client**: web = a WebSocket to a blind relay in `chat-gateway`; apps and desktop = a native TCP socket opened by Tauri. The TLS bytes are the same                                                                                                                                                                                                                                                                                  | the relay never terminates TLS, and the apps put no load on our server                        |
| D5  | The relay: exactly ONE destination (`partage.emse.fr:443`, configuration, an allowlist of one), signed-in eligible accounts only, the existing origin check, a cap on concurrent connections and bytes per user, and a log of byte counts and TLS record types, never content                                                                                                                                                                             | a destructive or open proxy needs an allowlist, never a denylist                              |
| D6  | "Retenir le mot de passe": the password is SEALED under the Canari device key (hardware-held on a phone, PIN-derived on web and desktop). The Zimbra token (2 days, measured) lives in memory and is re-obtained from the sealed password when it lapses. Unticked: the token lives in memory only, and the password is asked again                                                                                                                       | owner, 2026-11-27: "confortabilité au maximum", encrypted with the PIN where there is one     |
| D7  | Errors are TYPED where they are thrown, from the Zimbra fault code: bad password, account closed or inactive, transport, server fault                                                                                                                                                                                                                                                                                                                     | never branch on a message                                                                     |
| D8  | An account closed (D7) erases the mail store and the sealed password on the device, and says why, using an allowlist of what it may delete                                                                                                                                                                                                                                                                                                                | staff and students leave the school; nothing is kept on our side anyway                       |
| D9  | HTML mail is shown in a sandboxed frame (no scripts, no remote loads). Remote images are blocked until the reader allows them for that message                                                                                                                                                                                                                                                                                                            | principle 3; Zimbra's defanging is a first layer only                                         |
| D10 | A tab "Mail" in the navigation, with the inbox unread count as its badge                                                                                                                                                                                                                                                                                                                                                                                  | owner                                                                                         |
| D11 | **Notifications, first version**: Android keeps one persistent connection from the phone (the Thunderbird / K-9 model), behind a settings switch and after a battery measurement on the bench Mi 9T; iOS refreshes when the system allows; desktop is live while the tray app runs. **Parked**: a server-side signal (Zimbra's new-mail alert sent to a service mailbox the school would create, read by our backend over 443, turned into an empty push) | no third party, no password on a server; the service mailbox needs the school's IT            |
| D12 | A server switch, off by default, published to clients like the others; dev first, then production                                                                                                                                                                                                                                                                                                                                                         | the usual path for a feature                                                                  |

## What was measured (2026-11-27)

From public DNS, anonymous probes, and the owner's own account with the owner's approval. A session
token was used; the password never entered a transcript.

- `partage.emse.fr` is RENATER Partage, Zimbra `9.0.0_ZEXTRAS_9046` (CNAME
  `emse.partage.renater.fr`; the MX is `relay.renater.fr`).
- IMAP 993 and SMTP 465/587 answer; IMAP offers `AUTH=PLAIN` only (no OAuth); there is no JMAP. The
  ENT password logs in over IMAP and over SOAP (`AuthRequest`).
- The SOAP endpoint sends no `Access-Control-Allow-Origin`, so a web page cannot call it directly.
  The webmail sends `X-Frame-Options: sameorigin`, so it cannot be embedded.
- **From the production host, egress to Partage on 993, 465 and 587 is blocked; 443 is open.**
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

1. **Transport** - the rustls crate (WASM and native), the relay route in `chat-gateway` (D5), the
   Tauri socket, and end-to-end tests against Partage with a test token.
2. **The Zimbra client** - sign-in, the token and the sealed password (D6), folders, search,
   conversations, reading, sending, drafts, actions (read, flag, move, trash, spam), the directory, and
   typed errors (D7, D8).
3. **The screens** - the tab (D10) and the validated mockups, with Paraglide strings, the HTML sandbox
   (D9), and the register and privacy-policy lines for the relay's connection metadata.
4. **Android notifications** (D11) - the persistent connection behind its switch, with the battery
   measurement.

## Open

- The content of Zimbra's new-mail alert, and whether the school would create a service mailbox
  (D11's server path).
- The date a student's or staff member's mailbox closes after they leave, to warn before D8 fires.
