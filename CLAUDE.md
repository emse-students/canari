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

All shipped work is verified and lives in git; only durable, forward-relevant gotchas are kept below.

SHIPPED (Canari core - gotchas only):
* **PIN persistence (12e608d):** `pinVault.ts` picks its storage area at call time via `vaultStore()` keyed on the `canari_pin_persist` flag (default `sessionStorage`, opt-in `localStorage`); `setPinPersistence` wipes BOTH stores before re-saving so no stale PIN survives a mode switch. Biometric enrolment is optimistic (alpha plugin resolves before the OS prompt) - re-check `isConfigured()` after enable.
* **Reaction push preview (2ed79d59):** `addReaction` decodes the envelope via `getPreviewText(parseEnvelope(...))` for the notif body (was leaking raw envelope JSON).
* **Stale-PIN recovery regex (eecbfa9c):** recovery-detection regexes in `sessionAuth.ts`/`ChatBackgroundService.svelte` MUST match the actual thrown text ("Incorrect PIN: ...", "...changed on another device") - a never-matching regex ships unnoticed.
* **iOS push = all-FCM (8b227364):** ONE transport (FCM) for both platforms; FCM relays iOS->APNs via the .p8 in the Firebase console. Backend sends every PushToken via `getMessaging().send()` (data+android+apns); `ApnsService` deleted. Client Firebase configs gitignored + CI-injected. APNs<->FCM bridge relies on the Firebase App Delegate Proxy (must stay enabled). Arch: `docs/wiki/services/chat-delivery.md`.
* **Firebase 12 data path (Léon `c68924c2`):** FirebaseMessaging 12 REMOVED `messaging:didReceiveMessage:`. FCM data now arrives as `userInfo` via a `UIApplicationDelegate` swizzle (installed by `CanariInstallRemoteNotificationHook`) + `UNUserNotificationCenter` callbacks, all funnelling into `CanariHandleFcmData()`. Hook new iOS push work into `CanariHandleFcmData`/`CanariPushProcessRemoteNotificationUserInfo`, NOT the deleted delegate. Our native WPs (1-5, 8) coexist cleanly (verified).

Normalization-sweep gotcha: accent-grep MISSES French comments written without accents ("Section Membres") - use both accent-grep AND French-token grep.

#### iOS PARITY ROADMAP (Apple compatibility)

iOS is ~80% a port of the Android native push stack: `gen/apple/Sources/canari/canari_push.mm` mirrors `CanariFirebaseMessagingService.kt`; `src-tauri/src/mobile/ios_ffi.rs` is a C-ABI twin of the Android JNI. Léon made it COMPILE on his Mac (Firebase 12 + `ios-release.yml`); the hand-maintained `canari.xcodeproj/project.pbxproj` is the build source of truth, NOT `project.yml`/xcodegen.

