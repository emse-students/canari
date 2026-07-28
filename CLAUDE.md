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

State lives HERE (canonical). Four repos, all `emse-students/*`, all on `main`:
Canari (this monorepo) | Sky (../Sky) | MiGallery (../MiGallery) | Portail-etu (../refonte-portail-etu).
Sky, MiGallery and Portail-etu are COMPLETE - nothing open on any of them.

Work is tracked as Work Packages ordered by severity: **P1** (security, or a user-facing path that
is broken), **P2** (correctness, nothing at risk), **P3** (hygiene). `[ ]` open, `[~]` in progress.
Delete a WP outright once it ships: the rule it taught goes to DURABLE RULES, the story to
`CHANGELOG.md`.

---

### CANARI - OPEN WORK PACKAGES

- \[ \] **WP-IOS-1 (P1) - The whole iOS background decrypt path is dead and has been since v0.11.0.**
  `canari_push.mm` and the NSE parse `json["pin"]` from `push_context.json`; the v0.11.0 rename made
  `store_push_context` write `deviceKeyB64` and nothing has written `pin` since. Both readers
  hard-reject on the empty field, so `CanariLoadPushContext` returns nil on EVERY call: every push
  serves the generic fallback, and quick reply, mark-read, welcome-request and the outbox drain all
  abort. Android is fine (`MlsContextLoader` reads the right key). Exact edits + the regression guard
  that was missing: `AGENTS.md` "Pending delegation brief", Part A. **Do this before WP-SEC-1**, which
  rewrites the same read path.

- \[ \] **WP-SEC-1 (P1) - Move the background-decrypt device key out of cleartext app data.**
  `push_context.json` stores `deviceKeyB64` in plain app storage because a background FCM/NSE
  handler decrypts with no user present and so cannot prompt for biometrics. The requirement is
  real; the plaintext file is not the way to meet it. Full implementation brief (files, line
  anchors, migration, gates, device checks, traps): `AGENTS.md` "Pending delegation brief", Part B.
  Two corrections to the original target, established while writing it: **Android must NOT use
  `setUnlockedDeviceRequired(true)`** - it makes the key unusable while the screen is locked, which
  is exactly when a push arrives - and Android needs no new key at all, only a Context-only reader,
  since the existing alias is already `setUserAuthenticationRequired(false)`. iOS does need a new
  keychain item (App Group access group + `AfterFirstUnlockThisDeviceOnly`, no access control).
  Enabling biometrics changes the unlock METHOD, never where this copy lives - do not conflate.

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

- \[ \] **WP-UI-1 (P3) - Sweep the REST of the UI for one-way colours.** The two reported
  components are done (community settings modal + both biometric sheets, tokens throughout).
  What remains is the audit: grep the frontend for `bg-white`, `bg-*-50`, `bg-*-100`,
  `text-*-800/900` and raw hex, convert to `app.css` tokens. Contract + token table:
  `docs/wiki/frontend/architecture.md` "Theming".
  Still unexplained: the enrolment sheet reported DARK under a LIGHT theme. The `dark:` variant is
  correct on web (verified by computed style in both themes), so the suspect is the native
  runtime - re-check on device during WP-VERIF-3.

- \[ \] **WP-UX-1 (P3) - Revoking a device asks nothing.** "Supprimer l'appareil" fires
  `purgeDeviceFootprint` (KeyPackages, prekeys, push tokens, queued messages, memberships, Redis)
  on a single click, while kicking a community member goes through `showConfirm`. Same confirm
  treatment is due here - the action is irreversible for the revoked device's pending traffic.

- \[ \] **WP-UX-2 (P3) - "Rester connecte" still describes the pre-v0.11.0 model.** Both the
  settings row and the PIN sheet say the PIN is what gets kept ("Conserve votre PIN", "Votre PIN
  sera conserve"). Since v0.11.0 it is the 32-byte device key that moves to `localStorage`; the PIN
  is never stored. Misleading on a security control - fix `fr.json`/`en.json`.

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
- **Escape hatch when a state still refuses to open:** the PIN modal's "forgot PIN" (`handlePinReset`) wipes server + local MLS state and restarts in first-setup mode, at the cost of local history.

#### MLS membership and routing

- **MLS membership and server routing are different memberships, and only one routes.** The MLS group says who can decrypt; `DeviceGroupMembership` (`status='active'`, mirrored in Redis `group:members:<groupId>`) says who chat-delivery actually sends to. Any new way of entering a group must promote that row - an **external commit is the one join path with no Welcome**, so nothing else creates it.
- **Redelivery asymmetry:** `activateDeviceMembership` replays the pending window for a Welcomed device, but an external-commit joiner lands at the CURRENT epoch and forward secrecy makes those frames unreadable - pass `redeliverMissed: false` and let the history bundle carry the past.
- **A community is soft-deleted, never dropped.** `DELETE workspaces/:id` needs MANAGE_WORKSPACE **only** (a kick or channel archive also accept MANAGE_CHANNEL - this one hits every member at once); it flips `channel_workspaces.archived` + its channels, and every read path filters it (listing, slug, invite preview, invite accept). Recovery = two UPDATEs.
- **`channel.moderate` = pin or delete SOMEONE ELSE's message, nothing more.** `memberCanModerateMessages` is the only check, shared by delete/pin/closePoll; the author is always allowed; editing is never moderation. `viewerCanModerate` on the workspace listing is a UI hint - the server re-checks.
- **Dead devices ARE reaped, after 90 days.** `detectStaleDevices` (hourly) keys liveness on `KeyPackage.createdAt`, refreshed by every WS reconnect; past `RETENTION_WINDOW_MS` it does `srem` on the Redis set and resets the row to `pending`, then `cleanupStaleDevices` purges the whole footprint. Until then a churned device id keeps receiving fan-out - that is the designed offline window, not a leak.

#### UI

- **A one-way colour is a dark-mode bug waiting to happen.** `bg-white`, `bg-red-50`, `text-amber-900`, raw hex: they do not flip, while `text-text-main` on top of them does - white on white. Use the `app.css` tokens (`bg-cn-surface`, `bg-cn-bg`, `text-red-err`, `text-green-ok`, `bg-cn-yellow` + `text-cn-ink`) and tint with an opacity modifier on the token. `text-cn-dark` FLIPS, `text-cn-ink` does not - ink is for text on the always-light yellow. Table: `docs/wiki/frontend/architecture.md`.

#### Contracts that the compiler does not check

- **Never redeclare an `init`/lifecycle override with fewer parameters.** TypeScript accepts it, so the dropped argument is invisible to `bun run check`. Prefer inheriting `BaseMlsService.init` over copying it.
- **A `postMessage` payload is typed by whoever writes the literal - i.e. by nobody.** All three MLS worker contracts live in `src/lib/mls-client/mlsWorkerProtocol.ts`, imported by both ends. Add new worker messages THERE, never as a local interface.
- **Tauri command names are unchecked strings on both sides.** An `invoke()` literal matching no `#[tauri::command]` compiles, lints and type-checks, then fails at runtime. Grep both sides on any rename.
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
