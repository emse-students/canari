# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES**

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

- Stack: SvelteKit 5 \+ Tailwind 4 \+ Tauri 2 (Front) | Rust WASM openmls | NestJS \+ Rust Axum (Back).
- Nginx: Single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`. If adding API routes, update this config.
- MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build requirements: Always rebuild WASM (`mls-wasm/`) and protobufs (`npm run proto:gen`) after structural changes.
- Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via `canari_ws_token`.
- Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.
- Infra Truth: Keep `infrastructure/MIGRATION.md` synced with any new secrets, services, or bootstrap steps.

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

- Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); the Makefile shells out to npm on the same package.json - both work. Prefer bun locally.
- Setup/Dev: make install, make run-services, cd frontend && bun run dev
- Tests: make test (All), make test-frontend, cargo test
- Frontend gates (before every commit): bun run check (svelte-check, MUST be 0 errors), bun run lint (oxlint + oxvelte), bun run format (oxfmt --write .). Rust >= 1.93 (`rust-toolchain.toml`). cargo clippy for Rust crates. The pre-commit hook runs oxfmt+oxlint+oxvelte+check across the WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

## **SESSION STATE (Active Memory) - CONSOLIDATED ROADMAP**

State lives HERE (canonical - single source of truth). ONE roadmap, no parallel state docs. Four repos, all `emse-students/*`, all work on `main` only:
Canari (this monorepo) | Sky (../Sky) | MiGallery (../MiGallery) | Portail-etu (../refonte-portail-etu).
Deep-dive design docs referenced inline. Legend: \[x\] done+pushed, \[ \] todo, \[~\] in progress (uncommitted local tree).

---

### CANARI

All shipped work is verified and lives in git; only durable, forward-relevant gotchas are kept below.

SHIPPED (Canari core - gotchas only):

- **PIN persistence (12e608d):** `pinVault.ts` picks its storage area at call time via `vaultStore()` keyed on the `canari_pin_persist` flag (default `sessionStorage`, opt-in `localStorage`); `setPinPersistence` wipes BOTH stores before re-saving so no stale PIN survives a mode switch. Biometric enrolment is optimistic (alpha plugin resolves before the OS prompt) - re-check `isConfigured()` after enable.
- **Reaction push preview (2ed79d59):** `addReaction` decodes the envelope via `getPreviewText(parseEnvelope(...))` for the notif body (was leaking raw envelope JSON).
- **Stale-PIN recovery regex (eecbfa9c):** recovery-detection regexes in `sessionAuth.ts`/`ChatBackgroundService.svelte` MUST match the actual thrown text ("Incorrect PIN: ...", "...changed on another device") - a never-matching regex ships unnoticed.
- **iOS push = all-FCM (8b227364):** ONE transport (FCM) for both platforms; FCM relays iOS->APNs via the .p8 in the Firebase console. Backend sends every PushToken via `getMessaging().send()` (data+android+apns); `ApnsService` deleted. Client Firebase configs gitignored + CI-injected. APNs<->FCM bridge relies on the Firebase App Delegate Proxy (must stay enabled). Arch: `docs/wiki/services/chat-delivery.md`.
- **Firebase 12 data path (Léon `c68924c2`):** FirebaseMessaging 12 REMOVED `messaging:didReceiveMessage:`. FCM data now arrives as `userInfo` via a `UIApplicationDelegate` swizzle (installed by `CanariInstallRemoteNotificationHook`) + `UNUserNotificationCenter` callbacks, all funnelling into `CanariHandleFcmData()`. Hook new iOS push work into `CanariHandleFcmData`/`CanariPushProcessRemoteNotificationUserInfo`, NOT the deleted delegate. Our native WPs (1-5, 8) coexist cleanly (verified).

Normalization-sweep gotcha: accent-grep MISSES French comments written without accents ("Section Membres") - use both accent-grep AND French-token grep.

**Build-warnings audit (2026-07-23, COMPLETE):** whole stack compiles at ZERO warnings (Android module graph via `:app:compileUniversalReleaseKotlin`, backend oxlint x5 packages, vite+svelte-check, cargo check src-tauri/mls-wasm). Durable levers: `IPHONEOS_DEPLOYMENT_TARGET=14.0` on the ios-release cargo step; `generated/RustWebView.kt`+`WryActivity.kt` carry CANARI CUSTOM PATCH markers (re-apply after tauri regen); root `build.gradle.kts` silences cargo-registry modules only; `android.suppressUnsupportedOptionWarnings` covers the deliberate gradle flags; `.oxlintrc.nest.json` disables `no-misused-spread` (entity->DTO idiom); `KeyboardMediaBridge` rewritten on receive-content pipeline (needs [device] GIF re-verify). `a6e2fa6a` fixes (bump staging of `canari_iOS/Info.plist` + NSE arch-scoped `LIBRARY_SEARCH_PATHS`) verify on the NEXT release. Non-actionable leftovers: xcodebuild's own stdout lines. Dependabot TS 7.0.2 PRs (#162/#168) blocked upstream on `ts-jest@29` peer.

#### iOS PARITY ROADMAP (Apple compatibility) - shipped, verified in git

iOS is ~80% a port of the Android native push stack: `gen/apple/Sources/canari/canari_push.mm` mirrors `CanariFirebaseMessagingService.kt`; `src-tauri/src/mobile/ios_ffi.rs` is a C-ABI twin of the Android JNI. `canari.xcodeproj/project.pbxproj` is the hand-maintained build source of truth (NOT `project.yml`/xcodegen) - targets/resources/variant groups are added directly to it, no Mac needed (CI macOS runner builds it). Builds+signs+exports end-to-end in CI (`ios-release.yml`).

Durable gotchas (WP-iOS-1..11, all shipped):

- Platform branches use `isIosTauriRuntime()`/`isMobileTauriRuntime()` (`appVersion.ts`); several Android-only behaviors (heartbeat, notif suppression, `reloadStateFromDisk`) had to be broadened to all-mobile.
- Custom URL scheme, `NS*UsageDescription` keys, `FirebaseAppDelegateProxyEnabled`, and the localized `InfoPlist.strings` (fr/en `PBXVariantGroup`) are all hand-edited in the pbxproj/Info.plist - no plugin generates them.
- iOS keychain namespace is `fr.emse.canari`/`canari_biometric_user`; Android alias `unime_dev` is deliberately UNTOUCHED (renaming orphans enrolled keys).
- NSE (`CanariNotifications` target) decrypts rich notifs via the same Rust FFI, fed by an App Group (`group.fr.emse.canari`) mirror of `mls.bin`/`push_context.json`/`channel_keys.json`.
- CI signing needs two NAMED provisioning profiles matching the pbxproj `PROVISIONING_PROFILE_SPECIFIER` exactly (`Canari` app + `CanariNotifications` NSE), team "Les Rootz" `4CLNB8SR6L`, profiles expire 2027-07-11.
- `scripts/bump-app-version.sh` must patch the NSE's `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in the pbxproj too, or the appex/parent version check warns. AND `bump-version.yml` stages an EXPLICIT `git add` list - any new file the bump script patches (e.g. `canari_iOS/Info.plist`) must be added there too or the change is silently dropped from the bump commit (bit v0.10.3).
- Every framework `canari_push.mm` references must be hand-linked in the pbxproj Frameworks phase (CallKit+PushKit added `180270a0` after the first real archive died on undefined `_OBJC_CLASS_$_CX*` symbols - CI archive is the ONLY compile/link check for this file).

[device] runtime checks still open (need a physical iPhone - genuinely un-automatable): native push (login scheme, heartbeat, BGTask, FCM token refresh), decrypted NSE banner (DM + group + `#channel`), EN prompts on an English-locale iPhone. [device] Android: keyboard GIF/sticker commit after the KeyboardMediaBridge receive-content rewrite (`48fdfe02`). [device] WP-XP-5: Android CallStyle ring (killed + DND), iOS CallKit ring via VoIP push (killed), answer handover post-PIN, ring-end clears everywhere, mention channel/time-sensitive elevation on both OSes. [device] WP-XP-6: iOS keyboard GIF (Gboard) insertion via UIPasteboard polling.

STORE PUBLISH (CI fully wired; verified end-to-end up to **v0.10.4** - the WP-XP-5 release: iOS IPA -> TestFlight green (CallKit/PushKit linked, Time Sensitive profile), AppImage green, CD green + `APNS_VOIP_*` verified inside the prod chat-delivery container. **v0.10.4 Android still PENDING**: Play rejects the AAB with "You must let us know whether your app uses any full-screen intent permissions" - WP-XP-5 adds `USE_FULL_SCREEN_INTENT` (already in the manifest). The FSI declaration is Play-Console-ONLY (no androidpublisher API endpoint) AND its form stays INVISIBLE until Play has parsed an artifact carrying the permission - the failed API publish never committed its Edit, so the console never saw the AAB. Resolution for v0.10.4 is MANUAL: user uploads `app-universal-release.aab` (attached to the GitHub release) as a draft Production release -> the FSI task appears under Politique -> Contenu de l'app (or "Go to declaration" in Publishing overview errors) -> declare use case "incoming calls" -> roll out the draft from the console. Do NOT `gh run rerun 30015694435` after a manual upload (versionCode then consumed -> rerun dies on "Version code already used"); CI publish resumes automatically at the next release since the declaration persists):

- **Post-release CD never fired until v0.10.4 (fixed `6f29b053`):** the bump run is release-triggered so its head branch is the TAG, not `main` - cd.yml's `workflow_run` `branches: [main]` filter silently dropped it on every release. Never re-add a branches filter to a workflow_run trigger chained off a release-triggered workflow.
- **iOS** `ios-release.yml` runs `xcrun altool --upload-app` to App Store Connect/TestFlight (secrets: `APP_STORE_CONNECT_API_KEY_P8`/`_KEY_ID`/`_ISSUER_ID`, skips if unset). **Manual one-time still required:** create the app record in App Store Connect, fill listing/screenshots/privacy, submit the first build for review (altool only uploads, doesn't submit).
  - Gotcha (fixed): Apple requires the 1024x1024 marketing icon fully OPAQUE (no alpha) or upload fails validation; `altool` can exit 0 while its own output says `UPLOAD FAILED`, so the workflow now greps the transcript for altool's failure markers before declaring success.
- **Android** `android-release.yml` (`r0adkll/upload-google-play`) publishes the AAB straight to `production` (no `internal`-track step - Google refuses re-uploading a versionCode to a second track in the same job). Play Console app + first manual release already done (v0.9.21 published). **Gotcha (v0.10.2, fixed `4723c104`):** once the app is fully published, the Play API auto-sends changes for review and REJECTS `changesNotSentForReview` outright - the flag was only tolerated pre-launch and must stay absent. A failed publish at that step leaves the versionCode unconsumed (Edit not committed), but re-running needs a NEW release: `gh run rerun` replays the workflow YAML pinned at the original SHA, so workflow-file fixes never apply to reruns.
- **Backend Docker oxlint break (RESOLVED `e4b3e3df`/`48fdfe02`):** oxlint 1.75's optional peer wants `oxlint-tsgolint >=7.0.2001`; upstream published it, pins bumped across the 4 services + shared-ts, cold install verified. If a future oxlint major ERESOLVE-fails again, re-align the `oxlint-tsgolint` pin with `npm view oxlint@<ver> peerDependencies`.
- **Update-target repo vars still unset (correctly):** neither `VITE_ANDROID_PLAY_STORE_URL` nor `VITE_IOS_APP_STORE_URL` is configured - user has no real store listing URLs yet. `AppUpdateModal`/`appVersion.ts` fall back to APK-download (Android) / hide the prompt entirely (iOS, no sideload fallback) until set. Set via `gh variable set` once each listing is live.

CROSS-PLATFORM ENHANCEMENTS (WP-XP-\*, bilateral - each lands on BOTH Android + iOS with the same UX).

**WP-XP METHOD (reuse for every WP-XP - proven on 1-4):**

1. Read the native stack first (Android `CanariFirebaseMessagingService.kt` + iOS `canari_push.mm`/NSE + Rust FFI twins `mobile/*_ffi.rs`/`proto_fields.rs`), design ONCE, port to both OSes.
2. Implement Android + iOS + backend together; shared logic goes in Rust FFI leaves, routed through the EXISTING outbox/push paths. Update `docs/wiki/services/chat-delivery.md` + Paraglide FR/EN in the same change.
3. Local gates until ZERO warnings: bun run check/lint/format, cargo check (src-tauri + mls-wasm), backend oxlint, AND `:app:compileUniversalReleaseKotlin` - the release build is the ONLY real Kotlin compile (push-CI compiles none; nested types shared across classes go on the OUTER class body, never the companion).
4. Commit signed (heredoc), isolate unrelated dirty files, `rm -rf apps/*/dist`, pull --rebase --autostash, push.
5. Cut a release (`gh release create vX.Y.Z --target $(git rev-parse HEAD)`), follow ios/android/appimage/cd runs until ALL green. Source fix -> `gh run rerun` (keeps workflow_run context + re-checks-out main); workflow-YAML fix -> NEW release (rerun replays the YAML pinned at the original SHA).
6. Update SESSION STATE (prune shipped detail!) + memory; flag [device] checks.

Shipped (gotchas only; arch in `docs/wiki/services/chat-delivery.md`):

- \[x\] **WP-XP-1 Notification quick actions:** protos built natively via shared Rust encoders -> existing outbox drain; outbox mirror MUST persist the `silent` flag (retry resends visible otherwise); iOS buttons need `categoryIdentifier == "canari_message_category"` stamped by BOTH `CanariShowLocalNotification` (app alive) and the NSE (killed) - backend sends no `aps.category`. Mark-read is cross-device-sync only.
- \[x\] **WP-XP-2 App-icon unread badge:** badge = distinct unread CONVERSATIONS off displayed notifs (no counter store). Android summary `setNumber()`; iOS two writers by process state (`CanariUpdateAppBadge` alive / NSE `content.badge` killed).
- \[x\] **WP-XP-3 Rich media notifications (v0.10.1):** images+GIF only, MLS DM/group only, 2 MB cap. Killed app has no JWT -> PushSecret proxy `GET /api/mls/push/media/:mediaId` (chat-delivery) -> media-service `GET /api/media/internal/:id` (X-Internal-Secret); native decrypt via `nativeDecryptMedia`/`canari_native_decrypt_media`. iOS: media thumbnail outranks avatar (first image attachment wins). chat-delivery env: `MEDIA_SERVICE_URL`, `INTERNAL_SECRET`.
- \[x\] **WP-XP-4 Boot/relaunch re-registration:** Android `CanariBootReceiver` (`BOOT_COMPLETED`+`MY_PACKAGE_REPLACED`, exported=false) re-fetches+re-registers the FCM token then drains outbox; iOS already covered by launch-time force-fetch. Manifest guard: `androidFcmManifest.test.ts`.
- \[x\] **WP-XP-5 Priority notifications (calls & @mentions):** ring = EXPLICIT cleartext signal (server can't read MLS): caller POSTs `/api/calls/ring` after the (now SILENT) MLS invite; ALL CallMsg protos are silent. Fan-out: Android FCM `call_ring` -> CallStyle+full-screen+FLAG_INSISTENT (`canari_calls` channel); iOS+voipToken -> DIRECT APNs VoIP (`ApnsVoipService`, the ONE all-FCM exception - FCM can't carry voip pushes) -> CallKit; legacy iOS -> FCM banner. `/api/calls/ring-end` (answered/cancelled/ended) to ALL members incl. own devices + 60s local timeout both OSes. Gotchas: `call_ring_end` MUST process BEFORE the foreground guard (both OSes); every VoIP push MUST report a CallKit call or Apple kills the app; CallKit answer can't start audio (MLS behind PIN) -> `pending_call_accept.json`/deep-link `?acceptCall=` -> `pendingCallAccept` store -> auto-accept on WS invite, CallKit session ended on didBecomeActive (handover); Android posted-notif channel switch needs cancel-then-notify; mentions = decrypted text contains `@[<myUserId>]` -> `canari_mentions` channel / iOS `.timeSensitive` (needs the time-sensitive entitlement, silently downgrades without); pre-WP-XP-5 callers still ring via native `call_invite` extraction (field 7), deduped via `activeCallRings`/`g_ringingCalls`. Backend env `APNS_VOIP_KEY_P8/_KEY_ID/_TEAM_ID` (optional, warning-only in CD); migration `010_push_token_voip.sql` adds `push_token.voipToken`.
- \[x\] **WP-XP-6 Keyboard GIF/sticker parity (d119dcd8):** iOS `KeyboardMediaBridge.mm` polls `UIPasteboard.general` at 0.5s (foreground-only, paused on resign-active) via `NSTimer` and dispatches `canari-keyboard-media` CustomEvents matching the Android `KeyboardMediaBridge.kt` JSON shape byte-for-byte. WKWebView found via recursive window-scene traversal (`FindWebView`); `changeCount`-based dedup avoids clearing the pasteboard. Frontend handlers in `MainChatPage.svelte`/`PostComments.svelte` already cross-platform (no changes needed). Gotchas: bridge initialized at bootstrap with `CanariKeyboardMediaStart(nil)` (WKWebView not yet created - found lazily on first become-active); `canari_ios_is_in_foreground()` guards the poll timer so backgrounded CPU is zero; iOS keyboard GIF verify needs [device] Gboard physical iPhone.

Todo:

- \[ \] **WP-XP-7 Unified rich notif grouping:** one conceptual notification model shared across OSes - per-conversation stacking + a group summary + avatar/initials fallback (Android `MessagingStyle` already; bring iOS up via the NSE, WP-iOS-6/7). Makes the "Notification display" row fully paritaire.
- \[ \] **WP-XP-8 Shared deferred-retry engine:** one abstraction for background send/decrypt retries behind Android `WorkManager` + iOS `BGTaskScheduler` (WP-iOS-4), with the same "ouvre l'app" nudge UX, so both platforms recover from throttled/failed background work identically. Closes the "Foreground/background service" row.
- \[ \] **WP-Calls-UX call UI overhaul** (user-approved 2026-07-23; audit of `CallOverlay.svelte`/`CallService.ts`). Priority fixes: (1) outgoing AUDIO call starts as the tiny docked widget (`compact = !hasAnyVideo`) - `calling` state must always be full-screen, auto-dock only once connected; (2) NO in-app ringtone on web/desktop (incoming overlay is silent+visual only) - add ring loop + blinking `document.title` + web Notification; (3) no call-duration timer anywhere - add mm:ss chrono (status pill + compact widget); (4) no "missed call"/"call ended (duration)" system message in the conversation - render off ring-end signals, missed-call clickable to call back; (5) incoming screen reuses the in-call layout - build a real "X t'appelle" hero screen (big avatar, video hint), and on desktop a compact corner toast instead of the blocking full-screen. Secondary: (6) mobile speaker/earpiece toggle (needs a small native AudioManager/AVAudioSession bridge - separate bilateral WP); (7) compact-widget camera button silently expands AND enables video (split into two actions); (8) full-screen card is capped `max-h-[82vh]` - go edge-to-edge on mobile 1:1 video with auto-hiding controls; (9) web decline on a GROUP incoming call sends hangup to everyone - align with native "decline = stop ringing me only". Points 1-5 are pure Svelte/TS (CallOverlay + Paraglide).

#### MULTI-TIER COTISATIONS (Cercle) - COMPLETE

Nothing open. Canari's multi-tier assos use exclusive (XOR) statuses, not ordered levels - no hierarchical-inclusion gating needed; `variantLevel` stays unused by design.

Durable gotchas:

- `association_products` has `variantKey`/`variantLevel` (NULL = single-tier, back-compat); `deriveCotisationTag(slug, mode, now?, variant?)` appends `-${variant}` before the academic-year suffix. `userId` Canari IS the Authentik/MiConnect `sub` - no id-mapping table for the Cercle integration.
- `memberPriceTag` - when set, `amountCentsMember` applies iff the buyer holds THAT specific tag. Fulfillment transaction-wraps the grant + `revokeSiblingTierTags` (XOR switch between tiers). `requiredTags` (`text[]`, OR semantics) generalizes gating beyond `membersOnly`; `isBuyerCotisant`/`membersOnly` enumerate ALL of an asso's tier `variantKey`s via `tierVariantKeys()`.
- Inbound `GET /api/public/cotisant-status?assoSlug=&sub=` (`PublicController`, social-service) gated on `X-Api-Key` vs `CERCLE_API_KEY`, throttled 20 req/min. Outbound `dispatchCercleWebhook` (HMAC-SHA256, 3 retries) payload `{ productId, userId, amountCents, paymentIntentId, timestamp }` - `paymentIntentId` is the idempotency key. Both directions in `docs/wiki/cotisations.md`.
- `EditCotisationsTab.svelte` manages tiers (base always first, undeletable; `variantKey` locked after creation). `/shop` sorts base-tier-first and gates member pricing on real eligibility (`qualifiesForMemberPrice`, no client-side tag re-derivation).
- Remaining manual step: set the real `webhookUrl`/`webhookSecret` on the production `balance_topup` product via `/admin/cercle` once Cercle provides them (no credentials yet as of 2026-07-22).

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

- Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash takes it literally and prefixes the subject with `@`).
- Backend app lint scripts call bare `oxlint`/`oxfmt` (resolved from that app's local `node_modules/.bin`, NOT global). If the pre-commit hook fails with `'oxlint' n'est pas reconnu` on an `apps/*` step, the app's install is stale - run `npm install` in that app dir (e.g. `apps/social-service`) to restore the binaries. Backend hook step runs `lint:fix` only (warnings OK); repo-wide `format:check` has pre-existing unformatted files and is not hook-enforced.
- Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.
- Before push (Canari): `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.
- Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant`/`viewerActiveTier` (no client-side tag derivation). The old client mirror deriveCotisationTagName was removed in 4e205ef.
- Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
- Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
- Commit signing is ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`, `commit.gpgsign`/`tag.gpgsign true`, `allowed_signers` for local verify. Pubkey registered as a GitHub **signing key** on account DeMASKe (email `jolan.boudin.jourdan@gmail.com` verified+primary). All new commits on all 4 repos are Verified - do NOT disable signing or bypass it. Registering keys/setting repo secrets uses `gh` (token now has `admin:ssh_signing_key`, `user:email`, `repo`); interactive `gh auth refresh` must be run by the user in their own PowerShell (headless shell has no TTY).
