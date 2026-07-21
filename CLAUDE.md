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
- WIKI & CLEANLINESS: Documentation goes EXCLUSIVELY in `docs/wiki/`. Delete unused/legacy code immediately.
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

All shipped work below is verified (on-device checks done per user). Only durable, forward-relevant gotchas kept; full implementation lives in git.

* **PIN unlock persistence (12e608d):** `pinVault.ts` picks its storage area at call time via `vaultStore()` keyed on the `canari_pin_persist` localStorage flag - default `sessionStorage` (wiped on browser close), opt-in `localStorage` ("stay signed in"). `setPinPersistence(enabled, pin)` wipes BOTH stores then re-saves, so no stale PIN copy survives a mode switch; `clearPin`/`clearPinAndKey` clear both stores. The PIN-modal checkbox sets the flag (pin=null) BEFORE login so loginImpl's fire-and-forget `savePin` lands in the right store; the Settings toggle migrates the live session (pin=session.pin). Biometric toggle in `SettingsSecuritySection` reuses `session.enrollBiometric()` / new `session.disableBiometric()` (removes keystore secret + re-saves PIN to vault). Enrolment is optimistic (alpha plugin resolves before the OS prompt) - re-check `isConfigured()` after enable.

* **Reaction push preview (2ed79d59):** `addReaction` now decodes the target message's envelope via `getPreviewText(parseEnvelope(...))` before sending it as the notification body, instead of leaking raw envelope JSON.

* **Stale-PIN recovery regex (eecbfa9c):** Recovery-detection regexes in `sessionAuth.ts`/`ChatBackgroundService.svelte` must match the ACTUAL thrown error text ("Incorrect PIN: ...", "...changed on another device"), not a guessed/reversed phrasing - a silently-never-matching regex is easy to ship unnoticed since the surrounding code still runs without erroring.

* **iOS push = all-FCM (8b227364):** ONE transport (FCM) for both platforms; FCM relays iOS->APNs via the .p8 in the Firebase console (no direct APNs provider). Backend sends every PushToken via `getMessaging().send()` with data+android+apns blocks; the dead `ApnsService`/`partitionTokensByPlatform` were deleted. `PushNotificationService.ts` registers the FCM token on iOS too (`platform:'ios'`). iOS native was cleaned: plist reference fixed (`canari_iOS/GoogleService-Info.plist`), CocoaPods Firebase removed (SPM authoritative), dead `TauriAppDelegate` reverted, `aps-environment=production`. Client Firebase configs are gitignored + CI-injected (`GOOGLE_SERVICES_JSON`, `GOOGLE_SERVICE_INFO_PLIST` secret set). APNs<->FCM token bridge relies on Firebase App Delegate Proxy (must stay enabled). Arch in `docs/wiki/services/chat-delivery.md`.
  * Remaining iOS work is tracked in the **iOS PARITY ROADMAP** below (NSE, CD secrets, background-execution wiring, biometric cleanup). Léon's novice CD-setup guide: `docs/wiki/infrastructure/ios-ci-cd-setup.md`.

Normalization-sweep gotcha: accent-grep MISSES French comments written without accents ("Section Membres", "chiffre a une epoch perimee") - use both accent-grep AND French-token grep.

#### iOS PARITY ROADMAP (Apple compatibility) - audited 2026-07-21

KEY FINDING: iOS is ~80% built, NOT a from-scratch port. `gen/apple/Sources/canari/canari_push.mm` (1641 lines) is a near line-for-line port of the Android `CanariFirebaseMessagingService.kt` (MLS decrypt, welcome create/join, commit catch-up, channel decrypt, outbox drain, avatar cache, read-state sync, local notifs). `src-tauri/src/mobile/ios_ffi.rs` exposes a C-ABI twin of every Android JNI entry point. The keystore plugin patch has a Swift impl. Remaining gaps are STRUCTURAL (killed-app background execution, biometric plugin cleanup) + FRONTEND platform-branches that exclude iOS, NOT missing features.

