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

**Shipped (needs on-device verify only, no code left):**
* \[x\] Visible action errors channel/community (d2688ff7). Kick no longer silently purges (91fa0d92: `forgetGroup` + banner instead of silent `deleteConversation`).
* \[x\] Viewport pinch-zoom/pan mis-detected as keyboard (37744cb). Verified on-device.
* \[x\] New-device / pre-join history bundle durable cross-session retry (24b6480c): `awaitingHistoryRegistry.ts` (localStorage, 30d) + `reSolicitAwaitingHistory` on each reconnect + 2.5s initial defer (fixes epoch race). **Verify: real 2nd device, peer offline at join, reconnect -> bundle arrives.** Deferred findings: (C) DONE (0de94457): `Sender data decryption error` refetch storm fixed via a bounded per-ciphertext retry ledger (`history_retry_cipher:*`, cap `MAX_HISTORY_DECRYPT_RETRIES=6`) in `history.ts` - epoch-gap/wrong-epoch frames stay retryable below the cap (no msg loss), then are marked seen + cursor-advanced (storm stops); epoch-gap still escalates via `shouldFlagStaleEpochGap`. Pure `nextHistoryRetryDecision` unit-tested. (D) VERIFIED - NOT a separate gap. `discoverMissingGroups` (actions.ts) is a pure UI/state reconciler (placeholder creation + orphan cleanup + avatar seeding); it performs NO re-add. The single `requestReAdd` seam is driven by exactly two complementary sources that fully subsume it: (1) connect-sync `syncConnectionAfterWsOpen` fires it for WASM-missing groups straight from the server `getUserGroups` list on every reconnect (independent of discovery/the conversations map); (2) SYNC_WATCHDOG (5s) fires it for every candidate in `cb.conversations` UNION the not-ready registry that lacks WASM state - and discovery writes its placeholders INTO the SAME `cb.conversations` instance, so every discovered group is a watchdog candidate next poll. No double-drive (discovery never re-adds), no coverage gap. Residual = the already-documented inherent liveness limit (lost Welcome + permanently-silent group + no reconnect), orthogonal to discovery. Incidental cleanup shipped: removed the dead `runGroupDiscovery` composable callback (zero consumers; all real calls go through `runGroupDiscoveryImpl`).

* \[x\] **Server-authoritative admin-button gating.** DONE. `listWorkspacesForUser` ([channel.service.ts:383](apps/social-service/src/channels/channel.service.ts#L383)) now returns `viewerCanManage` per workspace (batch-loads roles, checks `MANAGE_WORKSPACE`, fail-closed). Threaded `viewerCanManage` through `WorkspaceDto` -> `upsertWorkspaceFromDto` -> `ChannelSidebarWorkspace` -> Sidebar `ChannelWorkspace` -> `SidebarCommunityAdminModal` (`canManage` derived from `selectedWorkspace.viewerCanManage`). Modal hides change-image upload + member-invite button/inputs and makes the name input readonly when `!canManage`; Members list + Leave stay visible to all. Event-created placeholder workspaces default `viewerCanManage:false` until the next full sync (safe). 3 backend tests (`listWorkspacesForUser` flag/no-roles/no-memberships). Wiki (api-surface + social-service) updated. Gates: backend spec 26/26, `bun run check` 0 errors, oxlint clean, oxfmt done. **On-device verify: non-admin member sees no change-image/invite controls; admin does.**

Residual otherwise = on-device MLS mobile native verification only.

* \[~\] **Minesweeper ranked leaderboard (uncommitted):** on **social-service** (`/api/minesweeper`), seeded challenges + move-replay anti-cheat. Keep `apps/social-service/src/minesweeper/engine/game.ts` synced with `frontend/src/lib/minesweeper/game.ts`. Migration `apps/social-service/src/migrations/018_minesweeper_leaderboard.sql`. Score = server wall-clock only.

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
* Backend app lint scripts call bare `oxlint`/`oxfmt` (resolved from that app's local `node_modules/.bin`, NOT global). If the pre-commit hook fails with `'oxlint' n'est pas reconnu` on an `apps/*` step, the app's install is stale - run `npm install` in that app dir (e.g. `apps/social-service`) to restore the binaries. Backend hook step runs `lint:fix` only (warnings OK); repo-wide `format:check` has pre-existing unformatted files and is not hook-enforced.
* Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.
* Before push (Canari): `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.
* Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant` (no client-side tag derivation). The old client mirror deriveCotisationTagName was removed in 4e205ef.
* Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
* Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
* Commit signing is ON globally (SSH): `gpg.format ssh`, `user.signingkey ~/.ssh/id_ed25519.pub`, `commit.gpgsign`/`tag.gpgsign true`, `allowed_signers` for local verify. Pubkey registered as a GitHub **signing key** on account DeMASKe (email `jolan.boudin.jourdan@gmail.com` verified+primary). All new commits on all 4 repos are Verified - do NOT disable signing or bypass it. Registering keys/setting repo secrets uses `gh` (token now has `admin:ssh_signing_key`, `user:email`, `repo`); interactive `gh auth refresh` must be run by the user in their own PowerShell (headless shell has no TTY).