SHIPPED (WP-iOS-1..9, verified in git - durable gotchas only):
* Platform branches: `isIosTauriRuntime()`/`isMobileTauriRuntime()` in `appVersion.ts`; `reloadStateFromDisk`, the 10s foreground heartbeat, and system-notif suppression were all broadened Android-only -> all-mobile (else iOS double-notifies / loses warm state).
* **WP-iOS-1 login:** the iOS custom scheme `fr.emse.canari` must be declared BY HAND in Info.plist `CFBundleURLTypes` (Android's is plugin-generated). [device]
* **WP-iOS-2 heartbeat:** the 30s `FOREGROUND_GRACE_MS` guard (`lib.rs`, `cfg(any(android,ios))`) needs the JS heartbeat on iOS too, else an in-process FCM push clobbers warm in-memory state ~30s in. [device]
* **WP-iOS-3 keystore health:** no code change - iOS launch already mirrors Android (`canari_ios_bootstrap` -> pending-secret migration + `keystore_ok.flag`).
* **WP-iOS-4 BGProcessingTask:** `CanariRegisterBackgroundTasks` MUST run before `UIApplicationMain` (from `canari_ios_bootstrap`); iOS gives NO cadence guarantee (best-effort, not WorkManager). [device]
* **WP-iOS-5 biometric:** iOS keychain rebranded to `fr.emse.canari`/`canari_biometric_user`; Android alias `unime_dev` deliberately UNTOUCHED (renaming orphans enrolled keys).
* **WP-iOS-8 FCM token:** `didReceiveRegistrationToken` only fires on change -> force-fetch once per cold start via `CanariPersistFcmToken` (mirrors Android `onCreate`). [device]
* **Info.plist hardening:** `NS*UsageDescription` (Face ID crashes hard without its key) + explicit `FirebaseAppDelegateProxyEnabled=YES`. Strings FR-only (WP-iOS-10).

OPEN:
* \[x\] **WP-iOS-6/7 NSE (code complete, awaits Mac):** decrypted, rich iOS notifs. All Swift/ObjC/plist ship in `canari_NSE/`; `NotificationService.swift` reuses the Rust decrypt FFI (linked from `libapp.a`), App Group `group.fr.emse.canari` mirrors `mls.bin`/`push_context.json`/`channel_keys.json`/push secret cross-process (`CanariMirrorPushStateToAppGroup`). Backend done (`buildInternalApnsRequest` gives channel/social pushes `mutable-content`). The NSE target is added BY HAND in Xcode to the pbxproj (NOT project.yml). Remaining = Mac/Xcode checklist: `docs/wiki/infrastructure/ios-nse-setup.md`. [device] verify decrypted banner.
* \[x\] **WP-iOS-10 (i18n, awaits Mac wiring):** localized privacy prompts. Added `canari_iOS/{fr,en}.lproj/InfoPlist.strings` (the 4 `NS*UsageDescription` keys) + `CFBundleLocalizations` [fr,en] in Info.plist; base Info.plist values stay French as the fallback. Like the NSE, the `.lproj` folders must be added to the `canari_iOS` target as localized resources in the hand-maintained pbxproj on a Mac (noted in `gen/apple/README.md`). [device] confirm EN prompts on an English-locale iPhone.
* **LONG-TERM (deferred, both platforms):** full automated store deployment - iOS auto-upload to TestFlight/App Store (App Store Connect API key `.p8` + `xcrun altool`/`notarytool`) AND Android auto-publish to Play Store (the commented-out `r0adkll/upload-google-play` block in `android-release.yml`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` already a secret). Same effort would also auto-REGENERATE the yearly-expiring Apple certs+profiles (both expire 2027-07-11) via fastlane `match`/`sigh` driven by that same App Store Connect API key, killing the manual `gh secret set` renewal chore. Not now - explicitly deferred by user 2026-07-21.
* \[~\] **WP-iOS-11 (CD):** `ios-release.yml` now MIRRORS `android-release.yml` (trigger = `workflow_run` after *Bump version on release* + `workflow_dispatch`; no `force` gate; attaches the signed `.ipa` to the GitHub Release `vX.Y.Z`). NO TestFlight (user dropped it - ship the `.ipa` as a release asset like the Android `.aab`/`.apk`). Léon's commit `6cf14988` did the NSE Mac wiring (target `CanariNotifications`/`fr.emse.canari.notifications` added to pbxproj, embedded, manual signing) + posted all `APPLE_*`+`GOOGLE_SERVICE_INFO_PLIST` secrets (team = "Les Rootz" `4CLNB8SR6L`). BLOCKER before activation: the CI now needs a SECOND profile secret `APPLE_PROVISIONING_PROFILE_NSE` (manual signing references two NAMED profiles: `Canari` for the app + `CanariNotifications` for the NSE - names must match the pbxproj `PROVISIONING_PROFILE_SPECIFIER` exactly). Léon must (portal): create App ID `fr.emse.canari.notifications` + App Group `group.fr.emse.canari` on both App IDs, generate the two distribution profiles named exactly `Canari`/`CanariNotifications`, and `gh secret set APPLE_PROVISIONING_PROFILE_NSE`. FIRST CI run (29852146029) got EVERYTHING config-side green (secret validation, cert import, BOTH profiles installed by name, .env) and failed only in `xcodebuild` with `Multiple commands produce .../CanariNotifications.appex/Info.plist` - the NSE `Info.plist` was BOTH `INFOPLIST_FILE` and in the target's Copy Bundle Resources phase. FIXED in pbxproj (removed the `Info.plist in Resources` PBXBuildFile + its use in the NSE `PBXResourcesBuildPhase`). Re-triggered after the fix. NOTE: WP-iOS-10 lproj strings are NOT yet referenced in the pbxproj (Léon didn't add the localized variant group) - permission prompts stay FR-only until wired. Guide: `docs/wiki/infrastructure/ios-ci-cd-setup.md`.

CROSS-PLATFORM ENHANCEMENTS (WP-XP-*, bilateral - land on BOTH Android + iOS to make the gap table not just paritaire but complete; these are nice-to-haves neither platform has today, each done once per OS with the same UX):
* \[ \] **WP-XP-1 Notification quick actions:** inline "Repondre" + "Marquer comme lu" straight from the notification (Android `RemoteInput`/`Notification.Action`, iOS `UNNotificationAction`/`UNTextInputNotificationAction`). Reply routes through the existing background outbox drain; mark-read reuses the read-state sync path.
* \[ \] **WP-XP-2 App-icon unread badge:** keep the launcher/home-screen badge in sync with real unread count (Android notification count/`ShortcutBadger`, iOS `setBadgeCount`). Update on push receipt + on read-state cancel.
* \[ \] **WP-XP-3 Rich media notifications:** show a thumbnail for image/video/GIF messages (Android `BigPictureStyle`, iOS `UNNotificationAttachment`). iOS depends on WP-iOS-6 (NSE) to decrypt the media first.
* \[ \] **WP-XP-4 Boot/relaunch re-registration:** re-register the push token + warm MLS at device boot so a token that rotated while the phone was off doesn't stay dead until manual open (Android `BOOT_COMPLETED` receiver - none today; iOS: force a token re-read at first launch, ties into WP-iOS-8). Table's "Boot persistence = neither" row.
* \[ \] **WP-XP-5 Priority notifications for calls & @mentions:** break through Focus/DND for the things that matter (iOS `interruptionLevel=timeSensitive` + entitlement, calls as full-screen `CallKit`-style; Android high-importance channel + full-screen intent). Leverages the per-OS importance model the table notes iOS "has no concept" of - so add an equivalent tiering.
* \[ \] **WP-XP-6 Keyboard GIF/sticker parity:** Android has `KeyboardMediaBridge.kt`; add the iOS side (pasteboard-image / `UIPasteboard` insert path, since iOS keyboards deliver media differently) so GIF/sticker insertion works from the keyboard on both. Closes the table's last "Missing (likely N/A)" row with an actual iOS answer.
* \[ \] **WP-XP-7 Unified rich notif grouping:** one conceptual notification model shared across OSes - per-conversation stacking + a group summary + avatar/initials fallback (Android `MessagingStyle` already; bring iOS up via the NSE, WP-iOS-6/7). Makes the "Notification display" row fully paritaire.
* \[ \] **WP-XP-8 Shared deferred-retry engine:** one abstraction for background send/decrypt retries behind Android `WorkManager` + iOS `BGTaskScheduler` (WP-iOS-4), with the same "ouvre l'app" nudge UX, so both platforms recover from throttled/failed background work identically. Closes the "Foreground/background service" row.

#### MULTI-TIER COTISATIONS ROADMAP (Cercle + generalization) - designed 2026-07-21

CONTEXT: some assos have >1 cotisant type (Le Cercle: forfait alcool XOR sans-alcool, upgrade = pay the delta). Generalize the cotisation model from "one asso = one implicit cotisant tag" to "N named tiers + gating on ANY tag". KEY FACTS (verified this session): the cotisant status is already a `user_tags` row (`cotisant:<slug>` / `cotisant:<slug>-<year>`), built ONLY by `deriveCotisationTag(slug, mode)`; `userId` Canari IS the Authentik/MiConnect `sub` (`findOrCreateFromOidc` uses `userinfo.sub` as the PK - [auth.controller.ts:180](apps/core-service/src/auth/auth.controller.ts#L180), [users.service.ts:107-115](apps/core-service/src/users/users.service.ts#L107-L115)), so the inbound Cercle API needs NO id-mapping table. The Canari->Cercle top-up webhook is ALREADY built: `dispatchCercleWebhook` (HMAC-SHA256, 3 retries, failed-list + manual retry) fires on `balance_topup` fulfillment. Cercle is source of truth for the balance; Canari is source of truth for cotisant status (Cercle always queries live, no cache). GENERALIZATION PRINCIPLE: stop hardcoding "the asso's single tag" - the `membership` products ARE the tier registry (each carries `variantKey`); gating/pricing reference a named tag, not the implicit own-asso tag (extends forms' existing `pricingTagName` to products).

* \[ \] **WP-COT-1 (data model + tag derivation, migration 017):** add `association_products.variantKey VARCHAR NULL` (NULL = single-tier asso, behaviour STRICTLY unchanged) and `variantLevel INT NULL` (ordinal for optional inclusion, WP-COT-8). Extend `deriveCotisationTag(slug, mode, variant?)` to append `-${variant}` when set (no variant => current strings, full back-compat). Lift the "one membership product per asso" assumption. Tests: tag derivation with/without variant.
* \[ \] **WP-COT-2 (purchase logic: XOR switch + pay-the-difference):** add `association_products.memberPriceTag VARCHAR NULL` - when set, the reduced price (`amountCentsMember`) applies iff the buyer holds THAT specific tag (else fall back to the generic `isBuyerCotisant`); this is the "pay the delta" lever (avec-alcool product: `memberPriceTag = cotisant:cercle-sans-alcool`, `amountCentsMember = delta`). `assertCanPurchase`: block re-buying the tier already held, ALLOW the sibling tier (switch/upgrade). `resolveGrantTag`: pass `product.variantKey` into `deriveCotisationTag`. Fulfillment: grant the tier tag AND revoke the sibling-tier tag(s) of the same asso (XOR) in one transaction (sibling set = the asso's other `membership` products' variantKeys). Tests: tier pricing, XOR grant, switch allowed / same-tier rebuy blocked.
* \[ \] **WP-COT-3 (generalized gating):** generalize product gating beyond the boolean `membersOnly` (= "any tier of this asso"): add `requiredTags TEXT[] NULL` (holds ANY listed tag). Back-compat: `membersOnly=true` maps to "any active tier tag of the owning asso". `/products/all` `viewerIsCotisant` also returns the viewer's active tier. Keep `isBuyerCotisant` generic for `membersOnly` so the Cercle `balance_topup` recharge stays open to BOTH forfaits. Tests.
* \[ \] **WP-COT-4 (inbound API Cercle->Canari):** new `GET /api/public/cotisant-status?assoSlug=&sub=` with SERVICE-TO-SERVICE auth (dedicated API key / HMAC header, NOT the nginx user-auth guard). Returns `{ isCotisant, tier, expiresAt }`; `sub` == Canari userId so no mapping. Rate-limit + tests + wiki. This is the ONLY new endpoint - outbound already exists.
* \[ \] **WP-COT-5 (outbound wiring - config/verify, mostly no code):** configure `webhookUrl`/`webhookSecret` on the Cercle `balance_topup` product; verify `dispatchCercleWebhook` payload carries `sub` + `amountCents` + `paymentId` (idempotency key). Document BOTH directions' contract (payload shape, signature header, retry semantics) in the wiki.
* \[ \] **WP-COT-6 (frontend - Cotisations admin tab, multi-tier):** `EditCotisationsTab.svelte` lets an asso define >=1 tier (label/price/variantKey), and on the upgrade tier set `memberPriceTag` = lower tier's tag + delta price. Roster + `.xlsx` export gain a "Forfait/Tier" column. i18n FR/EN.
* \[ \] **WP-COT-7 (frontend - shop + forms):** `/shop` shows the tiers; the higher-tier card shows the delta price when the viewer already holds the lower tier (mirror of `memberPriceTag`). Forms' `pricingTagName` already accepts an arbitrary tag - verify it works with tier tags. i18n FR/EN.
* \[ \] **WP-COT-8 (P3, optional inclusion + docs):** honour `variantLevel` so a gate "requires tier >= N" is satisfied by any higher tier (NOT needed for the Cercle - recharge is generic, upgrade is explicit `memberPriceTag` - so ship only if a real need appears). Update [docs/wiki/cotisations.md](docs/wiki/cotisations.md) (tiers + both API directions) and the end-user guide.

#### OPEN BACKLOG (reported 2026-07-20, triaged by severity x speed)

**P1 - broken functionality:**
* \[x\] **Channel unusable until relaunch after in-session join (code fix, awaits device verify):** ROOT CAUSE = the real-time `channel.member.joined` handler (`ChatBackgroundService.svelte`) registered the channel in `conversations` but never hydrated its epoch key (the join event carries no key material - it's broadcast), so every open/decrypt failed until relaunch ran the full `loadChannelWorkspacesFromBackend` hydration. FIX = new `hydrateJoinedChannelKey(channelId)` on `useChannelWorkspaces` (fetches the bootstrap via `hydrateChannelBootstrap` -> ChannelKeyVault), fired from the join handler. [device] confirm a freshly-added channel opens + decrypts without restart.
* \[x\] **System-message notifs (`Message de XXX`) - ALREADY FIXED (0a985983 "fix notifications"), verified this session.** The native background path is complete: Rust `format_system_event_text` (proto_fields.rs) maps every VISIBLE event the frontend emits (groupRenamed/groupImageChanged/memberAdded/memberRemoved/memberLeft/groupDeleted) to French text; every CONTROL event (read_receipt/delete_message/edit_message/remove_reaction/pin/unpin/history_bundle/channel_key_distribution) returns None. Contract holds because control events are sent `silent=true` (outbox flusher, `outbox.test.ts:228`) so they never notify, and visible events are sent non-silent -> decode -> Kotlin renders the text (fallback "Nouveau message de X" only on true decrypt failure). No event hits the ugly `_ =>` catch-all.
**P2 - UI correctness / polish:**
* \[ \] **Remove per-salon/channel avatars entirely** (no placeholder either - show just the channel name). Community-level avatar editing was checked and already works fine (`SidebarCommunityAdminModal`, permission-gated) - that half of the old bullet is done. Channel avatars are still fully implemented (image/placeholder via `GroupAvatar`, editable in `ChannelSettingsModal.svelte:442-465`) and need to be stripped out.
* \[ \] **"Show members" toggle does nothing on desktop** in the channel header. Root cause found: `MainChatPage.svelte` gates the mobile drawer (`xl:hidden`) on `isChannelMembersDrawerOpen`, but the persistent desktop sidebar (`ChannelMembersSidebar.svelte:66-68`, `xl:flex`) renders unconditionally from a CSS breakpoint alone - so on `xl`+ viewports the toggle button is shown but wired to a state nothing visible consumes. Needs a product decision: hide the toggle button on desktop widths, or make the desktop sidebar collapsible via the same state.
* \[ \] **Push notification bodies are hardcoded English server-side** (`messaging.controller.ts`: `'New reaction'` / `reacted with ... to ...`), with no per-user locale on the push path - discuss whether to thread the recipient's locale into `sendPushToUser` and localize via Paraglide server-side, or accept English-only pushes as a product decision.

**P3 - feature:**
* \[ \] **Reorder communities** via drag-and-drop (user-defined display order, persisted).

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
* Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant` (no client-side tag derivation). The old client mirror deriveCotisationTagName was removed in 4e205ef.
* Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
* Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
* Commit signing is ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`, `commit.gpgsign`/`tag.gpgsign true`, `allowed_signers` for local verify. Pubkey registered as a GitHub **signing key** on account DeMASKe (email `jolan.boudin.jourdan@gmail.com` verified+primary). All new commits on all 4 repos are Verified - do NOT disable signing or bypass it. Registering keys/setting repo secrets uses `gh` (token now has `admin:ssh_signing_key`, `user:email`, `repo`); interactive `gh auth refresh` must be run by the user in their own PowerShell (headless shell has no TTY).
