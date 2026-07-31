# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES**

- NO BLIND GREP: Never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: State assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
- STATE PRUNING: When updating the roadmap, DELETE detailed descriptions of completed tasks. Keep the file small.
- CLAUDE.md HYGIENE: Actively trim this file. DELETE shipped Work Packages (keep only forward-relevant gotchas), collapse redundant notes, drop stale entries.
- UPDATE STATE: Update SESSION STATE at the bottom of this file before finishing a Work Package.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> `git add . && git commit -m "[summary]"` -> Update SESSION STATE" -> STOP (compact)
- DOCUMENTATION: Technical docs live in `docs/wiki/` (English, LLM-oriented, preferred search before code). User-facing guides in `docs/user-guide/` (French). UML diagrams in `docs/diagrams/`. Root-level docs: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- CHANGELOG: When adding features, fixing bugs, or making breaking changes, add an entry under `[Unreleased]` in `CHANGELOG.md` (Keep a Changelog format). Move to a version section on release.
- WIKI IS PREFERRED: Always search `docs/wiki/` before reading source code. Update the relevant wiki page alongside code changes — stale wiki is worse than no wiki. Cross-link freely between pages.
- SERVICE READMES: Each `apps/*/README.md` should stay synced with its wiki counterpart. If you expand the wiki page, reflect the summary in the README.
- PROD ACCESS: `ssh canari` or `ssh mitv`.
- CLASSIFIER DOWN: End of session signal. Stop ASAP, prepare compaction + easy resume for next session.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (Front) | Rust WASM openmls | NestJS + Rust Axum (Back).
- Nginx: Single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: Always rebuild WASM (`mls-wasm/`) and protobufs (`npm run proto:gen`) after structural changes.
- Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via `canari_ws_token`.
- Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.
- Infra Truth: Keep `infrastructure/MIGRATION.md` synced with new secrets, services, or bootstrap steps. When adding a new service or infrastructure component, add it to the wiki (`docs/wiki/infrastructure/`) and `README.md` architecture diagram.

## **CODING STANDARDS**

- Logs: Mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions, and error branches.
- Docs & Comments: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, do not restate types. All documentation files (`docs/`, `*.md` at root) are English except `docs/user-guide/` (French, user-facing).
- Factorization: Extract and export reusable logic. Zero duplication.
- Language: Code, comments, docs, and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline string literals.
- Punctuation: Normalize to ASCII (`'`, `"`, `-`) everywhere; escape quotes in code (`\'`, `\"`). Preserve French accents (`é`, `à`) ONLY in localized strings/French comments.
- Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.
- UI: Single source of truth is `src/app.css` (tokens, `--radius-*`). Use `.btn-glass` with modifiers. Dark-first glassmorphism. Avoid raw hex/px. `lucide-svelte` only (no aliases).
- Husky: Pre-commit runs oxlint + oxvelte + oxfmt + svelte-check. Fix errors; do not bypass.

## **KEY COMMANDS**

- Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); Makefile shells out to npm - both work. Prefer bun locally.
- Setup/Dev: make install, make run-services, cd frontend && bun run dev
- Tests: make test (All), make test-frontend, cargo test
- Frontend gates (before every commit): bun run check (0 errors), bun run lint, bun run format. Rust >= 1.93 (`rust-toolchain.toml`). cargo clippy for Rust crates. Pre-commit hook runs oxfmt+oxlint+oxvelte+check across WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

## **SESSION STATE (Active Memory)**

State lives HERE (canonical). Five repos, all `emse-students/*`:
Canari (this monorepo) | Sky (../Sky) | MiGallery (../MiGallery) | Portail-etu (../refonte-portail-etu)
| **Le Cercle (../le-cercle)**.
Sky, MiGallery and Portail-etu are COMPLETE - nothing open on any of them.
All on `main` EXCEPT Le Cercle: that repo has another primary developer, so work happens on the
branch `audit/security-and-canari-integration` and ships as a PR. Never commit to its `main`.

Work is tracked as Work Packages ordered by severity: **P1** (security, or a user-facing path that
is broken), **P2** (correctness, nothing at risk), **P3** (hygiene). `[ ]` open, `[~]` in progress.
Delete a WP outright once it ships: the rule it taught goes to DURABLE RULES, the story to
`CHANGELOG.md`.

---

### LE CERCLE (../le-cercle) - OPEN WORK PACKAGES

