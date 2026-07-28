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
- **Device key persistence:** `deviceKeyVault.ts` picks storage via `vaultStore()` keyed on `canari_device_key_persist` (default `sessionStorage`, opt-in `localStorage`); `setDeviceKeyPersistence` wipes BOTH stores before re-saving.
- **NEVER branch on a login error message.** `onLoginFailed(msg, code)` carries a typed `LoginErrorCode` (`loginErrors.ts`) precisely because the message is localized: a regex over it ships dead in French. Same rule for any future UI branch on an error.
- **Who owns the keystore key:** `store_push_context` (login) and `IMlsService.changeDeviceKey` (PIN change/recovery) write alias `mls_device_key_{userId}_{deviceId}`. `applyNewDeviceKeyLocally` must NEVER call `BiometricService.disable` - that deletes the entry just written and silently turns biometrics off.
- **Never redeclare an `init`/lifecycle override with fewer parameters.** TypeScript accepts it, so the dropped argument is invisible to `bun run check`. `WebMlsService.init`/`TauriMlsService.init` each dropped `opts`, killing `noFreshStart`: an undecryptable `mls.bin` fell into the destructive fresh-start (new device id + old device deleted server-side) instead of the recoverable `MLS_LOCAL_STATE_UNDECRYPTABLE` path. Prefer inheriting `BaseMlsService.init` over copying it - the copy had already lost the clear-`initPromise`-on-failure cleanup.
- **Tauri command names are unchecked strings on both sides.** A literal passed to `invoke()` that matches no `#[tauri::command]` in `generate_handler!` compiles, lints and type-checks, then fails at runtime with "command not found". v0.11.0 renamed three TS call sites to `*_avec_clef` without touching Rust: native MLS init, save AND KeyPackage publication were dead on every mobile/desktop build until 2026-07-28. Grep both sides on any rename.
- **Two ways a saved MLS state can fail to load, and they need different answers.** `BaseMlsService.classifyStateLoadFailure` is the only place that decides: `sealed` (AEAD failure, key rotated elsewhere) honours `noFreshStart` so the old PIN can recover the history; `mismatch` (blob decrypted, credential names another device) must NOT - no PIN repairs an identity, so pausing strands the user. After any fresh start, persist the new state BEFORE anything else can fail, or the new device id in localStorage and the old blob in storage will mismatch again next launch (the churn loop).
- **"Logged in" means two different things.** `globalSession.isLoggedIn` = MLS is ready; the login page checks the OIDC/refresh session. A route guard that redirects to `/login` on the former while the latter is valid ping-pongs forever. Page guards test `currentUserId()`; MLS-dependent sections handle MLS absence themselves.
- **Changing an at-rest envelope needs a migration, not a comment.** v0.11.0 moved `mls.bin` from
  `[salt 16 || nonce 12 || ct]` sealed with Argon2id(PIN, salt) to `[nonce 12 || ct]` sealed with
  the PBKDF2 device key, and shipped no reader for the old envelope. `CanariDBMls_<userId>` is
  pinned at schema version 1 and native `mls.bin` is never versioned either, so nothing rewrote or
  dropped those blobs: every pre-v0.11.0 install failed to decrypt its own state and was told "your
  PIN was changed on another device", offering a recovery no PIN could satisfy. Both platforms now
  try the legacy envelope once (`migrateLegacyMlsStateBlob` on web, `migrate_legacy_state_blob` in
  `commands/mls.rs`) and re-seal + persist. Format locked by `mls-core/tests/legacy_state_envelope.rs`
  - if you ever change the envelope again, add the reader for the previous one in the SAME commit.
- **`push_context.json` holds `deviceKeyB64` in cleartext app data, and the file is the problem -
  not the copy.** A background FCM/NSE handler decrypts without any user present, so it cannot
  prompt for biometrics: the key must be readable while the device is locked. That is a real
  constraint, and every messenger that decrypts notifications in the background satisfies it the
  same way - not with a plaintext file, but with an OS-guarded store that unlocks after first
  unlock. Solution to implement: iOS keychain item in App Group `group.fr.emse.canari` with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; Android `AndroidKeyStore` key with
  `setUserAuthenticationRequired(false)` + `setUnlockedDeviceRequired(true)`. `push_context.json`
  then keeps only the non-secret fields (device id, user id, push secret handle). Enabling
  biometrics changes the unlock method, never where this copy lives - do not conflate the two.
- **PIN policy is one rule, everywhere:** `isValidPin` (>= 4 characters, no max, no charset limit) guards setup, change, recovery AND unlock. Never add a stricter creation-only rule: the device key derives from the exact string typed, so a PIN accepted at creation but refused at unlock locks its owner out of their own messages.

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

