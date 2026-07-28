# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES**

- NO BLIND GREP: Never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: State assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
- STATE PRUNING: When updating the roadmap, DELETE detailed descriptions of completed tasks. Keep the file small.
- CLAUDE.md HYGIENE: Actively trim this file. DELETE shipped Work Packages (keep only forward-relevant gotchas), collapse redundant notes, drop stale entries.
- UPDATE STATE: Update SESSION STATE at the bottom of this file before finishing a Work Package.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> `git add . && git commit -m "[summary]"` -> Update SESSION STATE -> STOP, output "Task committed. Please run `/compact`."
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

- \[~\] **WP-CERCLE-1 (P1) - Audit + security fixes + Canari double link.** CODE COMPLETE, commit
  `de92e18`. `bun run check` 0 errors, eslint clean, every page renders, 26/26 end-to-end checks
  pass on a freshly seeded DB (script was scratchpad-only, not committed). **Not pushed, no PR
  open yet** - that is all that remains.
  Verified by those checks: forged/tampered session refused; non-cotisant -> `/unauthorized`;
  `/api/*` 401 anon and 403 for a non-cercleux; GET on `/events/open` no longer opens a perm;
  unsigned and mis-signed webhooks 401 while a signed one credits exactly once on replay; the
  charge uses the server price (form said 1, charge was 40) and a sans-alcool tier is refused
  alcohol; `/gestion` actions 403 for a cotisant; cash top-up traced to its cercleux; zero
  ledger drift throughout.
  Still owed before merge: run it against a REAL Canari (`CANARI_INTEGRATION_ENABLED=true` has
  never been exercised - the 24 h grace window and the TTL refresh are untested against a live
  `cotisant-status`), and a real OIDC login round trip (the checks mint their own cookies).
  **WP-COT-11 must land first or the alcohol gate is wrong for real alcohol cotisants.**

- \[ \] **WP-CERCLE-2 (P3) - No way to correct a mis-keyed consumption.** The ledger is
  append-only and the user declined an `adjustment` kind, so a drink charged twice or to the wrong
  account cannot be undone. Revisit once the bar has used it for a term.

- \[ \] **WP-CERCLE-3 (P3) - Dev secrets are in the working `.env`.** `SESSION_SECRET` and
  `CANARI_WEBHOOK_SECRET` there are throwaway placeholders. Generate real ones for prod
  (`openssl rand -base64 48`); rotating `SESSION_SECRET` is also the only way to revoke every
  session at once.

---

### CANARI - OPEN WORK PACKAGES

- \[ \] **WP-COT-9 (P1) - Cross-tenant tag revocation (IDOR).** `revokeTag`
  (`associations.controller.ts:851`) takes `:tagId` and ignores `:id`, and
  `UserTagService.revoke` deletes by primary key with no ownership check - so MANAGE_MEMBERS on
  ANY association revokes a tag issued by ANY other. Scope the delete to `issuingAssocId`.

- \[ \] **WP-COT-10 (P2) - Manual cotisant add cannot assign a tier.** `grantCotisant`
  (`user-tag.service.ts:147`) calls `deriveCotisationTag(slug, mode)` with no variant, so a manual
  add always grants the base tag - never `avec-alcool`/`sans-alcool` - and it skips
  `revokeSiblingTierTags`, so a manual grant can leave a user holding two tiers at once. This is
  the bug reported from the UI ("on ne peut pas leur assigner un palier"). Needs an optional
  `variantKey` on `GrantCotisantDto` + the XOR revoke, and the roster's "Forfait" column then
  stops being blank for manually-added cotisants.

- \[ \] **WP-COT-11 (P2) - Le Cercle's base tier has no `variantKey`, so `tier` comes back null.**
  The auto-provisioned base membership product is `variantKey: null` and cannot be deleted from
  the Cotisations tab, so `/api/public/cotisant-status` answers `tier: null` for anyone holding
  it - and Le Cercle cannot tell an alcohol cotisant from a non-alcohol one. The Cercle side
  currently fails closed (null -> `sans-alcool`, `resolveTier` in `src/lib/server/canari/`), which
  is safe but wrong for a real alcohol cotisant. Fix: let Le Cercle's base product carry an
  explicit `variantKey`, or stop auto-provisioning a base tier for a multi-tier association.
  **Blocks the alcohol gate being correct end to end.**

