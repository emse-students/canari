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
Legend: \[x\] done+pushed, \[ \] todo, \[~\] in progress.

---

### CANARI

#### DURABLE ARCHITECTURAL GOTCHAS

- **iOS push = all-FCM:** ONE transport (FCM) for both platforms; FCM relays iOS->APNs via the .p8 in Firebase console. Backend sends every PushToken via `getMessaging().send()` (data+android+apns); `ApnsService` deleted. Firebase App Delegate Proxy must stay enabled. Arch: `docs/wiki/services/chat-delivery.md`.
- **Firebase 12 data path:** FirebaseMessaging 12 REMOVED `messaging:didReceiveMessage:`. FCM data now arrives via `UIApplicationDelegate` swizzle (`CanariInstallRemoteNotificationHook`) + `UNUserNotificationCenter` callbacks, funnelling into `CanariHandleFcmData()`. Hook new iOS push work into `CanariHandleFcmData`/`CanariPushProcessRemoteNotificationUserInfo`.
- **Platform branches:** Use `isIosTauriRuntime()`/`isMobileTauriRuntime()` (`appVersion.ts`). Android-only behaviors (heartbeat, notif suppression, `reloadStateFromDisk`) must be broadened to all-mobile.
- **iOS pbxproj:** `canari.xcodeproj/project.pbxproj` is hand-maintained (NOT xcodegen). Targets/resources/variant groups added directly. Custom URL scheme, `NS*UsageDescription` keys, `FirebaseAppDelegateProxyEnabled`, localized `InfoPlist.strings` (fr/en `PBXVariantGroup`) are all hand-edited. NSE (`CanariNotifications` target) decrypts via Rust FFI with App Group `group.fr.emse.canari`.
- **iOS keychain:** namespace `fr.emse.canari`/`canari_biometric_user`; Android alias `unime_dev` deliberately UNTOUCHED (renaming orphans enrolled keys).
- **CI signing:** Two NAMED provisioning profiles matching `PROVISIONING_PROFILE_SPECIFIER` exactly (`Canari` app + `CanariNotifications` NSE), team "Les Rootz" `4CLNB8SR6L`, profiles expire 2027-07-11.
- **Version bump:** `scripts/bump-app-version.sh` must patch NSE's `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in pbxproj. `bump-version.yml` stages an EXPLICIT `git add` list - any new file the bump script patches must be added there.
- **Store publish:** iOS `altool` can exit 0 while output says `UPLOAD FAILED` - workflow greps transcript for failure markers. Android Play API rejects `changesNotSentForReview` post-launch (flag must stay absent). Post-release CD: `workflow_run` `branches` filter silently drops release-triggered workflows - never add a branches filter to a workflow_run chained off a release-triggered workflow.
- **PIN persistence:** `pinVault.ts` picks storage via `vaultStore()` keyed on `canari_pin_persist` flag (default `sessionStorage`, opt-in `localStorage`); `setPinPersistence` wipes BOTH stores before re-saving.
- **Stale-PIN recovery regex:** recovery-detection regexes in `sessionAuth.ts`/`ChatBackgroundService.svelte` MUST match actual thrown text - a never-matching regex ships unnoticed.

#### CROSS-PLATFORM ENHANCEMENTS

**WP-XP METHOD (reuse for every WP-XP):**

1. Read native stack first (Android `CanariFirebaseMessagingService.kt` + iOS `canari_push.mm`/NSE + Rust FFI twins `mobile/*_ffi.rs`), design ONCE, port to both OSes.
2. Implement Android + iOS + backend together; shared logic in Rust FFI, routed through EXISTING outbox/push paths. Update `docs/wiki/services/chat-delivery.md` + Paraglide FR/EN.
3. Local gates until ZERO warnings: bun run check/lint/format, cargo check (src-tauri + mls-wasm), backend oxlint, AND `:app:compileUniversalReleaseKotlin` (release build is the ONLY real Kotlin compile; nested types go on OUTER class body, never companion).
4. Commit signed (heredoc), isolate unrelated dirty files, `rm -rf apps/*/dist`, pull --rebase --autostash, push.
5. Cut release (`gh release create vX.Y.Z --target $(git rev-parse HEAD)`), follow ios/android/appimage/cd runs until ALL green. Source fix -> `gh run rerun`; workflow-YAML fix -> NEW release.
6. Update SESSION STATE (prune shipped detail!) + memory; flag [device] checks.