#### POST-v0.11.0 REMEDIATION - COMPLETE

All 15 audit gaps (T1-T15) + T16 + i18n parity closed and gate-verified across 5 lots (mobile
background push, frontend key chain, prod migration ledger, hygiene, docs). Delegation log and
verification verdicts: `AGENTS.md`. Durable lessons folded into the gotchas above.

- \[ \] [device] decrypted push notification on Android AND iOS.
- \[ \] [device] login, PIN change, biometric enable/disable on real hardware.

#### MLS WORKFLOW AUDIT (2026-07-28)

Triggered by "0 appareil(s) connecte(s)" + a login stuck on "PIN changed on another device".
Evidence came from prod (`ssh canari`, chat-delivery + gateway + nginx logs), not from reading.
Six defects found and fixed, all introduced by the v0.11.0 PIN -> deviceKey refactor:

- Three `invoke('*_avec_clef')` targets that exist in NO Rust command -> native MLS init, save and
  KeyPackage publication dead on every Tauri build since v0.11.0.
- Biometric sessions pass `deviceKeyB64 = ''` to every save -> now resolved once at init and
  cached in `AppState.device_key`.
- Credential mismatch reported as "PIN changed elsewhere"; fresh start never persisted -> churn.
- `/settings` <-> `/login` redirect ping-pong (MLS-readiness vs OIDC-session predicates).
- **The at-rest envelope changed with no reader for the old one** (`399b07aa`): every pre-v0.11.0
  install was told its PIN had been changed elsewhere. This was the actual lockout the user hit
  twice; the four above only shaped how it was reported. See the durable gotcha on envelopes.

Follow-up `26fa3c87`: the reporter's snapshot DID open, and named `...-mqprwzk1-lvzt` while
localStorage held the churn-minted `...-ms3ny2qj-gl0p`. Opening the envelope says nothing about
whose state it is - the migration's own failure is now re-classified so a mismatch fresh-starts
instead of escaping `init` as a raw crypto error. Reporter has also deleted all MLS groups
server-side, so a fresh start is the intended outcome for them.

Deployed on web (chunk `FPv2_J8W.js`, CD green 2026-07-28). Escape hatch if a state
still refuses to open: the PIN modal's "forgot PIN" (`handlePinReset`) already wipes server + local
MLS state and restarts in first-setup mode - at the cost of local history. No new UI needed.

Open, NOT yet explained: on web, `generateKeyPackage` reached `prekeys/count` but never issued
`POST /api/mls/register-device` (20:39:29 prod). Needs the client line `[KP] Publication failed
(...)` from a session where MLS init succeeds - only reachable now that login completes.

- \[ \] [device] Tauri login end-to-end (init + save + KeyPackage) - all three were broken.
- \[ \] [browser] confirm the legacy snapshot migrates on the reporter's own profile (only place
  a pre-v0.11.0 blob exists; a fresh Chrome profile cannot reproduce it).

#### MOBILE AUTH CHAIN AUDIT (2026-07-27) - COMPLETE

Audited the mobile login/PIN/biometric chain against the intended spec after the deviceKey
migrations. **The crypto chain survived intact** - PBKDF2 derivation, ChaCha20-Poly1305 `mls.bin`,
AES-GCM messages, keystore alias convention and `pin-change` wiring all self-consistent. The
breakage was in orchestration. All fixed:

- Recovery link was dead in French (regex over a localized message) -> typed `LoginErrorCode`.
- PIN change deleted the keystore key `changeDeviceKey` had just written, silently disabling
  biometrics and raising a "disable biometric unlock" prompt mid-change. Same path in recovery.
- PIN sheet hid the fingerprint button after a failed biometric login; `biometricLoginImpl` never
  cleared the session device key, so a retry could reuse a failed key instead of the keystore.
- PIN policy is a single minimum of 4 characters (`isValidPin`) on every path.
- Enrolment offer is now a bottom sheet (`BiometricEnrollSheet`); the in-app biometric sheet is
  raised from `enrollBiometricImpl` via the `biometricPrompt` store, so the post-login offer and
  the Settings toggle behave identically.
- Dead code removed (`showBiometricEnrollPrompt`, `applyNewPinLocally`); remaining French comments
  swept; `docs/wiki/frontend/modules/auth.md` rewritten with the full chain.

Known and deliberate: `push_context.json` keeps `deviceKeyB64` in cleartext app data after
enrolment - background FCM decryption needs it. Enabling biometrics changes the unlock method,
not where that copy lives.

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
