# School mail in Canari (IMAP/SMTP on the device) - a STUDY, nothing is built

**Status: study of 2026-10-09, no product code, and no login was ever attempted against the school
server.** User idea: a Canari tab linking the user's SCHOOL MAIL through an IMAP client. **Decision
(user, 2026-10-09): ON-DEVICE, native apps only** - the Tauri Rust side speaks IMAP/SMTP directly, the
school password never reaches the Canari server, no web version.

**Why the server is out, measured 2026-10-09 from the production host:** only 443 egresses, while
`partage.emse.fr` answers on 993 and 465 from the public Internet. It is RENATER Partage (Zimbra); banners
`IMAP4rev1 proxy server` and `zmtaauth01.partage.renater.fr ESMTP Postfix`. A server-side relay would need a
firewall decision AND would hold the password: both rejected.

| Setting | Value (EMSE) |
| --- | --- |
| IMAP | `partage.emse.fr:993`, SSL/TLS (implicit) |
| SMTP | `partage.emse.fr:465`, SSL/TLS (implicit) |
| Auth | normal password; login `prenom.nom@etu.emse.fr` |

**Verdict: FEASIBLE on all four native targets (Android, iOS, desktop), a large but ordinary Rust
chantier: ~22 working days for a read-only MVP, ~30-35 for reader + composer + cache. One gate is NOT
technical: the school's IT charter and the DSI's answer on app passwords / OAuth (1.5).** The cheapest
honest first step is a question to the DSI, not code.

## 1. Feasibility

### 1.1 Rust crates and targets

Not compiled in this study (docs-only); the claims come from crate design and from the stack the app
already links. **WP-M0 verifies each by compiling for `aarch64-linux-android` and `aarch64-apple-ios` and
running a handshake on a phone** - a green host build proves nothing about either, see [mobile](../mobile.md).

| Need | Crate | Targets | Notes |
| --- | --- | --- | --- |
| IMAP client | `async-imap` (tokio runtime feature) | pure Rust, expected on all | the maintained async client; tokio is already a dependency |
| IMAP parsing | `imap-proto` (pulled in) | pure Rust | BODYSTRUCTURE, ENVELOPE; CONDSTORE/QRESYNC support is thin, so plan plain UID sync with `UIDVALIDITY` |
| MIME | `mail-parser` | pure Rust, no deps | tolerant, charsets, attachments |
| SMTP + building | `lettre` (tokio1 + rustls, `default-features = false`) | pure Rust with rustls | default features enable native-tls (OpenSSL on Android): turn them off |
| TLS | `rustls` + `tokio-rustls` | needs only the crypto provider | the provider is the pitfall, below |
| Roots | `rustls-platform-verifier` | Android (JNI), iOS/macOS (Security.framework), Windows, Linux | OS trust store and revocation |
| HTML sanitising | `ammonia` (Rust) | pure Rust | defence in depth before the render, 2.4 |

**TLS pitfalls.** (a) rustls needs ONE crypto provider: take the one the tree already has
(`tauri-plugin-http` with `rustls-tls`, `sqlx` with `runtime-tokio-rustls`) and check `cargo tree -d`;
`aws-lc-rs` needs more toolchain. (b) `webpki-roots` (a frozen Mozilla list) is NOT wanted: use the platform
verifier. (c) Never any `accept invalid certificate` switch (2.2). (d) On Android the platform verifier needs
its Kotlin glue initialised at startup from the plugin: one more reason the mail module is a real Tauri
plugin and not loose commands.