Shipped:
- \[x\] WP-XP-1 Notification quick actions
- \[x\] WP-XP-2 App-icon unread badge
- \[x\] WP-XP-3 Rich media notifications (v0.10.1)
- \[x\] WP-XP-4 Boot/relaunch re-registration
- \[x\] WP-XP-5 Priority notifications (calls & @mentions) - v0.10.4
- \[x\] WP-XP-6 Keyboard GIF/sticker parity
- \[x\] WP-XP-7 Unified rich notif grouping
- \[x\] WP-XP-8 Shared deferred-retry engine: Android `OutboxRetryWorker` (WorkManager, exp backoff 30s+, 3 failures -> persistent flag + nudge) + iOS `BGTaskScheduler` `fr.emse.canari.outboxRetry` (`BGProcessingTaskRequest`, `requiresNetworkConnectivity=YES`). Both triggered from `maybeNotifyPendingSync`/`CanariMaybeNotifyPendingSync` when opportunistic drain leaves remaining>0. [device] verify Android WorkManager retry + iOS BGTask wake-up.

Todo:
- \[x\] **WP-Calls-UX call UI overhaul** (P1-P9 implemented; svelte-check 0/0, oxlint 0/0, tests 8/8).

#### POST-v0.11.0 REMEDIATION (audit v0.10.4 -> v0.11.0)

Audit found 15 gaps (T1-T15). Remediation lots, in order:

- \[x\] **Lot 1 - mobile background push (BLOCKER)** - commit `6e6a7e1e`
  - T1/T2/T10a done: the three broken paths now go through `MlsManager::load_with_key` via the new `load_manager_with_key_b64` / `load_manager_for_push` helpers in `mobile/background.rs`; scratch comments removed; `pin`->`device_key_b64` in `ios_ffi.rs` + both iOS C headers; French rustdoc/logs translated; `AddMembersBulkResult`/`AddMemberResult` made `pub`. clippy 0 warnings on src-tauri/mls-core/mls-wasm, svelte-check 0/0.
  - \[ \] [device] verify a decrypted notification on Android AND iOS - this is the whole point of the fix.
- \[x\] **Lot 2 - frontend key chain (BLOCKER, bigger than the audit said)** - commit `529c924d`
  - T4 root cause was worse than "derivation missing": EVERY consumer fell back to the raw PIN, which can never be 32 bytes of base64 -> the entire at-rest chain failed closed on web AND native. New `$lib/crypto/deviceKey.ts` (PBKDF2-SHA256 310k, salt `canari-device-key-v1|{serverSalt}|{userId}`) is now the SINGLE source of the key. WebCrypto only - browser/desktop/mobile derive identical keys, no WASM or FFI on the login path. Domain-separated from `computePinVerifier` (which is sent to the server), asserted by a test.
  - Three MORE shipped defects found and fixed here: (a) `store_push_context` declared `pin` while all 3 call sites passed `deviceKeyB64` -> invoke failed on a missing arg EVERY time, swallowed by `.catch(() => {})`; it also read `mls.bin[..16]` as an Argon2id salt that no longer exists and stored the resulting garbage key in the keystore. Lot 1 could not have worked without this. (b) the change-PIN flow never called `POST mls/security/pin-change` - endpoint existed with ZERO callers, so the account verifier was never rotated. (c) `disableBiometricImpl` invoked `actualiser_cle_keystore`, a command that no longer exists.
  - T3, T5, T10b, T12 done. T5: `recharger_mls_au_resume` was already correct and key-based in Rust - only the TS caller had been deleted.
  - Recovery detection no longer regexes error text: typed `LoginFailure` codes in `session/loginErrors.ts`. **Never reintroduce message-matching here** - localizing a string silently disabled the branch, which is exactly how this broke.
  - `pinVault.ts` -> `deviceKeyVault.ts`; `db/salt.ts`, `derive_and_store_device_key`, legacy `encrypt_mls_state_blob` deleted.
  - \[ \] [device] a PIN login now re-derives the key - verify login, PIN change, and biometric enable/disable on a real device.
