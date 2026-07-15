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

### CROSS-PROJECT: Quality & Security cleanup (started 2026-07-14)

Dependabot auto-merge live on all 4 repos ([[reference_dependabot_automerge]]): green PRs self-merge, no involvement. Each repo = its own commits on main; full local CI gate before push.

**Open items:**
* **Canari TS 6->7 majors (#168/#163/#162): DEFERRED until TS 7.1.** Breaking compiler jump fails `Test TS Backend`; ecosystem not ready. Hold the PRs (do not merge); TS stays `~6.0.3`. Revisit when 7.1 ships.
* **Watch (majors that may fail CI):** prettier-plugin-svelte 3->4 (Canari #143, MiGallery #260), lint-staged 16->17 (MiGallery #261), jsdom 28->29 (Sky #55), grouped bundles (MiGallery #265/#266, Sky #61).
* **Node -> 24: DONE across all** (MiGallery shipped 2026-07-15, commit dd80739: ci/code-analysis/release workflows + Dockerfile both stages + `engines>=24`; Canari/Sky already done). Portail = pure Bun, N/A.
* **CodeQL: DONE.** Verified via `gh api` 2026-07-15: MiGallery 4 alerts dismissed (all FP/stale: atomic-rename file-system-race + safeLog log-injection + a stale unused-import) -> 0 open; Sky 0 open (roadmap's "3" was stale); Portail has NO code scanning configured (the "1 quality" was stale). Nothing left to close.

---

### CANARI - open

* \[x\] **Visible action errors (channel/community).** DONE, committed d2688ff7.
* \[x\] **Kick no longer silently purges a conversation.** DONE. `handleSystemEvent` `memberRemoved` self-branch ([systemMessageHandler.ts:154](frontend/src/lib/mls-client/messagePipeline/systemMessageHandler.ts#L154)) used to `deleteConversation`+drop the map entry silently (the ONLY silent all-device disappearance that fits "no manual action") - now mirrors the peer-`groupDeleted` branch: `forgetGroup` + system banner `m.chat_system_removed_from_group()` + `lifecycle:'removed'` + save; kept until manual delete (which dismisses on all devices). New test `systemMessageHandler.exclusion.test.ts` (mocks `resolveDisplayNames`). Gates green (check 0, oxlint, oxfmt). Context: investigated a reported "DM vanished on all devices, no action" - for a **DM 1:1** NO clean silent-purge path exists under normal ops (peer-delete = tombstone -> banner; `absent` purge needs the row fully gone = 90d cron/DB reset), so likely was a test/no real bug; this fix hardens the one path (kick) that could, mostly relevant to **groups**.
* \[x\] **Viewport: pinch-zoom / pan mis-detected as keyboard.** DONE, committed 37744cb. Root cause: `--app-viewport-height` (drives the root shell height, [+layout.svelte:297](frontend/src/routes/+layout.svelte#L297)) was rewritten to `visualViewport.height` on EVERY resize/scroll unconditionally - but a shrinking visual viewport also happens on pinch-zoom + page-pan, not just keyboard -> shell collapsed (white gaps) AND the `delta > threshold` heuristic mis-fired -> `keyboard-open` posed -> Navbar/BottomNav unmounted (reframing). Missing signal was `visualViewport.scale`. Fixes in [keyboardViewport.svelte.ts](frontend/src/lib/stores/keyboardViewport.svelte.ts): (1) extracted pure `computeSnapshot` that bails `zoomed:true`/closed/baseline-height when `scale>1.01`; (2) `applyCssVars` only pins the px height while keyboard actually open, else `removeProperty` -> stable `100dvh`; (3) `scroll` (pan) handler `updateOffsetOnly` refreshes only `--visual-viewport-offset-top`, no height/keyboard re-eval/scrollIntoView. 5 unit tests (rest/adjustResize/adjustPan/zoom-guard). Gates green. **Needs on-device verify: iPhone Safari keyboard + desktop trackpad pinch.**
* \[ \] **FOLLOW-UP: server-authoritative button gating.** User wants the "change image" (and other admin) controls hidden when the viewer lacks `MANAGE_WORKSPACE`. Client currently has NO viewer-permission data (`ChannelSidebarWorkspace` has none; roles!=permissions client-side; cotisant-style rule = no client derivation). Needs backend to expose `viewerCanManage`/effective perms on the workspace listing, then thread DTO->composable type->`SidebarCommunityAdminModal` prop->conditional render. Larger WP; not started.
* \[~\] **New-device login / pre-join history bundle - FIX committed 24b6480c, needs on-device verify.** Root cause (found this session): history solicitation was a **one-shot ~3 min window tied to the join event** (only callers: [recovery.ts](frontend/src/lib/utils/chat/recovery.ts) external-join success + [sessionAuth.ts](frontend/src/lib/composables/session/sessionAuth.ts) `onWelcomeProcessed`). Later sessions find the group already in WASM -> recovery short-circuits -> `solicitHistory` never fires again. So for a 1:1 DM whose sole peer was offline in that window, the bundle was **never re-requested**. Plus an epoch race: attempt 0 fired at T+0, before the peer applied our external commit, so the peer re-encrypted the bundle at its old epoch = undecryptable + wasted. **Fix (frontend-only):** new durable `awaitingHistoryRegistry.ts` (localStorage, per-user, 30d horizon) set by `solicitHistory`/cleared by `noteHistoryBundleReceived`; new `reSolicitAwaitingHistory` called from `syncConnectionAfterWsOpen` re-solicits every awaiting local group on each (re)connect; attempt 0 deferred `INITIAL_SOLICIT_DELAY_MS`=2500ms. Threaded `userId` through `solicitHistory`/`noteHistoryBundleReceived`. Tests updated + new (`awaitingHistoryRegistry.test.ts`, `reSolicitAwaitingHistory` cases). Wiki updated. Gates: `bun run check` 0 errors, oxlint clean, oxfmt done; historySolicit/awaitingHistory/recovery/pipeline/initializeConnection suites green. **RESUME: commit, then verify on a real 2nd device (peer offline at join, reconnect -> bundle arrives).** Findings NOT actioned (user chose registre+watchdog scope only): **(C)** the `Sender data decryption error` storm - a fresh external-joiner refetches the entire pre-join `history:{groupId}` stream (epochs it can never decrypt) on EVERY sync because `wrong-epoch` frames aren't marked "seen" ([history.ts:351-359](frontend/src/lib/utils/chat/history.ts#L351)); benign but wasteful, deferred. **(D)** discovery `d82cd226` placeholder = same `getUserGroups` as connect-sync (which DOES `requestReAdd`), so likely covered; logs were partial - verify not a separate gap.

All prior roadmap items resolved. Residual = on-device verification of MLS mobile native paths (Android/iOS, not compiler-verifiable here). TS 6->7 deferred until 7.1 (see cross-project).

Normalization-sweep gotcha: accent-grep MISSES French comments written without accents ("Section Membres", "chiffre a une epoch perimee") - use both accent-grep AND French-token grep.

---

### SKY (../Sky) - COMPLETE (HEAD 174a8bd)

Nothing open. Conventions in memory: [[project_sky_conventions]], accents [[feedback_sky_french_accents]] (vitest include = `src/**` only -> co-locate tests in src/). Future nice-to-have: promo color legend.

---

### MIGALLERY (../MiGallery) - essentially COMPLETE (HEAD 882d6d1)

* \[x\] Normalization: wiki + Paraglide i18n + tolerant search done; ALL user-facing FR strings migrated (last residuals shipped 882d6d1; accented-French sweep of src = 0 string literals) ([[project_migallery_normalization]]).
* \[x\] Cleanup: CodeQL (0 open) + Node 24 done (see cross-project).
* Residual (minor, opportunistic): stray French code comments in src (hooks, permissions.ts JSDoc, immich proxy) - fold into touched files, no dedicated pass.

---

### PORTAIL-ETU (../refonte-portail-etu) - Vitrine SPA - COMPLETE

Vitrine SPA (SvelteKit 5 + Tailwind 3.4 + svelte-adapter-bun, `ssr = false`: deploy host can't reach canari-emse.fr / hairpin NAT). Reads Canari public API `/api/public/*` from the browser. Redesign v2, avatar proxy, i18n, MD bios, CI integrity, N7 CD-via-Secrets (verified live 2026-07-15) all DONE ([[project_portail_vitrine_migration]]).

* \[x\] Cleanup: no code scanning configured (no CodeQL alert to close); Node bump N/A (pure Bun). Nothing open.

---

### SHARED GOTCHAS (do not repeat)

* Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash takes it literally and prefixes the subject with `@`).
* Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.
* Before push (Canari): `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.
* Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant` (no client-side tag derivation). The old client mirror deriveCotisationTagName was removed in 4e205ef.
* Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
* Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
* Commit signing is ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`, `commit.gpgsign`/`tag.gpgsign true`, `allowed_signers` for local verify. Pubkey registered as a GitHub **signing key** on account DeMASKe (email `jolan.boudin.jourdan@gmail.com` verified+primary). All new commits on all 4 repos are Verified - do NOT disable signing or bypass it. Registering keys/setting repo secrets uses `gh` (token now has `admin:ssh_signing_key`, `user:email`, `repo`); interactive `gh auth refresh` must be run by the user in their own PowerShell (headless shell has no TTY).
