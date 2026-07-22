# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES (OPUS AUTONOMOUS MODE)**

- NO BLIND GREP: Never run generic grep or find across the project. Check the SESSION STATE below first, or ask the user for exact paths.
  ASK EARLY: State assumptions explicitly. If uncertain about architecture, multiple interpretations, or a bug, ASK during the planning phase. No guessing.
- SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
- STATE PRUNING: When updating the roadmap, DELETE the detailed descriptions of completed tasks. Keep the file small.
- CLAUDE.md HYGIENE: When this file grows long, actively trim it. DELETE Work Packages for past/shipped work (keep only forward-relevant gotchas), collapse redundant notes, and drop stale entries. A lean CLAUDE.md is a hard requirement, not optional.
- UPDATE STATE: You MUST update the SESSION STATE at the bottom of this file before finishing a Work Package.
- BASH OVER SUBAGENTS: Use native `rg`/`find` to filter text BEFORE the LLM sees it. 10 lines of `rg` output in Opus is cheaper than 1000 lines of `cat` in a Haiku subagent.
- EDITING STRATEGY: Opus must write surgical edits directly. ONLY spawn subagents for broad, semantic codebase audits or massive multi-file refactors.
- WORKFLOW CYCLE:
  1. Plan the step and read files (using `rg`/tools).
  2. Ask questions EARLY if uncertain (or during execution if needed).
  3. Execute the code (Surgical edits only).
  4. Run tests/checks.
  5. Run `git add . && git commit -m "[Task summary]"`.
  6. Update SESSION STATE below.
  7. STOP and output: "Task committed. Please run `/compact` (or `/clear` if switching to a new theme)."
- WIKI & CLEANLINESS: Documentation goes EXCLUSIVELY in `docs/wiki/`. Delete unused/legacy code immediately. Add some documentation each time and modify the existing one in needed. Only in english, LLM-oriented.
- PROD ACCESS: You can connect to production via SSH using `ssh canari` (or `ssh mitv`).
- CLASSIFIER DOWN: It announces the end of the session. Make a stop as soon as possible and prepare a compaction and an easey resume for the next session.

## **ARCHITECTURE & CONSTRAINTS**

* Stack: SvelteKit 5 \+ Tailwind 4 \+ Tauri 2 (Front) | Rust WASM openmls | NestJS \+ Rust Axum (Back).  
* Nginx: Single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`. If adding API routes, update this config.  
* MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.  
* Build requirements: Always rebuild WASM (`mls-wasm/`) and protobufs (`npm run proto:gen`) after structural changes.  
* Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via `canari_ws_token`.  
* Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.  
* Infra Truth: Keep `infrastructure/MIGRATION.md` synced with any new secrets, services, or bootstrap steps.

## **CODING STANDARDS**

- Logs: Mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions, and error branches.  
- Docs & Comments: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, do not restate types.  
- Factorization: Extract and export reusable logic. Zero duplication.  
- Language: Code, comments, docs, and dev-facing strings (`console.log`, errors) MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline string literals.  
- Punctuation: Normalize to ASCII (`'`, `"`, `-`) everywhere; escape quotes in code (`\'`, `\"`). Preserve French accents (`é`, `à`) ONLY in localized strings/French comments.  
- Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.  
- UI: Single source of truth is `src/app.css` (tokens, `--radius-*`). Use `.btn-glass` with modifiers. Dark-first glassmorphism. Avoid raw hex/px. `lucide-svelte` only (no aliases).  
- Husky: Pre-commit runs oxlint + oxvelte + oxfmt + svelte-check. Fix errors; do not bypass.

## **KEY COMMANDS**

* Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); the Makefile shells out to npm on the same package.json - both work. Prefer bun locally.  
* Setup/Dev: make install, make run-services, cd frontend && bun run dev  
* Tests: make test (All), make test-frontend, cargo test  
* Frontend gates (before every commit): bun run check (svelte-check, MUST be 0 errors), bun run lint (oxlint + oxvelte), bun run format (oxfmt --write .). Rust >= 1.93 (`rust-toolchain.toml`). cargo clippy for Rust crates. The pre-commit hook runs oxfmt+oxlint+oxvelte+check across the WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

## **SESSION STATE (Active Memory) - CONSOLIDATED ROADMAP**