- \[x\] **Lot 3 - prod & migrations**
  - T6 premise was WRONG: prod is NOT hand-applied. `cd.yml` "Run database migrations" has always collected `apps/*/src/migrations/*.sql`, sorted by path, and piped each into the postgres container with `ON_ERROR_STOP=1`. Verified against the live 2026-07-27 run: all 41 files applied green.
  - Prod schema verified clean: `channels."writePolicy"` present, `channel_permission_overrides` + `usePermissionOverrides` gone, 0 legacy permission keys left in `channel_roles`. A full entity-vs-prod diff (46 entities / 440 columns, script in scratchpad) found ZERO drift.
  - Real defect found instead: **no ledger meant every file replayed on every deploy**, so one-shot data backfills kept re-applying - 004 re-granted `MANAGE_STRIPE_CONNECT`, 016 re-enabled `cotisationEnabled`. Both are no-ops on today's data (verified, 0 rows), but any admin revoking either would have seen it silently restored at the next deploy. Fixed with a `schema_migrations` ledger (filename PK + sha256 + applied_at); the first deploy after this applies all 41 once more (idempotent) and records them.
  - Editing an applied migration now only WARNS (checksum mismatch) - prod keeps the version it ran. Write a new file instead.
  - `007_mls_commit_log.sql` -> `012_` (duplicate number with `007_drop_orphan_columns.sql`); French headers in it and in `030` translated. Numbering gaps (023, 026-029) left alone: harmless, documented.
  - Migration contract documented in `docs/wiki/infrastructure/databases.md` (+ real prod table names, the old list was wrong) and `infrastructure/MIGRATION.md`.
  - Files are a PATCH SET, not a schema: migration 001 opens with `ALTER TABLE users`. A fresh prod DB comes from a backup restore, never from replaying migrations.
- \[~\] **Lot 4 - hygiene** (T10b/T12 already closed by Lot 2) - IN PROGRESS, resume here
  - **The audit undercounted T11 by an order of magnitude**: not ~10 lines but **426 matches across 74 files** (369 frontend / 57 apps). Do NOT trust the old per-line list.
  - Detection recipe (ripgrep, `-i` flag, NEVER inline `(?i)` - it fails to parse): `//.*\b(le|la|les|une|des|dans|pour|avec|sur|est|sont|pas|que|qui|cette|cle|clé|chiffr|dechiffr|déchiffr|utilise|permet|renvoie|retourne|evite|évite|verifie|vérifie|charge|stocke|recupere|récupère|supprime|ajoute|lors|ainsi|afin|depuis|aucun|chaque|meme|même)\b` - expect false positives ("Carte de la Vie Asso", "charge-saved-method").
  - T11 DONE (commit `a5968634`, all Rust): `commands/push.rs`, `concurrency.rs`, `state.rs`, `commands/{storage,bootstrap,mls}.rs`, `mobile/{mod,proto_fields}.rs`, `mls-wasm/src/lib.rs`, `mls-core/src/{lib,state,members}.rs`, and ALL SIX `mls-core/tests/*.rs` (`epoch_race.rs` was French end to end, rewritten whole). Migrations `012` + `030` done in Lot 3.
  - T11 DONE (uncommitted, TS/Svelte): `biometric.ts`, `encryption.ts`, `db/{sqlite,indexeddb}.ts`, `mlsDeliveryApi.ts`, `setupMessageHandler.ts`, `ChatBackgroundService.svelte`, `{Tauri,Web}MlsService.ts`, `hooks.client.ts`, `useConversations`/`useChannelWorkspaces`/`useChatSession.svelte.ts`, `sessionTypes.ts`, `sessionWatchdogs.ts`, `locks.controller.ts`.
  - T11 REMAINING (~40 sites): frontend test files (`actions.discovery.test.ts` 11, `androidFcmManifest.test.ts` 6, `initializeConnection*.test.ts` 6, `PushNotificationService.test.ts` 4, `conversations.dedup.test.ts` 3, misc 1-2 each), `groupLifecycle.ts` 6, `groupMutationQueue.ts` 3, `BaseMlsService.ts`, `initializeConnection.ts`, `keyPackages.ts` header, `places.ts`, `PushNotificationService.ts`, `systemMessageHandler*.ts`, `calendar/+page.svelte`, `ChannelSettingsModal.svelte`, `SidebarNewChatModal.svelte`; then **all of `apps/`** (57: `messaging.service.ts` 21, `handlers.rs` 11, `push.controller.ts` 5, `channel.service.ts` 3, rest 1-2).
  - T13 DONE: `encryption.ts:7-8` really was still on "Argon2id" (Lot 2 made it PBKDF2-SHA256) - fixed; `biometric.ts` x3 `derive_and_store_device_key` -> `store_push_context` (the command that actually stores the key today); `mls.rs` Argon2id rustdoc; `same_epoch_ratchet.rs` "Argon2 a repetition"; `mlsDeliveryApi.ts` + `locks.controller.ts` "persist Argon2 (~5-8 s)".
  - i18n gap found while translating: `biometric.ts` passed **hardcoded French** to `authenticate()` (the OS biometric prompt, user-visible) - now `m.auth_biometric_prompt_enable()` / `m.auth_biometric_prompt_disable()`, keys added to BOTH `fr.json` and `en.json`.
  - T14: DONE - legacy `encrypt_with_pin`/`decrypt_with_pin` confirmed reachable only from `backup.ts:174` (v1 branch); header comment now says so.
  - `messages/fr.json` vs `en.json`: was 2157 vs 2147; +2 each here. Still ~10 FR-only keys, pre-existing, unreconciled.