- \[ \] **WP-VERIF-0 (P1) - [device] WP-IOS-1 + WP-SEC-1 shipped unverified.** Code landed
  2026-07-28 (delegated, verified with corrections - see `AGENTS.md`). Swift/ObjC do not compile
  off macOS, so the entire iOS half is unproven, and the Android keystore read has never run on
  hardware. The 5 device checks that gate the verdict, including the upgrade path that is the only
  test of the one-shot migration: `AGENTS.md` "what is still owed". Check 2 doubles as the first
  ever proof that iOS background decrypt works at all. **Blocks WP-VERIF-2.**
  Both release workflows have since been dispatched as compile checks. Android green; the iOS run
  found two more defects (a Swift `guard` that fell through, and raw key bytes read back as UTF-8)
  and is re-running on this commit. Compiling is not running - the checks below are still owed.

- \[ \] **WP-VERIF-1 (P1) - [device] Tauri login end to end (init + save + KeyPackage).** All three
  were dead from v0.11.0 to v0.11.2 (`invoke` names matching no Rust command). Native has NOT run
  since. TestFlight/Play is the first real test; nothing here is proven until it does.

- \[ \] **WP-VERIF-2 (P2) - [device] Decrypted push notification on Android AND iOS.**

- \[ \] **WP-VERIF-3 (P2) - [device] Login, PIN change, biometric enable/disable on real hardware.**

- \[ \] **WP-VERIF-4 (P3) - [device] WP-XP-8 retry engine.** Android `OutboxRetryWorker`
  (WorkManager, exp backoff 30s+, 3 failures -> persistent flag + nudge) and iOS `BGTaskScheduler`
  `fr.emse.canari.outboxRetry`. Both fire from `maybeNotifyPendingSync` when an opportunistic drain
  leaves `remaining > 0`. Never observed waking up on hardware.

- \[ \] **WP-COM-3 (P3) - Channels still have no reactions and no forward.** `MainChatPage` passes
  `onReact`/`onForward` as `undefined` when `isSelectedChannel`, because no backend endpoint
  exists for either (the `channel_messages.reactions` column is unused). Separate from the
  moderation permission, which now works - this is a plain missing feature.

- \[ \] **WP-UI-1 residual (P3) - one open question, no code left.** The sweep is done (390 -> 31,
  and the 31 are deliberate: switch thumbs, colour-picker handles, always-dark call/lightbox
  chrome, the white plate behind a QR). Detector: `frontend/scripts/find-oneway-colors.mjs`.
  Still unexplained: the enrolment sheet reported DARK under a LIGHT theme. The `dark:` variant is
  correct on web (verified by computed style in both themes), so the suspect is the native
  runtime - re-check on device during WP-VERIF-3.

- \[ \] **WP-INT-1 (P3) - Cercle webhook credentials.** Set the real `webhookUrl`/`webhookSecret`
  on the prod `balance_topup` product. Blocked on Cercle providing them.

---

### CANARI - DURABLE RULES

One line per rule. If it needs a paragraph, the paragraph belongs in `docs/wiki/`.

#### MLS state and keys