Branch `audit/security-and-canari-integration`, forked from `main` @ `df692f2`. SvelteKit 5 +
`bun:sqlite` (file DB, `DB_PATH`), hand-written SQL modules under `src/lib/server/db/`, migrations
= numbered files in `db/sql/migrate/` replayed by `bun run db:migrate` (the runner wraps each file
in a transaction - so NO `BEGIN`/`COMMIT` and no `PRAGMA foreign_keys` inside a migration).

**Architecture decisions taken 2026-07-28 (do not re-litigate):** ledger + cached column; the
Cercle keeps `memberships` as a display-only mirror while Canari owns tier assignment; cercleux
get site access without a cotisation but may NOT consume; cash top-ups allowed with an audit
trail; Canari credits but never displays the balance.

**Cercle gotchas (cost time once, will again):** `bun run dev` MUST run Vite under Bun
(`bun --bun vite dev`) or `bun:sqlite` fails to import and every request 500s. A SvelteKit layout
`load` does NOT run for a child page's form action, so `gestion/+layout.server.ts` protected
nothing that POSTs - each action guards itself. `CANARI_INTEGRATION_ENABLED=false` is the local
switch: it freezes the cotisant snapshot instead of refreshing it, and never opens the gate.

- \[~\] **WP-CERCLE-1 (P1) - Audit + security fixes + Canari double link.** CODE COMPLETE (3 commits,
  50 files), 27/27 end-to-end checks green against an HTTP stub of `cotisant-status`.
  **MR open, awaiting Aurel: https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/1**
  (GitLab over SSH - `gh` is useless and there is no API token here; **git refuses a push option
  containing newlines**, so the full French description must be pasted by hand from
  `...\Temp\claude\c--Users-jolan-Documents-Programmation-canari\2df0218a-c456-4153-8f17-1a97db43e51b\scratchpad\MR-DESCRIPTION.md`,
  also a TEMP path).
  Still owed before merge, both blocked on the site being online: a run against a REAL Canari
  (`CANARI_INTEGRATION_ENABLED=true` has never been exercised - 24 h grace window and TTL refresh
  untested against a live `cotisant-status`) and a real OIDC round trip (the checks mint their own
  cookies). Runbook: `docs/PROD-TEST-CERCLE.md`, checks V1-V6.

- \[ \] **WP-CERCLE-2 (P3) - No way to correct a mis-keyed consumption.** The ledger is
  append-only and the user declined an `adjustment` kind, so a drink charged twice or to the wrong
  account cannot be undone. Revisit once the bar has used it for a term.

- \[~\] **WP-CERCLE-3 (P3) - Dev secrets are in the working `.env`.** The two real values ARE
  generated (2026-07-30), in the session scratchpad `CERCLE-PROD-SECRETS.md` with the posting
  procedure - outside every repo on purpose. All that is left is putting them in the prod env and
  deleting that file. Rotating `SESSION_SECRET` is also the only way to revoke every session at once;
  `CANARI_WEBHOOK_SECRET` must equal the Canari product's `webhookSecret` exactly (see WP-INT-1).

---

### CANARI - OPEN WORK PACKAGES