State lives HERE (canonical - single source of truth). ONE roadmap, no parallel state docs. Four repos, all `emse-students/*`, all work on `main` only:
Canari (this monorepo) | Sky (../Sky) | MiGallery (../MiGallery) | Portail-etu (../refonte-portail-etu).
Deep-dive design docs referenced inline. Legend: \[x\] done+pushed, \[ \] todo, \[~\] in progress (uncommitted local tree).

---

### CANARI

All shipped work is verified and lives in git; only durable, forward-relevant gotchas are kept below.

SHIPPED (Canari core - gotchas only):
* **PIN persistence (12e608d):** `pinVault.ts` picks its storage area at call time via `vaultStore()` keyed on the `canari_pin_persist` flag (default `sessionStorage`, opt-in `localStorage`); `setPinPersistence` wipes BOTH stores before re-saving so no stale PIN survives a mode switch. Biometric enrolment is optimistic (alpha plugin resolves before the OS prompt) - re-check `isConfigured()` after enable.
* **Reaction push preview (2ed79d59):** `addReaction` decodes the envelope via `getPreviewText(parseEnvelope(...))` for the notif body (was leaking raw envelope JSON).
* **Stale-PIN recovery regex (eecbfa9c):** recovery-detection regexes in `sessionAuth.ts`/`ChatBackgroundService.svelte` MUST match the actual thrown text ("Incorrect PIN: ...", "...changed on another device") - a never-matching regex ships unnoticed.
* **iOS push = all-FCM (8b227364):** ONE transport (FCM) for both platforms; FCM relays iOS->APNs via the .p8 in the Firebase console. Backend sends every PushToken via `getMessaging().send()` (data+android+apns); `ApnsService` deleted. Client Firebase configs gitignored + CI-injected. APNs<->FCM bridge relies on the Firebase App Delegate Proxy (must stay enabled). Arch: `docs/wiki/services/chat-delivery.md`.
* **Firebase 12 data path (Léon `c68924c2`):** FirebaseMessaging 12 REMOVED `messaging:didReceiveMessage:`. FCM data now arrives as `userInfo` via a `UIApplicationDelegate` swizzle (installed by `CanariInstallRemoteNotificationHook`) + `UNUserNotificationCenter` callbacks, all funnelling into `CanariHandleFcmData()`. Hook new iOS push work into `CanariHandleFcmData`/`CanariPushProcessRemoteNotificationUserInfo`, NOT the deleted delegate. Our native WPs (1-5, 8) coexist cleanly (verified).

Normalization-sweep gotcha: accent-grep MISSES French comments written without accents ("Section Membres") - use both accent-grep AND French-token grep.

#### iOS PARITY ROADMAP (Apple compatibility) - shipped, verified in git

iOS is ~80% a port of the Android native push stack: `gen/apple/Sources/canari/canari_push.mm` mirrors `CanariFirebaseMessagingService.kt`; `src-tauri/src/mobile/ios_ffi.rs` is a C-ABI twin of the Android JNI. `canari.xcodeproj/project.pbxproj` is the hand-maintained build source of truth (NOT `project.yml`/xcodegen) - targets/resources/variant groups are added directly to it, no Mac needed (CI macOS runner builds it). Builds+signs+exports end-to-end in CI (`ios-release.yml`).

Durable gotchas (WP-iOS-1..11, all shipped):
* Platform branches use `isIosTauriRuntime()`/`isMobileTauriRuntime()` (`appVersion.ts`); several Android-only behaviors (heartbeat, notif suppression, `reloadStateFromDisk`) had to be broadened to all-mobile.
* Custom URL scheme, `NS*UsageDescription` keys, `FirebaseAppDelegateProxyEnabled`, and the localized `InfoPlist.strings` (fr/en `PBXVariantGroup`) are all hand-edited in the pbxproj/Info.plist - no plugin generates them.
* iOS keychain namespace is `fr.emse.canari`/`canari_biometric_user`; Android alias `unime_dev` is deliberately UNTOUCHED (renaming orphans enrolled keys).
* NSE (`CanariNotifications` target) decrypts rich notifs via the same Rust FFI, fed by an App Group (`group.fr.emse.canari`) mirror of `mls.bin`/`push_context.json`/`channel_keys.json`.
* CI signing needs two NAMED provisioning profiles matching the pbxproj `PROVISIONING_PROFILE_SPECIFIER` exactly (`Canari` app + `CanariNotifications` NSE), team "Les Rootz" `4CLNB8SR6L`, profiles expire 2027-07-11.
* `scripts/bump-app-version.sh` must patch the NSE's `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in the pbxproj too, or the appex/parent version check warns.