- **An at-rest envelope change needs a reader for the previous format in the SAME commit.** Neither `CanariDBMls_<userId>` (schema v1) nor native `mls.bin` is versioned, so nothing rewrites old blobs; v0.11.0 changed the envelope with no reader and locked every existing install out. Format locked by `mls-core/tests/legacy_state_envelope.rs`.
- **Two ways a saved state fails to load, two answers.** `BaseMlsService.classifyStateLoadFailure` is the only place that decides: `sealed` (AEAD failure) honours `noFreshStart` so the old PIN can recover; `mismatch` (decrypted, but names another device) must not - no PIN repairs an identity.
- **After any fresh start, persist the new state BEFORE anything else can fail**, or the new device id and the old blob mismatch again next launch (the churn loop).
- **PIN policy is one rule everywhere:** `isValidPin` (>= 4 chars, no max, no charset limit) guards setup, change, recovery AND unlock. A PIN accepted at creation but refused at unlock locks its owner out of their own messages.
- **Who owns the keystore key:** `store_push_context` (login) and `IMlsService.changeDeviceKey` (PIN change/recovery) write alias `mls_device_key_{userId}_{deviceId}`. `applyNewDeviceKeyLocally` must NEVER call `BiometricService.disable` - that deletes the entry just written.
- **Device key persistence:** `deviceKeyVault.ts` picks storage via `vaultStore()` keyed on `canari_device_key_persist` (default `sessionStorage`, opt-in `localStorage`); `setDeviceKeyPersistence` wipes BOTH stores before re-saving. "Stay signed in" starts UNCHECKED by design - it reflects the stored choice.
- **The background copy of the device key is a keystore entry, never a file.** `push_context.json` carries `userId`/`deviceId`/`baseUrl`/`pushToken` and no key material. A push handler has no user, so the entry must be hardware-backed yet unattended-readable: Android reuses the alias (`setUserAuthenticationRequired(false)`, read Context-only via `MlsDeviceKeyStore` - **never** `setUnlockedDeviceRequired(true)`, that dies exactly when a push arrives); iOS uses a SECOND item `mls_bg_key_<alias>`, `AfterFirstUnlockThisDeviceOnly`, no `kSecAttrAccessControl`, access group `group.fr.emse.canari`. Table: `docs/wiki/frontend/modules/auth.md`.
- **Android `Base64.DEFAULT` appends a newline and the Rust `decode_base64_to_32_bytes` does not trim.** Encode anything crossing into the FFI with `NO_WRAP`; `DEFAULT` is only correct for KeystorePlugin's own at-rest IV/CT.
- **The device key is RAW 32 bytes at rest in the keystore, base64 on the FFI wire.** Writers (`storeKeyBytes`, `MlsDeviceKeyStore.store`, both one-shot migrations) decode before storing; readers (`getKeyBytes`, `CanariRetrieveDeviceKey`, `NotificationService.retrieveDeviceKey`, `MlsDeviceKeyStore.retrieve`) encode after loading. UTF-8 anywhere in that chain silently yields no key. Guarded by `pushContextFields.test.ts`.
- **Escape hatch when a state still refuses to open:** the PIN modal's "forgot PIN" (`handlePinReset`) wipes server + local MLS state and restarts in first-setup mode, at the cost of local history.

#### MLS membership and routing

- **MLS membership and server routing are different memberships, and only one routes.** The MLS group says who can decrypt; `DeviceGroupMembership` (`status='active'`, mirrored in Redis `group:members:<groupId>`) says who chat-delivery actually sends to. Any new way of entering a group must promote that row - an **external commit is the one join path with no Welcome**, so nothing else creates it.
- **Redelivery asymmetry:** `activateDeviceMembership` replays the pending window for a Welcomed device, but an external-commit joiner lands at the CURRENT epoch and forward secrecy makes those frames unreadable - pass `redeliverMissed: false` and let the history bundle carry the past.
- **A community is soft-deleted, never dropped.** `DELETE workspaces/:id` needs MANAGE_WORKSPACE **only** (a kick or channel archive also accept MANAGE_CHANNEL - this one hits every member at once); it flips `channel_workspaces.archived` + its channels, and every read path filters it (listing, slug, invite preview, invite accept). Recovery = two UPDATEs.
- **`channel.moderate` = pin or delete SOMEONE ELSE's message, nothing more.** `memberCanModerateMessages` is the only check, shared by delete/pin/closePoll; the author is always allowed; editing is never moderation. `viewerCanModerate` on the workspace listing is a UI hint - the server re-checks.
- **Dead devices ARE reaped, after 90 days.** `detectStaleDevices` (hourly) keys liveness on `KeyPackage.createdAt`, refreshed by every WS reconnect; past `RETENTION_WINDOW_MS` it does `srem` on the Redis set and resets the row to `pending`, then `cleanupStaleDevices` purges the whole footprint. Until then a churned device id keeps receiving fan-out - that is the designed offline window, not a leak.

#### UI

- **A one-way colour is a dark-mode bug waiting to happen.** `bg-white`, `bg-red-50`, `text-amber-900`, `text-red-600`, raw hex: they do not flip, while `text-text-main` on top of them does - white on white. Use the `app.css` tokens (`bg-cn-surface`, `bg-cn-bg`, the `red-err`/`green-ok`/`amber-warn` status triad, `bg-cn-yellow` + `text-cn-ink`) and tint with an opacity modifier on the token. `text-cn-dark` FLIPS, `text-cn-ink`/`cn-scrim`/`cn-tooltip` do not - those three are for surfaces that must stay put in both themes. Table: `docs/wiki/frontend/architecture.md`.
- **Detect one-way colour per CLASS LIST, never per file:** `bg-white dark:bg-slate-900` is fine, and a plain grep over-reports 4x. `frontend/scripts/find-oneway-colors.mjs` does it right; it must NOT tokenize on `:` or it strips the very `dark:` prefixes it looks for. Black scrims and white at <=20% opacity are the glass idiom, not bugs.
- **A `@theme` entry is what makes a token exist.** `bg-cn-surface-alt` was used in six components with no `--color-cn-surface-alt` behind it, so Tailwind generated nothing and the class was silently inert. Grep `app.css` before inventing a token name.
- **`bun run build` leaves Paraglide output that makes the locale-asserting tests resolve to English** (4 failures in `callSystemMessages.test.ts` / `pinChange.test.ts`). Re-run `bun run paraglide:compile` before `bun run test` after any build.

