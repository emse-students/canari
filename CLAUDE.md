# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES**

- NO BLIND GREP: Never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: State assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
- STATE PRUNING: When updating the roadmap, DELETE detailed descriptions of completed tasks. Keep the file small.
- CLAUDE.md HYGIENE: Actively trim this file. DELETE shipped Work Packages (keep only forward-relevant gotchas), collapse redundant notes, drop stale entries.
- UPDATE STATE: Update SESSION STATE at the bottom of this file before finishing a Work Package.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> `git add . && git commit -m "[summary]"` -> Update SESSION STATE -> STOP, output "Task committed. Please run `/compact`."
- WIKI & CLEANLINESS: Documentation in `docs/wiki/` exclusively. Delete unused code immediately. English only, LLM-oriented.
- PROD ACCESS: `ssh canari` or `ssh mitv`.
- CLASSIFIER DOWN: End of session signal. Stop ASAP, prepare compaction + easy resume for next session.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (Front) | Rust WASM openmls | NestJS + Rust Axum (Back).
- Nginx: Single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: Always rebuild WASM (`mls-wasm/`) and protobufs (`npm run proto:gen`) after structural changes.
- Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via `canari_ws_token`.
- Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.
- Infra Truth: Keep `infrastructure/MIGRATION.md` synced with new secrets, services, or bootstrap steps.

## **CODING STANDARDS**

- Logs: Mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions, and error branches.
- Docs & Comments: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, do not restate types.
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