[device] runtime checks still open (need a physical iPhone - genuinely un-automatable): native push (login scheme, heartbeat, BGTask, FCM token refresh), decrypted NSE banner (DM + group + `#channel`), EN prompts on an English-locale iPhone.

STORE PUBLISH (CI fully wired + all 4 secrets set; verified end-to-end on v0.9.21):
* **iOS** `ios-release.yml` runs `xcrun altool --upload-app` to App Store Connect/TestFlight (secrets: `APP_STORE_CONNECT_API_KEY_P8`/`_KEY_ID`/`_ISSUER_ID`, skips if unset). **Manual one-time still required:** create the app record in App Store Connect, fill listing/screenshots/privacy, submit the first build for review (altool only uploads, doesn't submit).
  * Gotcha (fixed): Apple requires the 1024x1024 marketing icon fully OPAQUE (no alpha) or upload fails validation; `altool` can exit 0 while its own output says `UPLOAD FAILED`, so the workflow now greps the transcript for altool's failure markers before declaring success.
* **Android** `android-release.yml` (`r0adkll/upload-google-play`) publishes the AAB straight to `production` (no `internal`-track step - Google refuses re-uploading a versionCode to a second track in the same job). Play Console app + first manual release already done (v0.9.21 published).
* **Update-target repo vars still unset (correctly):** neither `VITE_ANDROID_PLAY_STORE_URL` nor `VITE_IOS_APP_STORE_URL` is configured - user has no real store listing URLs yet. `AppUpdateModal`/`appVersion.ts` fall back to APK-download (Android) / hide the prompt entirely (iOS, no sideload fallback) until set. Set via `gh variable set` once each listing is live.

CROSS-PLATFORM ENHANCEMENTS (WP-XP-*, bilateral - land on BOTH Android + iOS to make the gap table not just paritaire but complete; these are nice-to-haves neither platform has today, each done once per OS with the same UX):
* \[x\] **WP-XP-1 Notification quick actions** (shipped, uncommitted local tree): inline reply + mark-as-read from the shade, both platforms, app fully killed. Gotcha: `AppMessage` protos are built natively (no TS runtime) via shared Rust encoders (`proto_fields.rs`, exposed as JNI `nativeBuild*Proto` + iOS FFI `canari_native_build_*_proto`), then routed through the EXISTING outbox-drain path unchanged. The outbox mirror rewrite on both platforms must persist the `silent` flag or a control event loses it on retry and resends as a visible push (fixed on both, was silently dropped before). Mark-read is cross-device-sync only, no local unread/readBy reconciliation. Arch: `docs/wiki/services/chat-delivery.md` (Notification quick actions).
* \[ \] **WP-XP-2 App-icon unread badge:** keep the launcher/home-screen badge in sync with real unread count (Android notification count/`ShortcutBadger`, iOS `setBadgeCount`). Update on push receipt + on read-state cancel.
* \[ \] **WP-XP-3 Rich media notifications:** show a thumbnail for image/video/GIF messages (Android `BigPictureStyle`, iOS `UNNotificationAttachment`). iOS depends on WP-iOS-6 (NSE) to decrypt the media first.
* \[ \] **WP-XP-4 Boot/relaunch re-registration:** re-register the push token + warm MLS at device boot so a token that rotated while the phone was off doesn't stay dead until manual open (Android `BOOT_COMPLETED` receiver - none today; iOS: force a token re-read at first launch, ties into WP-iOS-8). Table's "Boot persistence = neither" row.
* \[ \] **WP-XP-5 Priority notifications for calls & @mentions:** break through Focus/DND for the things that matter (iOS `interruptionLevel=timeSensitive` + entitlement, calls as full-screen `CallKit`-style; Android high-importance channel + full-screen intent). Leverages the per-OS importance model the table notes iOS "has no concept" of - so add an equivalent tiering.
* \[ \] **WP-XP-6 Keyboard GIF/sticker parity:** Android has `KeyboardMediaBridge.kt`; add the iOS side (pasteboard-image / `UIPasteboard` insert path, since iOS keyboards deliver media differently) so GIF/sticker insertion works from the keyboard on both. Closes the table's last "Missing (likely N/A)" row with an actual iOS answer.
* \[ \] **WP-XP-7 Unified rich notif grouping:** one conceptual notification model shared across OSes - per-conversation stacking + a group summary + avatar/initials fallback (Android `MessagingStyle` already; bring iOS up via the NSE, WP-iOS-6/7). Makes the "Notification display" row fully paritaire.
* \[ \] **WP-XP-8 Shared deferred-retry engine:** one abstraction for background send/decrypt retries behind Android `WorkManager` + iOS `BGTaskScheduler` (WP-iOS-4), with the same "ouvre l'app" nudge UX, so both platforms recover from throttled/failed background work identically. Closes the "Foreground/background service" row.

#### MULTI-TIER COTISATIONS (Cercle) - COMPLETE

Nothing open. Canari's multi-tier assos use exclusive (XOR) statuses, not ordered levels - no hierarchical-inclusion gating needed; `variantLevel` stays unused by design.

Durable gotchas:
* `association_products` has `variantKey`/`variantLevel` (NULL = single-tier, back-compat); `deriveCotisationTag(slug, mode, now?, variant?)` appends `-${variant}` before the academic-year suffix. `userId` Canari IS the Authentik/MiConnect `sub` - no id-mapping table for the Cercle integration.
* `memberPriceTag` - when set, `amountCentsMember` applies iff the buyer holds THAT specific tag. Fulfillment transaction-wraps the grant + `revokeSiblingTierTags` (XOR switch between tiers). `requiredTags` (`text[]`, OR semantics) generalizes gating beyond `membersOnly`; `isBuyerCotisant`/`membersOnly` enumerate ALL of an asso's tier `variantKey`s via `tierVariantKeys()`.
* Inbound `GET /api/public/cotisant-status?assoSlug=&sub=` (`PublicController`, social-service) gated on `X-Api-Key` vs `CERCLE_API_KEY`, throttled 20 req/min. Outbound `dispatchCercleWebhook` (HMAC-SHA256, 3 retries) payload `{ productId, userId, amountCents, paymentIntentId, timestamp }` - `paymentIntentId` is the idempotency key. Both directions in `docs/wiki/cotisations.md`.
* `EditCotisationsTab.svelte` manages tiers (base always first, undeletable; `variantKey` locked after creation). `/shop` sorts base-tier-first and gates member pricing on real eligibility (`qualifiesForMemberPrice`, no client-side tag re-derivation).
* Remaining manual step: set the real `webhookUrl`/`webhookSecret` on the production `balance_topup` product via `/admin/cercle` once Cercle provides them (no credentials yet as of 2026-07-22).

---

### SKY (../Sky) - COMPLETE

Nothing open.

---

### MIGALLERY (../MiGallery) - COMPLETE

Nothing open.

---

### PORTAIL-ETU (../refonte-portail-etu) - COMPLETE

Nothing open.

---

### SHARED GOTCHAS (do not repeat)

* Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash takes it literally and prefixes the subject with `@`).
* Backend app lint scripts call bare `oxlint`/`oxfmt` (resolved from that app's local `node_modules/.bin`, NOT global). If the pre-commit hook fails with `'oxlint' n'est pas reconnu` on an `apps/*` step, the app's install is stale - run `npm install` in that app dir (e.g. `apps/social-service`) to restore the binaries. Backend hook step runs `lint:fix` only (warnings OK); repo-wide `format:check` has pre-existing unformatted files and is not hook-enforced.
* Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.
* Before push (Canari): `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.
* Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant`/`viewerActiveTier` (no client-side tag derivation). The old client mirror deriveCotisationTagName was removed in 4e205ef.
* Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
* Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
* Commit signing is ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`, `commit.gpgsign`/`tag.gpgsign true`, `allowed_signers` for local verify. Pubkey registered as a GitHub **signing key** on account DeMASKe (email `jolan.boudin.jourdan@gmail.com` verified+primary). All new commits on all 4 repos are Verified - do NOT disable signing or bypass it. Registering keys/setting repo secrets uses `gh` (token now has `admin:ssh_signing_key`, `user:email`, `repo`); interactive `gh auth refresh` must be run by the user in their own PowerShell (headless shell has no TTY).