#### Contracts that the compiler does not check

- **Never redeclare an `init`/lifecycle override with fewer parameters.** TypeScript accepts it, so the dropped argument is invisible to `bun run check`. Prefer inheriting `BaseMlsService.init` over copying it.
- **A `postMessage` payload is typed by whoever writes the literal - i.e. by nobody.** All three MLS worker contracts live in `src/lib/mls-client/mlsWorkerProtocol.ts`, imported by both ends. Add new worker messages THERE, never as a local interface.
- **Tauri command names are unchecked strings on both sides.** An `invoke()` literal matching no `#[tauri::command]` compiles, lints and type-checks, then fails at runtime. Grep both sides on any rename.
- **`push_context.json` is a JSON contract across four languages** (Rust writer; ObjC, Swift, Kotlin readers) that no compiler checks - the v0.11.0 `pin` -> `deviceKeyB64` rename killed iOS background decrypt for three releases. `src/lib/mobile/pushContextFields.test.ts` is the only thing that catches drift; change the fields and change it too.
- **NEVER branch on an error message.** `onLoginFailed(msg, code)` carries a typed `LoginErrorCode` (`loginErrors.ts`) because the message is localized: a regex over it ships dead in French.
- **"Logged in" means two things.** `globalSession.isLoggedIn` = MLS ready; the login page checks the OIDC/refresh session. Page guards test `currentUserId()`; MLS-dependent sections handle MLS absence themselves.

#### Mobile and native

- **iOS push = all-FCM:** ONE transport for both platforms; FCM relays iOS->APNs via the .p8 in the Firebase console. Backend sends every PushToken via `getMessaging().send()`. Firebase App Delegate Proxy must stay enabled. Arch: `docs/wiki/services/chat-delivery.md`.
- **Firebase 12 data path:** `messaging:didReceiveMessage:` is GONE. FCM data arrives via the `UIApplicationDelegate` swizzle (`CanariInstallRemoteNotificationHook`) + `UNUserNotificationCenter` callbacks, funnelling into `CanariHandleFcmData()`. Hook new iOS push work there.
- **Platform branches:** use `isIosTauriRuntime()`/`isMobileTauriRuntime()` (`appVersion.ts`). Android-only behaviours (heartbeat, notif suppression, `reloadStateFromDisk`) must be broadened to all-mobile.
- **iOS pbxproj is hand-maintained** (NOT xcodegen): targets, resources, URL scheme, `NS*UsageDescription`, `FirebaseAppDelegateProxyEnabled`, localized `InfoPlist.strings` variant groups. NSE (`CanariNotifications`) decrypts via Rust FFI with App Group `group.fr.emse.canari`.
- **iOS keychain** namespace `fr.emse.canari`/`canari_biometric_user`; Android alias `unime_dev` deliberately UNTOUCHED (renaming orphans enrolled keys).
- **Kotlin nested types go on the OUTER class body, never a companion object**, and the release build (`:app:compileUniversalReleaseKotlin`) is the ONLY real Kotlin compile.

#### Release and CI

- **CI signing:** two NAMED provisioning profiles matching `PROVISIONING_PROFILE_SPECIFIER` exactly (`Canari` app + `CanariNotifications` NSE), team "Les Rootz" `4CLNB8SR6L`, expire 2027-07-11.
- **Version bump:** `scripts/bump-app-version.sh` must patch the NSE's `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`; `bump-version.yml` stages an EXPLICIT `git add` list - any new file the script patches must be added there.
- **`android-release.yml` and `ios-release.yml` both take `workflow_dispatch`, and every publish step is gated on `workflow_run`** - so a manual run is a pure compile check that ships nothing. It is the ONLY way to compile Swift/ObjC/Kotlin from Windows; run both before believing any native change.
- **Store publish:** iOS `altool` can exit 0 while printing `UPLOAD FAILED` (the workflow greps the transcript). Android Play API rejects `changesNotSentForReview` post-launch. Never add a `branches` filter to a `workflow_run` chained off a release-triggered workflow - it silently drops every run.