**Binary size and build time are ESTIMATES to measure in M0, not facts:** roughly 1-2 MB per ABI stripped on
top of the existing rustls/tokio and about a minute of cold Android build. The yardstick is the release shape
in [mobile](../mobile.md#the-release-builds-shape-and-what-google-plays-analysis-asked-of-it); M0 records the
real `.aab`/`.ipa` delta and puts SMTP behind a Cargo feature if it is not worth it for a read-only MVP.

### 1.2 Tauri plugin shape

A local plugin `frontend/src-tauri/plugins/tauri-plugin-mail`, next to `customtabs` and `gallery`. Each
command must be in the plugin's `build.rs` ACL array AND `capabilities/default.json`, or it fails silently
(the plugin-command rule in [mobile](../mobile.md)). **No `http:allow-fetch` entry is involved**: IMAP is a
raw socket in Rust, outside the WebView, so the WebView CSP and the `https://**` allowlist neither help nor
hinder it. Commands (names settled in M1): `mail_account_link`, `mail_account_unlink`, `mail_folders`,
`mail_list`, `mail_fetch_body`, `mail_fetch_part`, `mail_set_flags`, `mail_move`, `mail_search`, `mail_send`,
`mail_status`. Events: `mail://new-message`, `mail://sync-state`, `mail://auth-failed`. **Every command returns
a typed error (`AuthRejected`, `Unreachable`, `CertInvalid`, `Quota`...), never a message to parse**: an IMAP
`NO [AUTHENTICATIONFAILED]` is an answer, a reset socket is not, and only the first may ask for the password
again.

### 1.3 Background, doze, battery, notifications

- **There is no push without a server, and it must be said plainly.** IDLE needs a live TCP connection;
  iOS suspends the app within seconds, Android doze kills sockets, and a foreground service to hold one is a
  battery and Play-policy cost for a student mailbox. The Canari server cannot watch the mailbox (cannot reach
  993, must not hold the password). **So there is NO new-mail notification while the app is closed.**
- **What remains:** (1) IDLE, or 60-120 s polling of `STATUS (UIDNEXT UNSEEN)`, while the app is foreground and
  the tab open; (2) a sync at resume and at tab open; (3) an OPTIONAL Android WorkManager periodic check (15
  min floor, subject to doze) raising a local notification - opt-in, off by default, measured before offered;
  (4) iOS `BGAppRefreshTask`, opportunistic (minutes to hours), a best-effort badge refresh and never a
  promise. **Any background check needs the password without the user present**, which collides with the
  biometric gate (2.1): decision D4.
- A "new mail" signal that arrives hours late is worse than none, so the badge says "as of last sync".

### 1.4 Platform matrix

| Platform | Verdict | Specifics |
| --- | --- | --- |
| Android (arm64) | feasible | JNI platform verifier; foreground IDLE; optional WorkManager poll |
| iOS (arm64) | feasible | Security.framework verifier; no background socket; App Review needs the review notes to explain a third-party mailbox login, and Apple cannot reach a test mailbox, so a screen recording answers the reviewer |
| macOS / Linux / Windows | feasible | same crates; the keystore backend differs (2.1), unverified |
| Web | OUT (decision) | browsers cannot open raw sockets, and the server may not hold the password |

### 1.5 Authentik / MiConnect, OAuth2, app passwords - what is known and not

- **Known:** Canari signs in through MiConnect (Authentik, [auth](auth.md),
  [profiles-and-access](../../profiles-and-access.md)). That SSO does not yield a mailbox credential:
  Partage authenticates IMAP with the mailbox password, and an Authentik OIDC token is not accepted by a
  Zimbra IMAP proxy unless the DSI/RENATER built an OAuth bridge. This was NOT probed (no authentication
  attempt is allowed). The pre-auth CAPABILITY already measured is the evidence to re-read: whether it lists
  `AUTH=XOAUTH2` or `AUTH=OAUTHBEARER` answers part of the question for free.
- **Known (public Zimbra documentation, web search 2026-10-09):** Zimbra supports two-factor authentication
  with **application-specific passwords**, a per-application code generated in the web client for IMAP/POP/SMTP
  clients that cannot do 2FA. Whether RENATER's Partage enables 2FA for EMSE and exposes app passwords is NOT
  documented in anything found: the search returned a university Apple Mail guide for Partage and generic
  Zimbra pages, nothing RENATER-official on OAuth. Native XOAUTH2 for Zimbra IMAP could be neither confirmed
  nor excluded for Partage.
- **UNKNOWN - questions for the DSI (and through them RENATER Partage support):**
  1. Does the school IT charter allow a third-party mail client to hold the user's password?
  2. Is 2FA enabled on Partage for EMSE accounts, and are **application passwords** available? (Best
     realistic case: a revocable per-app password, the main password never entering Canari.)
  3. Does Partage offer OAuth2 (XOAUTH2/OAUTHBEARER) for IMAP/SMTP, and could Canari be a registered client?
     (Cleanest case: tokens, no password.)
  4. Session limits, rate limits and auth-failure lockout (a wrong stored password retried in a loop could
     lock the mailbox: the client stops after ONE `AUTHENTICATIONFAILED`).
  5. Is `etu.emse.fr` the only login form, or `@emse.fr` too for staff; do aliases authenticate?
  6. Any objection to an `ID` command identifying Canari as the client?

### 1.6 Verification without a real mailbox

Nothing is ever verified against the school server. The fixture is a **local IMAP/SMTP server in Docker on the
local estate**: GreenMail (IMAPS 3993, SMTPS 3465) or Dovecot + Postfix with a self-signed CA, run by the
cross-client harness ([README](../../../../tools/cross-client-harness/README.md)). A test build trusts the test
CA through a compile-time feature (2.2). Seed: multipart HTML, inline images, a tracking pixel, a 25 MB
attachment, a non-UTF-8 charset, a 100 000-message folder, and a server dropping the connection mid-FETCH.
GreenMail is not Zimbra, so fixtures replay the real CAPABILITY banner, and one real-mailbox reading stays
owed to the user at the end.

## 2. Security and privacy design

### 2.1 Credential storage

- The secret goes in the **OS keystore through the repo's patched `tauri-plugin-keystore`** (alias-addressed
  items and caller-supplied prompt text, see
  [mobile](../mobile.md#device-key-on-the-biometric-path)), under a NEW alias `mail_credential_{userId}`.
  **A mail password must never share an entry with the MLS device key or the push secret.** Biometric-gated on
  read where the platform allows (Android `BiometricPrompt` with a user-authentication-required key; iOS
  Keychain with user-presence access control).
- **Never** in `localStorage`, IndexedDB, `tauri-plugin-store`, SQLite or any file; never logged. The
  logging mandate in `CLAUDE.md` is for entry and decisions, so credentials travel in a newtype whose
  `Debug`/`Display` print `<redacted>`, and a test greps the full log of a login for the password. Never in a
  URL or a crash report.
- **Rust holds it.** The WebView sends the password ONCE to `mail_account_link`; Rust verifies by logging in,
  writes the keystore, zeroizes its buffers; afterwards JS holds only an opaque `accountId`. A JS heap cannot
  be wiped, so the password lives there for one input handler only: the field is cleared and unmounted at once
  and never bound into a long-lived store.
- **D4:** biometric-gated read means a prompt per mail session and NO background check; a background-readable
  second item (as the MLS push secret has) means weaker at-rest protection. **Recommendation: biometric-gated,
  no background**, consistent with the no-push honesty of 1.3.
- Desktop: Credential Manager / Keychain / Secret Service through the same plugin only if its desktop backend
  exists (not read in this study; verify in M0). If not, desktop is deferred - **no file fallback**.

### 2.2 Transport

Implicit TLS only (993/465). **No STARTTLS-downgrade logic, no plain port, no invalid-certificate switch, no
per-account trust override, no pinning UI** (pinning breaks on chain changes; the platform verifier is the
policy). A certificate failure is a typed `CertInvalid`, a blocking error naming host and reason; the feature
is simply unavailable. The test CA is compiled in only by a Cargo feature that every store archive is asserted
not to carry, the pattern of `bench-observables` (`.github/scripts/bench-observables.sh`). The host comes from
domain detection (3.2) and is never a free field in the MVP: a free host makes the app a generic
credential-sending client and a phishing amplifier.

### 2.3 What happens to the mail

- **Default: memory only** for bodies; envelopes, flags and snippets cached for the open folder.
- **Optional offline cache (D5):** a SEPARATE encrypted store (never the MLS device key), AES-256-GCM per row
  as the Graine/push code already does, a key of its own in the keystore, a short window (30 days of headers,
  bodies on demand). **Wiped on logout, unlink, forced logout and wipe.**
- **Mail never goes to the Canari server, the logs, the MLS layer or any telemetry.** The unread count is
  computed on the device. `FLAG_SECURE` on the reader is decision D6.
- A Canari logout must unlink the mailbox, or the next account on a shared phone reads the previous student's
  mail: one test per session-ending path (logout, account switch, 401).

### 2.4 HTML mail rendering

HTML mail is hostile input: trackers, scripts, CSS exfiltration, form phishing, `javascript:` and `data:` links.

- **Sanitise first** in Rust (`ammonia`): strip script, iframe, object, embed, form, `meta refresh`, `on*`,
  `<base>`, `<link>`; drop `url()` and `@import` from styles. Sandbox flags differ across WebKit and Chromium,
  so one layer alone is a bet.
- **Then render in a sandboxed iframe, `srcdoc`**: `sandbox=""` (no scripts, no same-origin, no forms, no
  popups, no top navigation) and a first-in-document
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`.
  The app's own page CSP (`tauri.conf.json`, nginx) was not read here and is checked in M4.
- **No remote images by default** (tracking pixels): a banner "images distantes bloquees", a per-message
  button, a per-sender allowlist later. `cid:` parts resolve to blob URLs. Remote images, when allowed, are
  fetched by Rust (no referrer, no cookies).
- **Links are the open design point (R4).** A script-less sandbox cannot report clicks to the host, so the
  choice is between rendering the sanitised tree in the host page (Shadow DOM, links as inert anchors handled
  by delegation) and the iframe with a parent-side link list. **M4 settles it with a spike**; the invariants
  are fixed: no script, no automatic navigation, the REAL host shown before opening, opened through the opener
  plugin (today only `webcal(s)` is allowed in `capabilities/default.json`, so `https` and `mailto` are added
  deliberately) after a confirmation; `mailto:` opens the internal composer.
- Plain-text view always available; `text/calendar` parts offer the calendar import and never an automatic RSVP.

### 2.5 Attachments

Downloaded by Rust on tap into the app cache directory (not shared storage); names sanitised (path and control
characters stripped, double extensions shown whole); an auto-fetch cap (10 MB, above it an explicit confirm
with the size); a total cache cap with LRU purge; never auto-opened; handed to the share sheet with the right
MIME. Executable types (`.apk`, `.exe`, `.js`...) warn and offer no "open". Wiped with the account.

### 2.6 Phishing, and a screen that must tell the truth

Asking for the school password inside a student app trains the habit phishing exploits, and a lookalike could
clone the screen. The setup screen says, in French, **"Votre mot de passe reste sur cet appareil, dans le
coffre securise du telephone. Canari ne le recoit jamais."**, names `partage.emse.fr` read-only, and links the
DSI's own statement once it exists. The flow is reachable from ONE place, the mail tab, and never from a push,
a deep link or an in-app message; a deep link must never prefill or trigger the form. **If the school provides
an app password or OAuth (1.5), the screen asks for that instead and says so.**

### 2.7 GDPR / DSI / charter - settle BEFORE building

The school is the controller of the mailbox; Canari processes nothing server-side, but the local cache is
processing on the user's device. To settle (D1, D2): charter permission (1.5 Q1); whether the school wants to
be informed; the CGU/privacy text, which already names Lydia and needs the same user approval; Play's Data
safety form (emails and credentials: processed on device, not collected, not shared) and Apple's privacy
label, both worded carefully because the password is authentication information.

## 3. Product design

### 3.1 Placement

A new "Mail" tab in the phone bar and a desktop section, behind a feature flag (`features.ts` pattern), native
only, and **eligibility by profile: a member with a school address** (the profiles model of
[profiles-and-access](../../profiles-and-access.md); the MiConnect school e-mail is the prefill and the test).
D3: hidden for others (recommended) rather than greyed. Navigation follows
[section-navigation](../section-navigation.md): hub, route segments, breadcrumb. The iOS bar is native
([mobile](../mobile.md#the-native-ios-tab-bar)), so a new tab touches two native bars that only hardware can
read: counted in M3.

### 3.2 Account setup flow

1. Intro: what stays on the device (2.6), and the plain statement that nothing notifies while the app is closed.
2. Address prefilled from the profile (`prenom.nom@etu.emse.fr`). **Domain detection is a closed table**
   `etu.emse.fr` and `emse.fr` mapping to `partage.emse.fr`; any other domain is "non pris en charge".
3. Password (or app password) and "Tester la connexion": Rust does CAPABILITY and LOGIN over TLS, returns a
   typed outcome, writes the keystore on success, starts the first header sync.
4. Biometric enrolment for the read gate (2.1).
5. Unlink, with confirmation: credential and cache die.

### 3.3 Screens

Folders (INBOX, Sent, Drafts, Trash, Junk, Archive from `LIST` special-use attributes, not names; unread via
`STATUS`). Thread list, headers first (ENVELOPE, FLAGS, a short `BODY.PEEK` snippet), paged by descending UID,
virtualised; threads built client-side from `References`/`In-Reply-To`. Reader: BODYSTRUCTURE, then only the
preferred part, `BODY.PEEK` so merely fetching is not \Seen. Compose, reply, reply-all, forward (lettre; Sent and
Drafts filed by IMAP `APPEND`, since SMTP does not file them - verified on GreenMail). Search by server
`UID SEARCH` over FROM, SUBJECT, TEXT, no local index in the MVP. Flag, move, delete.

### 3.4 Offline, weak network, sync

Headers first, bodies lazy, attachments on tap. ONE connection per account, serialised through a command queue
in Rust (session limits are DSI Q4). `UIDVALIDITY` change drops that folder's cache. Reconnect with jittered
backoff that ENDS on an auth rejection. Mail has its own send queue with at-most-once send per entry and one
process lock, the lesson of [mobile](../mobile.md#background-execution); the MLS outbox is not reused. Typed
timeouts, never a spinner for ever.

### 3.5 Unread badge

The tab shows INBOX `UNSEEN` from `STATUS`, refreshed on foreground, IDLE and poll, labelled "as of last sync".
No app-icon badge from the background (1.3).

## 4. Work packages (small, ordered; effort in working days, estimates)

| WP | What | Test | Verification | Effort |
| --- | --- | --- | --- | --- |
| M-Q | The DSI questions (1.5) and decisions D1-D8 | n/a | the answer recorded on this page | 0.5 + wait |
| M0 | Spike: plugin skeleton; crates compile for android arm64, ios arm64, Windows, Linux, macOS; platform verifier initialised; size and build delta recorded | CI `cargo check --target ...` | a TLS handshake to the local fixture ON a phone (compiling proves nothing) | 2-3 |
| M1 | Rust core: connect, typed errors, LOGIN, LIST, STATUS, UID FETCH headers, behind a trait so tests inject a fake stream | `cargo test` against GreenMail plus fake-stream cases (malformed responses, drops, huge literal) | harness local estate | 4 |
| M2 | Vault: keystore alias, biometric gate, redacted newtype, zeroize, wipe on every session-ending path | login log greps clean of the password; each wipe path leaves no alias or file | Mi 9T and iPhone 12 (keystore and biometrics are hardware) | 3 |
| M3 | Setup UI, flag, eligibility, tab on both native bars, Paraglide fr/en strings, the "stays on device" screen | component tests, i18n parity | phone render | 3 |
| M4 | Reader: BODYSTRUCTURE, text part, sanitiser, link spike (R4), sandboxed render, remote-image block, `cid:` | XSS/tracker/CSS corpus, CSP asserted | hostile-mail fixture; the pixel never hits the fixture's access log | 5 |
| M5 | Folders, thread list, flags, move/delete, search, paging, badge | UID-state tests, `UIDVALIDITY` reset, 100k-folder bench | harness and a phone scroll | 4 |
| M6 | Compose/reply/forward, SMTP, APPEND, offline send queue | send-twice race test; MIME round-trip | GreenMail receipt; the real server only to a DSI-sanctioned address | 5 |
| M7 | Attachments: download, caps, LRU, share, executable warning | name-sanitiser table, cap tests | phone share sheet | 2 |
| M8 | Encrypted offline cache (if D5) | GCM tamper, wipe, migration | [device-verification](../../device-verification.md) style reading | 3-4 |
| M9 | Foreground IDLE/poll and resume sync; OPTIONAL Android WorkManager check | flapping-server reconnect test | phone doze run (owed hardware) | 2 + 2 |
| M10 | Store texts (Data safety, Apple label, CGU wording: user approval), changelog | wiki-links test | review | 1 |

Order: M-Q, M0, M1, M2, M3, M4, M5, then M6 and M7 in parallel, M8, M9, M10. **The MVP (read-only, no cache) is
M-Q to M5 plus M10, about 22 days.** It ships as a pre-release to testers first ([cicd](../../cicd.md)), never
straight to stable. One reading on the user's own real mailbox is the only thing that cannot be automated.

## 5. Risk register

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Charter forbids a third-party password / DSI refuses | blocks all | M-Q first; prefer app password or OAuth; stop if refused |
| R2 | Credential leak (keystore, logs, JS heap) | P1 | 2.1: keystore + biometrics, Rust-held, redaction newtype and test, no fallback |
| R3 | A wrong-password retry loop locks the mailbox | P1 | stop after ONE auth rejection; backoff only on transport failures |
| R4 | HTML mail XSS, tracking, link phishing; sandbox cannot report clicks | P1 | sanitise + CSP + sandbox, no remote images, real-host confirm, M4 spike |
| R5 | Users believe there is push and miss mail | P2 | no-push statement on setup and badge; opt-in poll only |
| R6 | iOS review rejects a third-party mail login, or privacy labels wrong | P2 | review notes and recording; pre-release round first |
| R7 | TLS provider/roots wrong on mobile (green host build, dead phone) | P2 | M0 phone handshake; one provider; platform verifier |
| R8 | Logout on a shared phone leaves mail or credential | P1 | wipe on every session-ending path, one test each |
| R9 | Size and build-time growth, Play size policy | P3 | measure in M0; SMTP behind a Cargo feature |
| R10 | Unknown server limits (sessions, rate) | P2 | DSI Q4; single connection |
| R11 | Zimbra quirks GreenMail does not reproduce | P3 | fixtures replay the real CAPABILITY; one real reading owed |
| R12 | Scope creep into a full mail client | P3 | read-only MVP; compose is its own package |

## 6. Decisions the user must take

- **D1** Ask the DSI first, and who writes (1.5 Q1-Q6)? Nothing is built before.
- **D2** Is the CGU/privacy wording change (mail processed on device, password in the keystore) approved?
- **D3** Who sees the tab: members with a school address only (recommended) or everyone with an opt-in?
- **D4** Biometric-gated read with no background (recommended) or a background-readable credential for polling.
- **D5** Offline cache: none in the MVP (recommended) or encrypted with a retention window.
- **D6** `FLAG_SECURE` on the reader.
- **D7** MVP scope: read-only first (recommended) or compose in the first pre-release.
- **D8** Desktop in v1 or phones only (desktop keystore backend unverified).

## See also

[mobile](../mobile.md), [auth](auth.md), [profiles-and-access](../../profiles-and-access.md),
[backlog](../../backlog.md), [durable-rules](../../durable-rules.md).
