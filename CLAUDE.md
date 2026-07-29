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
  containing newlines**, so the full French description must be pasted by hand from scratchpad
  `MR-DESCRIPTION.md`).
  Still owed before merge, both blocked on the site being online: a run against a REAL Canari
  (`CANARI_INTEGRATION_ENABLED=true` has never been exercised - 24 h grace window and TTL refresh
  untested against a live `cotisant-status`) and a real OIDC round trip (the checks mint their own
  cookies). Runbook: `docs/PROD-TEST-CERCLE.md`, checks V1-V6.

- \[ \] **WP-CERCLE-2 (P3) - No way to correct a mis-keyed consumption.** The ledger is
  append-only and the user declined an `adjustment` kind, so a drink charged twice or to the wrong
  account cannot be undone. Revisit once the bar has used it for a term.

- \[ \] **WP-CERCLE-3 (P3) - Dev secrets are in the working `.env`.** `SESSION_SECRET` and
  `CANARI_WEBHOOK_SECRET` there are throwaway placeholders. Generate real ones for prod
  (`openssl rand -base64 48`); rotating `SESSION_SECRET` is also the only way to revoke every
  session at once.

---

### CANARI - OPEN WORK PACKAGES

- \[ \] **WP-VERIF-0 (P1) - [device] WP-IOS-1 + WP-SEC-1 shipped unverified.** Both release
  workflows compile green on both platforms (`89f8d230`), but compiling is not running: the Android
  keystore read and the whole iOS half have never executed on hardware. The 5 device checks that
  gate the verdict - including the upgrade path, the only test of the one-shot migration - are in
  `AGENTS.md` "what is still owed"; check 2 doubles as the first ever proof that iOS background
  decrypt works at all. **Blocks WP-VERIF-2.**

- \[ \] **WP-VERIF-1 (P1) - [device] Tauri login end to end (init + save + KeyPackage).** All three
  were dead from v0.11.0 to v0.11.2 (`invoke` names matching no Rust command). Native has NOT run
  since. TestFlight/Play is the first real test; nothing here is proven until it does.

- \[ \] **WP-VERIF-2 (P2) - [device] Decrypted push notification on Android AND iOS.**

- \[ \] **WP-VERIF-3 (P2) - [device] Login, PIN change, biometric enable/disable on real hardware.**
  Now also gates the v0.11.5 keystore fix: after enrolling a fingerprint, a relaunch must open the
  BiometricBottomSheet (not the PIN modal), and the PIN modal must keep its "use fingerprint"
  button. Second check on the same launch: the log must say `[DB] Using SQLite storage (Tauri)`,
  never the IndexedDB fallback. Both were broken for every fresh install before this commit.

- \[ \] **WP-VERIF-4 (P3) - [device] WP-XP-8 retry engine.** Android `OutboxRetryWorker`
  (WorkManager, exp backoff 30s+, 3 failures -> persistent flag + nudge) and iOS `BGTaskScheduler`
  `fr.emse.canari.outboxRetry`. Both fire from `maybeNotifyPendingSync` when an opportunistic drain
  leaves `remaining > 0`. Never observed waking up on hardware.

- \[ \] **WP-DEEPLINK-1 residual (P3) - one entry point unverified.** The fix shipped and is
  verified on prod (see VERIFIED ON WEB below). The **OS notification tap** could not be driven
  from a headless browser; it publishes to `notifNav` exactly like the two link paths that were
  verified, so re-check it on device during WP-VERIF-3.

- \[ \] **WP-FWD-1 (P2) - One forwarded message was silently lost.** 2026-07-29, prod, channel ->
  DM: the toast said success, the echo persisted on the sender, the outbox drained - and the peer
  never received it, not live and not after a reload. Two later attempts through the same path
  (including a cold reload, to reproduce the conditions) both delivered, with a read receipt, so it
  is NOT reproducible. Nothing here is specific to forwarding: `forwardMessage` hands text to the
  same `sendChatMessage` the composer uses, and a control message sent right after arrived. Suspect
  the outbox/MLS delivery layer. If it recurs, capture `[OUTBOX]`/`[QUEUE]` on both sides at the
  moment of loss - that is what is missing to diagnose it.

- \[ \] **WP-UI-1 residual (P3) - one open question, no code left.** The sweep is done (390 -> 31,
  and the 31 are deliberate: switch thumbs, colour-picker handles, always-dark call/lightbox
  chrome, the white plate behind a QR). Detector: `frontend/scripts/find-oneway-colors.mjs`.
  Still unexplained: the enrolment sheet reported DARK under a LIGHT theme. The `dark:` variant is
  correct on web (verified by computed style in both themes), so the suspect is the native
  runtime - re-check on device during WP-VERIF-3.

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

- \[ \] **WP-CARTO-1 (P2) - Publish an association map from Canari to the Portail.** Canari can
  already build an association map; add a button that publishes one to the Portail
  (`../refonte-portail-etu`), where it must render on wide screens (PC) ABOVE all the association
  tiles. Explicitly NOT a static image or PDF: the published map is interactive - clicking an
  association navigates to that association's page, with a hover animation. Two repos, so the
  published artefact is a data contract, not a rendering; decide where it is stored and how the
  Portail (SPA, `ssr = false`) fetches it before writing any UI.

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
- Escape hatch: "forgot PIN" wipes state and restarts, at the cost of local history.

#### Community channels -> [chat](docs/wiki/frontend/modules/chat.md), [social-service](docs/wiki/services/social-service.md)

- Never return a `Channel` entity to a client: it carries `masterSecret`. Project fields explicitly.
- A slug is not an authorization - `getWorkspaceBySlug` gates on membership.
- `/c/<groupId>` and `/chat/<groupId>` are NOT routes; a conversation opens by publishing to `notifNav`.
- A deep-linked selection must outlive the route remount, and is held until DISPLAYED, not selected.
- A channel target can only be opened on `/communities`; `openInvitedChannel` is the one entry point.
- Holding a landing means nothing without a rule for abandoning it.
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
- `waitForMessageQueueIdle` before a flush is correctness: skipping it sends at a stale epoch.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md)

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens.
- Detect one-way colour per CLASS LIST (`find-oneway-colors.mjs`), never per file.
- A `@theme` entry is what makes a token exist - an undefined token is silently inert.
- A native prompt is UI you only partly own: pass `title`/`subtitle`/`cancelTitle`, not just `reason`.
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

#### Release and CI -> [cicd](docs/wiki/cicd.md)

- A manual `workflow_dispatch` run of either release workflow is a pure compile check that ships
  nothing - and the ONLY way to compile Swift/ObjC/Kotlin from Windows. Run both before believing
  any native change.
- Two NAMED provisioning profiles, team `4CLNB8SR6L`, expire 2027-07-11.
- `bump-app-version.sh` must patch the NSE too, and `bump-version.yml` stages an EXPLICIT add list.
- Never add a `branches` filter to a `workflow_run` chained off a release-triggered workflow.

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