#### Cotisations (Cercle)

- `association_products` carries `variantKey`/`variantLevel` (NULL = single-tier); `deriveCotisationTag(slug, mode, now?, variant?)` appends `-${variant}` before the academic-year suffix.
- `memberPriceTag`: `amountCentsMember` applies iff the buyer holds THAT specific tag. Fulfillment transaction-wraps grant + `revokeSiblingTierTags` (XOR switch).
- Inbound `GET /api/public/cotisant-status` gated on `X-Api-Key` vs `CERCLE_API_KEY`, 20 req/min. Outbound `dispatchCercleWebhook` is HMAC-SHA256 with 3 retries.
- Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant`/`viewerActiveTier`. No client-side tag derivation.

---

### VERIFIED ON WEB (2026-07-28, v0.11.3)

Two real accounts driven in isolated browser contexts, zero console errors across every run.

- **Login / DM round trip**: PIN -> WS -> `generateKeyPackage` (50) -> `KeyPackage published.` on
  both; messages decrypted both ways; hard reload replays the same device id (no fresh start).
- **Device-reset recovery, DM**: wiped device -> PIN -> fresh device id ->
  `externalJoin succeeded (base epoch 2)` -> `[HISTORY_REQ] solicit attempt 0` ->
  `[HISTORY_BUNDLE] 34 messages received`, all 34 rendered, live traffic both ways, five seconds
  from PIN to full history. Works only because of the `[MEMBERSHIP_ACTIVE]` promotion in
  `validateCommit`.
- **PIN change**: verifier rotated server-side, MLS state + 37 local messages re-encrypted, same
  device id. Old PIN correctly refused on the next unlock, new PIN opens, full history intact,
  send/receive still working after the rotation.
- **Device revocation**: revoking from "Gestion des appareils" srems the Redis routing set
  immediately (a 2-person DM went from 7 entries to 2). The current device correctly has no
  delete button.
- **Device-reset recovery, community**: after wiping IndexedDB + localStorage, the community, its
  channel AND the channel's full message history all came back, then live channel traffic in both
  directions.
- **Community roles**: a member gets a read-only settings modal (no roles tab, no "Ajouter un
  canal", no invite/kick), an admin gets everything. `canManage` is the server-authoritative
  `viewerCanManage` (MANAGE_WORKSPACE), fail-closed. Community-level management is admin-only by
  design; the role matrix governs CHANNEL permissions - see WP-COM-2 for the one it does not.
  A role change is NOT pushed live: an open settings modal keeps the old role until reload.
- **Invitation**: the invitee does receive a visible message in the MLS DM - a `channel_invitation`
  card with a "Rejoindre la communaute" CTA - and a `memberAdded` system message is posted into the
  channel. The latter named the invitee "Utilisateur inconnu" until `ce16f804`.

---

### SHARED GOTCHAS (do not repeat)

- **Driving several logged-in sessions at once:** `new_page` with `isolatedContext: "<name>"` (chrome-devtools MCP) gives a fully separate cookie jar, IndexedDB and sessionStorage - i.e. a distinct device with its own MLS state and device id. Two contexts + two accounts is the only way to exercise Welcome/epoch/decrypt paths from the outside. `fill()` sets a value without firing the input events Svelte tracks; use `type_text` for composers and debounced search.
- **Never assert a wall clock in a test.** An unseeded generator with rejection sampling drew 31s against a 15s budget on a runner and took CD down. Seed the input; let the `it` timeout guard non-termination.
- Bash-tool commit messages: use heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash prefixes the subject with `@`).
- Backend lint: apps call bare `oxlint`/`oxfmt` from local `node_modules/.bin`, with repo-level configs (`-c ../../oxfmt.json`, `-c ../../.oxlintrc.nest.json`). If a hook fails with `'oxlint' n'est pas reconnu`, run `npm install` in that app dir.
- Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files before committing.
- Before push: `rm -rf apps/*/dist` then `git pull --rebase --autostash origin main`.
- Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin; `data-export/` holds PII, never commit.
- Sky UI French must keep accents + straight apostrophes.
- Commit signing ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`. All commits Verified - do NOT disable.