- \[~\] **WP-VERIF-0..4 + the DEEPLINK-1 and UI-1 residuals (P1 to P3) - [device] one single pass.**
  Everything native is verified by COMPILING, which proves nothing about running. The ordered
  cross-platform runbook is **[device-verification](docs/wiki/device-verification.md)**: checks B-J,
  which WP each one closes, and the exact log line that is the verdict for each. Do not re-derive
  the checks here; extend that file instead. Check A (the upgrade path) was RETIRED 2026-07-31: it
  needed a deliberate downgrade to a pre-WP-SEC-1 build, and every install worth testing has
  migrated. Build under test: **v0.11.7**, on TestFlight
  and Play production since 2026-07-31 - the first build carrying WP-PUSH-1/2, HIST-1 and NET-1.
  Its native half is COMPILED, and checked the honest way: the iOS log shows
  `SwiftCompile normal arm64 .../NotificationService.swift` and a `canari_push.o`, so neither was
  silently missing from the hand-maintained pbxproj. Compiling still proves nothing about running.
  Already banked from the Android run of 2026-07-29 (log on the user's desktop): SQLite storage on
  every launch, never the IndexedDB fallback; and the post-enrolment relaunch does raise the
  biometric path, so the `89f8d230` `isKeyPresent` fix holds. One bug found there and fixed in
  v0.11.5 (the `Base64.DEFAULT` newline) - check G is its re-run.
  **Check G is CLOSED on Android: G.2 passed on v0.11.5, G.3 and G.4 on v0.11.6 (2026-07-30).**
  Two cold biometric launches, no `Call ignored`, no PIN modal, no `Failed to decrypt SQLite row`,
  one prompt per login - and a 51-message history bundle served out of the local store where the
  session had started from 50, which is the proof the biometric session both writes and reads.
  **Checks I and J are CLOSED on Android too (2026-07-31, v0.11.7, log on the user's desktop).**
  That run also exercised B-H incidentally and the user reports everything working except the two
  notification defects now tracked as WP-NOTIF-1. **ANDROID IS DONE; the whole runbook is still
  owed on iOS.** Anomalies the log itself showed, all filed below: WP-NOTIF-1 (the quick reply
  leaves no local trace), `GET /api/users/system` 404, and two French dev log lines in
  `outboxMirror.ts`.
  **Android capture tool: `test_adb.py`** at the repo root (tkinter GUI: build, install, per-device
  logcat with the runbook's tags already whitelisted).

- \[~\] **WP-NOTIF-1 (P2) - Notification quick actions.** (a) and (b) are CODE COMPLETE, NOT
  COMPILED (native: Kotlin + ObjC), and unverified on device; (c) is what is left to build.
  (a) *"Repondre" left no local trace.* It always DID send (`handleReply: queued`,
  `sendQueuedMessagePush: HTTP 201`, `1 sent, 0 remaining`) but the reply is built natively and
  never becomes an outbox entry, and `reconcileOutboxSent` only DELETES entries - so the sender's
  own conversation showed nothing. FIXED both platforms by writing the delivered reply to
  `fcm_message_cache.ndjson` under OUR user id (`writeSentMessageToCache` /
  `CanariWriteSentMessageToCache`).
  (b) *Our own avatar was blank in the thread.* FIXED: `selfPerson` now gets `fetchAvatar`, via a
  new `MlsContextLoader.loadUserId` (no Keystore hop). Android only - iOS has no self Person.
  (c) *STILL OPEN: an UNDELIVERED quick reply is silently dropped.* It lives only in
  `outbox_pending.ndjson`, and `store_outbox_mirror` REWRITES that file from the TS queue, so the
  next foreground outbox mutation wipes it instead of flushing it. The notification is left up as
  the retry affordance, deliberately. The real fix is adopting an unknown mirror entry back into
  the TS outbox at boot - the symmetric twin of `read_and_clear_outbox_sent`.
  **Both native halves need a `workflow_dispatch` compile run before they are believed** (grep the
  logs for `CompileC ...canari_push.o` and the Kotlin task), and check that a quick reply now shows
  up in the sender's own conversation after the app reopens.

- \[~\] **WP-DEV-PANEL-1 (P2) - Why is the current device missing from its own list?** The harm is
  FIXED (deleting the last device is refused; an unlisted current device is now named on screen and
  logged). The cause is NOT known: the panel was always correct, the server's list simply had no
  row matching `myDeviceId`. `getUserDevices` can omit us three ways - the 90-day `createdAt`
  cutoff (unlikely, `registerDevice` refreshes it on purpose), an unresolvable KeyPackage, or a
  `revoked_devices` row from an earlier deletion, which is permanent and fits best. Verdict line,
  on opening the panel: `[DevicePanel] Current device <id> is ABSENT from its own list`.

- \[ \] **WP-AGENDA-1 (P3) - No edit/delete on the global agenda.** The buttons exist only inside
  the owning association, so a sys admin (or a BDE member holding the permission) has to find which
  association filed an event before they can touch it. Same permission check, second surface.

- \[ \] **WP-PDF-1 (P3) - Three defects in the event PDF export.** The second association's logo is
  missing when an event has two; the background image is not cropped, so it leaves bands down the
  sides; and the sheet has rounded corners - a page of paper is a rectangle.

- \[ \] **WP-FWD-1 (P2) - One forwarded message was silently lost. OBSERVATIONAL, by decision.**
  2026-07-29, prod, channel -> DM: the toast said success, the echo persisted on the sender, the
  outbox drained - and the peer never received it, not live and not after a reload. Two later
  attempts through the same path both delivered, so it is NOT reproducible. Nothing is specific to
  forwarding: `forwardMessage` hands text to the same `sendChatMessage` the composer uses. The
  instrumentation it needs already shipped (`ca8e3ef0` made every swallowed outbox branch log), so
  the decision taken 2026-07-30 is to WAIT for a recurrence rather than audit the delivery layer
  blind - touching a queue that works, with no repro, risks more than it fixes. If it recurs,
  capture `[OUTBOX]`/`[QUEUE]` on both sides at the moment of loss.

- \[ \] **WP-UI-1 residual (P3) - one open question, no code left.** The sweep is done (390 -> 31,
  and the 31 are deliberate: switch thumbs, colour-picker handles, always-dark call/lightbox
  chrome, the white plate behind a QR). Detector: `frontend/scripts/find-oneway-colors.mjs`. The one
  open question (the enrolment sheet reporting DARK under a LIGHT theme) is check I of the runbook.

- \[ \] **WP-INT-1 (P3) - Cercle webhook credentials.** Set the real `webhookUrl`/`webhookSecret`
  on the prod `balance_topup` product. Blocked on the Cercle site going online.
  **Contract verified 2026-07-29 against `../le-cercle` (code read on both sides, nothing run):**
  `dispatchCercleWebhook` POSTs `{productId, userId, amountCents, paymentIntentId, timestamp}` with
  `X-Canari-Signature: sha256=<hex HMAC-SHA256 of the RAW body>`; `verifyWebhookSignature` +
  `/api/canari/topup` expect exactly that, sign the raw body too, and read the same field names.
  `userId` IS the OIDC `sub` = `users.uuid` there, so no id mapping. Replays are idempotent on
  `paymentIntentId`. The two sides agree.
  Two operational traps for the day it goes live: Canari sets `maxRedirects: 0` and accepts 2xx
  only, so `webhookUrl` must be the FINAL https URL (an http->https redirect fails every delivery);
  and the Cercle answers **404** for a user who has never logged into its site, which Canari counts
  as a failure - after 3 attempts that top-up sits in `webhook_deliveries` as `failed` and needs a
  manual retry from the admin panel. `CANARI_WEBHOOK_SECRET` (Cercle env) and the product's
  `webhookSecret` (Canari) are the same string under two names.
  **The secret itself is already generated** (2026-07-30), together with the Cercle's
  `SESSION_SECRET`, at
  `%LOCALAPPDATA%\Temp\claude\c--Users-jolan-Documents-Programmation-canari\9451e6ef-4c01-4c18-8203-df740c9d9476\scratchpad\CERCLE-PROD-SECRETS.md`
  - deliberately outside every repo, with the posting procedure and these two traps repeated. That
  file closes WP-CERCLE-3 as well; delete it once both values are in place. It sits in a TEMP
  directory: one cleanup and both secrets have to be regenerated (which is harmless as long as
  neither has been posted yet - they are only paired, never derived).

---

### CANARI - DURABLE RULES

One line per rule, with the page that carries the reasoning. If a rule needs a paragraph, the
paragraph belongs in `docs/wiki/` - put it there and leave the pointer here.

#### MLS state and keys -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [auth](docs/wiki/frontend/modules/auth.md)

- An at-rest envelope change needs a reader for the previous format in the SAME commit.
- `classifyStateLoadFailure` alone decides: `sealed` honours `noFreshStart`, `mismatch` must not.
- After any fresh start, persist the new state BEFORE anything else can fail (or churn loop).
- `isValidPin` (>= 4 chars) guards setup, change, recovery AND unlock - one rule, or a lockout.
- `applyNewDeviceKeyLocally` must NEVER call `BiometricService.disable`.
- The background copy of the device key is a keystore entry, never a file.
- Raw 32 bytes at rest, base64 on the FFI wire; Android must encode with `NO_WRAP`.
- Android has TWO readers per keystore alias (`MlsDeviceKeyStore` bg, `KeystorePlugin` fg) - fix both.
- Escape hatch: "forgot PIN" wipes state and restarts, at the cost of local history.
- Rust's copy of the device key seals `mls.bin` only - local messages are encrypted in the
  FRONTEND, so biometric mode must pull the key back (`recuperer_cle_session_mls`) or persist nothing.
- `isLoginInProgress` is one flag with two owners: every entry point must release it before `loginImpl`.

#### Community channels -> [chat](docs/wiki/frontend/modules/chat.md), [social-service](docs/wiki/services/social-service.md)

- Never return a `Channel` entity to a client: it carries `masterSecret`. Project fields explicitly.
- A slug is not an authorization - `getWorkspaceBySlug` gates on membership.
- `/c/<groupId>` and `/chat/<groupId>` are NOT routes; a conversation opens by publishing to `notifNav`.
- A deep-linked selection must outlive the route remount, and is held until DISPLAYED, not selected.
- A channel target can only be opened on `/communities`; `openInvitedChannel` is the one entry point.
- Holding a landing means nothing without a rule for abandoning it - but a refetch that FAILED
  proves nothing about its target, so it holds and retries; only a refetch that SUCCEEDED abandons.
- "A refresh ran" and "the list is current" are two different facts; a loader that conflates them
  empties the sidebar on one dropped request. Fail loudly in state, never by returning stale truth.
- A removal broadcast reaches every REMAINING member too - read `kickedUserId` before acting.
- A channel bubble is keyed by the SERVER row id, everywhere.
- Channel reactions are a cleartext server tally; DM reactions are encrypted MLS system messages.

#### MLS membership and routing -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [chat-delivery](docs/wiki/services/chat-delivery.md)

- MLS membership says who can decrypt; `DeviceGroupMembership` says who is actually sent to.
- An external commit is the one join path with no Welcome - pass `redeliverMissed: false`.
- The unread badge is derived via `isUnreadForUser`, never stored; recount AFTER the metadata merge.
- A community is soft-deleted, never dropped; `DELETE workspaces/:id` needs MANAGE_WORKSPACE only.
- `channel.moderate` = pin or delete SOMEONE ELSE's message, nothing more.
- Dead devices are reaped after 90 days - until then a churned id keeps receiving fan-out.

#### Outbound delivery -> [chat](docs/wiki/frontend/modules/chat.md)

- The outbox is best-effort at every step, so every swallowed branch logs - that is all a loss leaves.
- MLS gives no echo of your OWN message, so the sender's optimistic update is the only writer it
  gets: apply it in memory AND persist it (`persistLocalMutation`), or it dies at the next load.
- A field absent from `db/messagePayload.ts` does not survive a reload, whichever backend is used.
- `waitForMessageQueueIdle` before a flush is correctness: skipping it sends at a stale epoch.
- A history request is online-only. The requester can retry and SAY it is waiting (v0.11.7); only
  a real background wake could answer it, and that is unbuilt on purpose.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md)

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens.
- Detect one-way colour per CLASS LIST (`find-oneway-colors.mjs`), never per file.
- A `@theme` entry is what makes a token exist - an undefined token is silently inert.
- A native prompt is UI you only partly own: `reason` alone leaves the plugin's English defaults up.
- But Android stacks title+subtitle+description and adds its own hint - four fields, four lines.
- No user-facing string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time).
- A native process cannot resolve a locale, so prompt text must travel down the call.
- Nothing types a string as user-visible, so no compiler enforces Paraglide.
- Re-run `bun run paraglide:compile` before `bun run test` after any build.

#### Server-side fetches -> [chat-delivery](docs/wiki/services/chat-delivery.md)

- One predicate guards every fetch of a user-supplied URL, before the fetch AND at connect time.
  RFC 1918 is not the whole blocklist: `0.0.0.0`/`::`, IPv4-mapped IPv6, bracketed literals.

#### Contracts the compiler does not check -> [development](docs/wiki/development.md)

- Tauri command names are unchecked strings on both sides.
- A plugin command needs THREE things right: plugin-name prefix, snake_case fn, `build.rs` + ACL.
- `push_context.json` is a JSON contract across four languages; only its test catches drift.
- Pin the cross-process PATHS too, not just the field names: off macOS, `fcmCacheFields.test.ts` is
  the only thing standing between a Swift writer and a directory nothing ever reads.
- A `postMessage` payload is typed by nobody - contracts live in `mlsWorkerProtocol.ts`.
- Never let a capability probe swallow its own failure.
- `getStorage()`'s IndexedDB fallback is a last resort, not a mode.
- A vendored plugin still ships the sample it was forked from - delete what you did not fork it for.
- Never redeclare an `init`/lifecycle override with fewer parameters.
- NEVER branch on an error message - use the typed `LoginErrorCode`.
- "Logged in" means two things: MLS ready vs the OIDC session.
- A migration outlives the schema it was written against.

#### Mobile and native -> [frontend/mobile](docs/wiki/frontend/mobile.md)

- iOS push = all-FCM, one transport; the App Delegate Proxy must stay enabled.
- Firebase 12: `didReceiveMessage:` is GONE - hook `CanariHandleFcmData()`.
- Branch with `isIosTauriRuntime()`/`isMobileTauriRuntime()`, and decide mobile-wide vs Android-only.
- iOS pbxproj is hand-maintained (NOT xcodegen).
- iOS keychain service `fr.emse.canari`, accounts `mls_key_<alias>` and `mls_bg_key_<alias>`.
- Kotlin nested types go on the OUTER class body, never a companion object.
- An app extension has its OWN data container: `app_data_dir` inside the NSE is not the app's. The
  App Group is the only shared storage, so a cross-process file needs a hop, and a path that is
  right in the app process is silently wrong in the extension.
- The NSE runs on a locked device - write with `...UntilFirstUserAuthentication` or not at all.
- Catch up commits BEFORE the join race: a Welcome race is only possible on a group that is not
  local yet, so on a local group the race is pure latency.
- Background decrypt applies no commit, so a silent commit push leaves the next message unreadable -
  that is the epoch gap, not a bug to retry through.
- Only user-VISIBLE native strings stay French; everything read while debugging is English.

#### Release and CI -> [cicd](docs/wiki/cicd.md)

- A manual `workflow_dispatch` run of either release workflow is a pure compile check that ships
  nothing - and the ONLY way to compile Swift/ObjC/Kotlin from Windows. Run both before believing
  any native change.
- A green run is not proof YOUR file compiled - the iOS pbxproj is hand-maintained, so a source
  missing from it is skipped, not failed. Grep the log for `SwiftCompile ...<file>.swift` /
  `CompileC ...<file>.o`.
- Two NAMED provisioning profiles, team `4CLNB8SR6L`, expire 2027-07-11.
- `bump-app-version.sh` must patch the NSE too, and `bump-version.yml` stages an EXPLICIT add list.
- Never add a `branches` filter to a `workflow_run` chained off a release-triggered workflow.

#### Carte de la Vie Asso -> [carte-vie-asso](docs/wiki/carte-vie-asso.md)

- A published carte is the poster RESOLVED (poster px + `stage`), never fractions and never a layout.
- A constant the publisher needs cannot live in `PosterCanvas.svelte` - unit geometry is `layout.ts`.
- The showcase decides nothing: what it is not told, it cannot copy - it can only approximate.
- Association identity joins live; the displayed members are a snapshot, so a roster edit republishes.
- The two repos must agree on the FONTS, or every measured box is wrong.
- What must fit a card is the longest WORD, not the name: shrink to it, then widen the card.
- A card's `photo` is published, never derived from its width - widening must not grow the face.
- A debug slider whose panel is gone still ships: fold it back into constants, or it rots as plumbing.

#### Cotisations (Cercle) -> [cotisations](docs/wiki/cotisations.md)

- The XOR has ONE implementation, `UserTagService.revokeSiblingTierTags`.
- A tag revoke MUST be scoped to `issuingAssocId`, or it is a cross-tenant IDOR.
- `variantKey` is editable and the tags follow; convert rather than delete a tier with cotisants.
- Named tiers sort before the base tier, so a legacy base-tag holder is not reported as `tier: null`.
- Cotisant status is server-authoritative - no client-side tag derivation.

---

### SHARED GOTCHAS -> [development](docs/wiki/development.md), [cicd](docs/wiki/cicd.md)

- Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@`.
- Backend lint needs `npm install` in the app dir (bare `oxlint`/`oxfmt` + repo-level configs).
- The pre-commit hook sweeps the WHOLE frontend and re-stages - isolate unrelated dirty files.
- Before push: `rm -rf apps/*/dist`, then `git pull --rebase --autostash origin main`.
- Commit signing is ON globally over SSH - all commits Verified, do NOT disable.
- Never assert a wall clock in a test; two isolated browser contexts = two devices.
- Portail: SPA (`ssr = false`); `data-export/` holds PII, never commit.
- Sky UI French must keep accents + straight apostrophes.