DONE this session (frontend correctness + native hardening, verifiable without a Mac):
* \[x\] **iOS platform-branch helpers + fixes:** added `isIosTauriRuntime()`/`isMobileTauriRuntime()` in `appVersion.ts`. `TauriMlsService.reloadStateFromDisk` (was Android-only -> stale warm-state/lost-update on iOS since `canari_push.mm` advances `mls.bin` in bg) now runs on all mobile. `useMessaging.svelte.ts` system-notif suppression now covers iOS too (was Android-only -> iOS would double-notify: native + JS).
* \[x\] **iOS Info.plist hardening:** added `NSCamera/Microphone/PhotoLibrary/FaceID UsageDescription` (Face ID crashes hard without its key) + explicit `FirebaseAppDelegateProxyEnabled=YES` (the APNs<->FCM bridge silently depended on the default). Strings are FR-only for now (see WP-iOS-10).
* \[x\] **WP-iOS-1 OIDC deep-link login on iOS (28e43cd7):** `auth.ts` now uses `isMobileTauriRuntime()` (not Android-only) for both the `fr.emse.canari://callback` redirect URI and the "open in system browser" branch, so iOS logs in via SFSafariViewController + custom-scheme callback. Added the missing `CFBundleURLTypes` (scheme `fr.emse.canari`) to the iOS Info.plist - on iOS the custom scheme must be declared manually (Android's is plugin-generated). The `hooks.client.ts` deep-link listener already consumed the callback generically. [device] Verify login end-to-end on a real iPhone.
* \[x\] **WP-iOS-2 foreground heartbeat on iOS (8ce6a98d):** DECISION = iOS needs the JS heartbeat too. The 30s `FOREGROUND_GRACE_MS` guard (`lib.rs`) gates the background `mls.bin` writers on BOTH platforms (`cfg(any(android, ios))`), but iOS only refreshed it once via `canari_ios_on_resume`; without a periodic refresh the guard expired ~30s into a genuinely-foregrounded iOS session, letting an in-process FCM data push clobber the warm engine's in-memory state. Broadened the 10s heartbeat gate in `ChatBackgroundService.svelte` from `isAndroidTauriRuntime()` to `isMobileTauriRuntime()`; the native `mls_foreground_heartbeat` cmd (-> `mark_foreground_active`) is platform-agnostic + registered unconditionally. `pause_mls_foreground` on `hidden` + `reloadStateFromDisk` on resume already ran on all mobile. Fixed 3 svelte-check + 2 oxvelte warnings along the way (SeoHead `@html` -> repo-standard `eslint-disable-next-line svelte/no-at-html-tags`; MinesweeperModal `$state` bind:this + justified `prefer-svelte-reactivity` disable). [device] Confirm warm/native bg engine handoff on a real iPhone.
* \[x\] **WP-iOS-3 keystore_ok.flag + pending-secret migration on iOS - VERIFIED, no code change:** the iOS launch path already mirrors Android 1:1 and is even more robust. `main.mm` calls `canari_ios_bootstrap()` before `ffi::start_app()` (the `Application.onCreate` analogue); it runs `CanariProcessPendingPushSecret()` then `CanariCheckKeystoreHealth()` at launch AND again on every `didBecomeActive` (`canari_ios.mm`). `CanariCheckKeystoreHealth` writes/removes `keystore_ok.flag` exactly like Android. The migration lives inside `CanariRetrievePushSecret` (`canari_push.mm`): Keychain-first, else read `pending_push_secret.txt` -> `CanariPushSecretStore` (SecItemAdd, `AfterFirstUnlockThisDeviceOnly`) -> zero + delete file. `check_push_secret_health` (`lib.rs`) is already `cfg(any(android, ios))` and honors flag + pending-file fallback. => no false "keystore lost" banner on iOS; nothing to fix. Gotcha: `CanariProcessPendingPushSecret` + `CanariCheckKeystoreHealth` both call `CanariRetrievePushSecret` (redundant read, harmless) - intentional parity with Android's two separate methods, keep both.
* \[x\] **WP-iOS-4 background-execution model (BGProcessingTask) [device]:** wired the iOS peer of Android's expedited `MlsBackgroundWorker`. Added `BGTaskSchedulerPermittedIdentifiers=[fr.emse.canari.cleanup]` to `Info.plist`; `canari_push.mm` now registers a `BGProcessingTask` launch handler (`CanariRegisterBackgroundTasks`, called from `canari_ios_bootstrap` BEFORE `ffi::start_app()`/UIApplicationMain - the only valid window, since the `DidFinishLaunching` observer fires too late and BGTaskScheduler throws) that runs `canari_native_cleanup_pending_db` then re-submits the next window; `CanariScheduleBackgroundCleanupTask` is submitted on `willResignActive`. All guarded by `#if __has_include(<BackgroundTasks/BackgroundTasks.h>)` + `@available(iOS 13.0,*)`. Backend `content-available:1` for silent frames was ALREADY correct (`push-payload.ts` `buildApnsRequest`, spec-covered in `push-payload.spec.ts`) - no change. Documented the structural iOS force-quit limitation (no silent push + no BGTask until manual relaunch; Android has no such limit) in `docs/wiki/services/chat-delivery.md`. Gotcha: iOS gives NO cadence guarantee for BGTask - best-effort catch-up, not a WorkManager-grade scheduler. [device] Verify the handler fires on a signed build (Xcode debugger: `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"fr.emse.canari.cleanup"]`).

TODO WPs (each = one focused session; those marked [device] need a signed build on a real iPhone to verify):
* \[ \] **WP-iOS-5 (P2, biometric cleanup):** `patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift` has hardcoded UniMe leftovers (`com.impierce.identity-wallet.unime-dev` account, "Access your UniMe password" reason) - copied, not adapted. Align account/service with the Android alias contract that `biometric.ts` passes, wire an explicit `LAContext`/`kSecAccessControl(.userPresence)` biometric eval on `retrieve`, localize the reason. Update `biometric.ts` comments/TODO (they reference "reglages Android" only).
* \[ \] **WP-iOS-6 (P2, Notification Service Extension) [device]:** decrypted iOS notifs. New Xcode target + App Group (share `mls.bin`/keychain with the extension) + its own provisioning profile (regenerate after adding the App Group capability). Until it ships iOS shows the `mutable-content` fallback "Nouveau message". This target also unlocks per-conversation notif grouping parity (WP-iOS-7).
* \[ \] **WP-iOS-7 (P3, notif richness):** iOS notifs are flat `UNMutableNotificationContent` + `threadIdentifier`; Android has `MessagingStyle` (stacked per-convo messages, group summary, circular avatar + initials fallback). Improve inside the NSE (WP-iOS-6) or via a UN summary. Low priority.
* \[ \] **WP-iOS-8 (P2, FCM token):** iOS refreshes the FCM token only on change (`didReceiveRegistrationToken`); Android force-reads it to `fcm_token.txt` on every cold start (`MainActivity`). Add a launch-time token fetch so a token that rotated while the app was killed still re-registers.
* \[ \] **WP-iOS-9 (P3, update UX):** `appVersion.ts getAppUpdateUrl` / `AppUpdateModal` / `PlatformGateOverlay` drive an APK-download flow via `isAndroidTauriRuntime()`; iOS has no update path. Define the iOS App Store update UX (deep-link to the App Store listing) or hide the update prompts on iOS.
* \[ \] **WP-iOS-10 (P3, i18n):** the Info.plist usage strings (WP done above) are FR-only. Add per-locale `InfoPlist.strings` (FR + EN) so the OS permission prompts localize.
* \[ \] **WP-iOS-11 (CD, blocked on Apple secrets):** enable `ios-release.yml` (build-only + disabled today). Needs `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, `APPLE_CERTIFICATE_BASE64` (.p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_PROVISIONING_PROFILE` (.mobileprovision b64) - user/Léon must generate. Then add a TestFlight upload step (App Store Connect API key). Full novice walkthrough: `docs/wiki/infrastructure/ios-ci-cd-setup.md`.

CROSS-PLATFORM ENHANCEMENTS (WP-XP-*, bilateral - land on BOTH Android + iOS to make the gap table not just paritaire but complete; these are nice-to-haves neither platform has today, each done once per OS with the same UX):
* \[ \] **WP-XP-1 Notification quick actions:** inline "Repondre" + "Marquer comme lu" straight from the notification (Android `RemoteInput`/`Notification.Action`, iOS `UNNotificationAction`/`UNTextInputNotificationAction`). Reply routes through the existing background outbox drain; mark-read reuses the read-state sync path.
* \[ \] **WP-XP-2 App-icon unread badge:** keep the launcher/home-screen badge in sync with real unread count (Android notification count/`ShortcutBadger`, iOS `setBadgeCount`). Update on push receipt + on read-state cancel.
* \[ \] **WP-XP-3 Rich media notifications:** show a thumbnail for image/video/GIF messages (Android `BigPictureStyle`, iOS `UNNotificationAttachment`). iOS depends on WP-iOS-6 (NSE) to decrypt the media first.
* \[ \] **WP-XP-4 Boot/relaunch re-registration:** re-register the push token + warm MLS at device boot so a token that rotated while the phone was off doesn't stay dead until manual open (Android `BOOT_COMPLETED` receiver - none today; iOS: force a token re-read at first launch, ties into WP-iOS-8). Table's "Boot persistence = neither" row.
* \[ \] **WP-XP-5 Priority notifications for calls & @mentions:** break through Focus/DND for the things that matter (iOS `interruptionLevel=timeSensitive` + entitlement, calls as full-screen `CallKit`-style; Android high-importance channel + full-screen intent). Leverages the per-OS importance model the table notes iOS "has no concept" of - so add an equivalent tiering.
* \[ \] **WP-XP-6 Keyboard GIF/sticker parity:** Android has `KeyboardMediaBridge.kt`; add the iOS side (pasteboard-image / `UIPasteboard` insert path, since iOS keyboards deliver media differently) so GIF/sticker insertion works from the keyboard on both. Closes the table's last "Missing (likely N/A)" row with an actual iOS answer.
* \[ \] **WP-XP-7 Unified rich notif grouping:** one conceptual notification model shared across OSes - per-conversation stacking + a group summary + avatar/initials fallback (Android `MessagingStyle` already; bring iOS up via the NSE, WP-iOS-6/7). Makes the "Notification display" row fully paritaire.
* \[ \] **WP-XP-8 Shared deferred-retry engine:** one abstraction for background send/decrypt retries behind Android `WorkManager` + iOS `BGTaskScheduler` (WP-iOS-4), with the same "ouvre l'app" nudge UX, so both platforms recover from throttled/failed background work identically. Closes the "Foreground/background service" row.

#### OPEN BACKLOG (reported 2026-07-20, triaged by severity x speed)

**P1 - broken functionality:**
* \[ \] **Mobile: cannot enter a community channel after being added, until the app is relaunched.** Freshly-added membership isn't usable in-session on mobile (channel open fails); works after restart. Likely the community/channel analogue of the MLS group-discovery/recovery seam (see MLS group recovery gotcha above) - channel not hydrated until the next `discoverMissingGroups`/relaunch. Investigate channel join hydration path on mobile.
* \[ \] **System-message notifications show `Message de XXX`** when someone changes the group photo or a member is added - the system/control message isn't decoded into human text. Map system message kinds (photo changed, member added/removed, etc.) to localized notif strings.
**P2 - UI correctness / polish:**
* \[ \] **Remove per-salon/channel avatars entirely** (no placeholder either - show just the channel name). Community-level avatar editing was checked and already works fine (`SidebarCommunityAdminModal`, permission-gated) - that half of the old bullet is done. Channel avatars are still fully implemented (image/placeholder via `GroupAvatar`, editable in `ChannelSettingsModal.svelte:442-465`) and need to be stripped out.
* \[ \] **"Show members" toggle does nothing on desktop** in the channel header. Root cause found: `MainChatPage.svelte` gates the mobile drawer (`xl:hidden`) on `isChannelMembersDrawerOpen`, but the persistent desktop sidebar (`ChannelMembersSidebar.svelte:66-68`, `xl:flex`) renders unconditionally from a CSS breakpoint alone - so on `xl`+ viewports the toggle button is shown but wired to a state nothing visible consumes. Needs a product decision: hide the toggle button on desktop widths, or make the desktop sidebar collapsible via the same state.
* \[ \] **Push notification bodies are hardcoded English server-side** (`messaging.controller.ts`: `'New reaction'` / `reacted with ... to ...`), with no per-user locale on the push path - discuss whether to thread the recipient's locale into `sendPushToUser` and localize via Paraglide server-side, or accept English-only pushes as a product decision.

**P3 - feature:**
* \[ \] **Reorder communities** via drag-and-drop (user-defined display order, persisted).

---

### SKY (../Sky) - COMPLETE (HEAD 77f69d0)

Nothing open. Conventions in memory: [[project_sky_conventions]], accents [[feedback_sky_french_accents]] (vitest include = `src/**` only -> co-locate tests in src/). Future nice-to-have: promo color legend.
Gotcha (77f69d0): create+link is ATOMIC via `createPlaceholderAndLink` (transaction: any RelationError rolls back the placeholder -> no orphan). Never insert a placeholder then validate the link separately. Merge identity conflicts (nom/prenom/promo differ) resolved via `MergeResolveModal` + pure `mergeIdentity.ts` helper (shared UI+endpoint); `mergePeople(remove, keep, survivorIdentity?)` applies the chosen values; bulk merge-all stays survivor-wins.

---

### MIGALLERY (../MiGallery) - COMPLETE (HEAD 882d6d1)

Normalization (wiki + i18n + tolerant search) and cleanup done ([[project_migallery_normalization]]). Residual (minor, opportunistic): stray French code comments in src - fold into touched files, no dedicated pass.

---

### PORTAIL-ETU (../refonte-portail-etu) - Vitrine SPA - COMPLETE

Vitrine SPA (SvelteKit 5 + Tailwind 3.4 + svelte-adapter-bun, `ssr = false`: deploy host can't reach canari-emse.fr / hairpin NAT). Reads Canari public API `/api/public/*` from the browser. Redesign v2, avatar proxy, i18n, MD bios, CI integrity, N7 CD-via-Secrets (verified live 2026-07-15) all DONE ([[project_portail_vitrine_migration]]). Nothing open.

---

### SHARED GOTCHAS (do not repeat)

* Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash takes it literally and prefixes the subject with `@`).
* Backend app lint scripts call bare `oxlint`/`oxfmt` (resolved from that app's local `node_modules/.bin`, NOT global). If the pre-commit hook fails with `'oxlint' n'est pas reconnu` on an `apps/*` step, the app's install is stale - run `npm install` in that app dir (e.g. `apps/social-service`) to restore the binaries. Backend hook step runs `lint:fix` only (warnings OK); repo-wide `format:check` has pre-existing unformatted files and is not hook-enforced.
* Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.
* Before push (Canari): `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.
* Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant` (no client-side tag derivation). The old client mirror deriveCotisationTagName was removed in 4e205ef.
* Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
* Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
* Commit signing is ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`, `commit.gpgsign`/`tag.gpgsign true`, `allowed_signers` for local verify. Pubkey registered as a GitHub **signing key** on account DeMASKe (email `jolan.boudin.jourdan@gmail.com` verified+primary). All new commits on all 4 repos are Verified - do NOT disable signing or bypass it. Registering keys/setting repo secrets uses `gh` (token now has `admin:ssh_signing_key`, `user:email`, `repo`); interactive `gh auth refresh` must be run by the user in their own PowerShell (headless shell has no TTY).