- \[ \] **T16 (NEW, found in Lot 4) - `pin` is a lying parameter name across the MLS client**
  - Every call site passes `ctx.getDeviceKey()` into a field/param named `pin` (`sessionAuth.ts` x10, `MessageHandlerDeps.pin`, `ConnectionDeps.pin`, `MlsStatePersisterConfig.pin`, `encryptMlsStateOffThread(plain, pin)`, `replenishKeyPackages(svc, pin)`, `storage.saveMessages(msgs, pin)`, ...). The VALUE is correct - this is not a live bug - but it is exactly the naming lie that produced the Lot 2 `store_push_context` defect.
  - NOT a blind rename: 318 occurrences / 68 files, and many are legitimately the PIN (`PinModal`, `computePinVerifier`, `pinChange.ts`, `canari_pin_persist`). Needs per-site judgment. Deliberately left out of Lot 4 as scope-widening; raise with the user before doing it.
- \[ \] **Lot 5 - docs & state**
  - T7: CHANGELOG `[Unreleased]` still holds all v0.11.0 content; no v0.10.10-v0.10.15 sections; the PIN->deviceKey block is in French.
  - T9: `plans/` and `docs/strategy/` are TEMPORARY working trees (user-confirmed) - DELETE once T1-T15 are closed. `docs/TESTS-DEVICE-PENDING.md` was deleted with open items in it.
  - T15: ~12 non-descriptive commits (`fix`, `cd`, `doc`, `communautes`).

#### MULTI-TIER COTISATIONS (Cercle) - COMPLETE

Durable gotchas:
- `association_products` has `variantKey`/`variantLevel` (NULL = single-tier); `deriveCotisationTag(slug, mode, now?, variant?)` appends `-${variant}` before academic-year suffix.
- `memberPriceTag` - `amountCentsMember` applies iff buyer holds THAT specific tag. Fulfillment transaction-wraps grant + `revokeSiblingTierTags` (XOR switch).
- Inbound `GET /api/public/cotisant-status` gated on `X-Api-Key` vs `CERCLE_API_KEY`, throttled 20 req/min. Outbound `dispatchCercleWebhook` (HMAC-SHA256, 3 retries).
- Remaining manual step: set real `webhookUrl`/`webhookSecret` on prod `balance_topup` product once Cercle provides them.

---

### SKY (../Sky) - COMPLETE, nothing open.
### MIGALLERY (../MiGallery) - COMPLETE, nothing open.
### PORTAIL-ETU (../refonte-portail-etu) - COMPLETE, nothing open.

---

### SHARED GOTCHAS (do not repeat)

- Bash-tool commit messages: use heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash prefixes subject with `@`).
- Backend lint: apps call bare `oxlint`/`oxfmt` from local `node_modules/.bin`. If hook fails with `'oxlint' n'est pas reconnu`, run `npm install` in that app dir.
- Canari pre-commit hook sweeps WHOLE frontend and re-stages; isolate unrelated dirty files before committing.
- Before push: `rm -rf apps/*/dist` then `git pull --rebase --autostash origin main`.
- Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant`/`viewerActiveTier` (no client-side tag derivation).
- Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin; `data-export/` holds PII, never commit.
- Sky UI French must keep accents + straight apostrophes.
- Commit signing ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`. Pubkey registered as GitHub signing key on DeMASKe. All commits Verified - do NOT disable.
