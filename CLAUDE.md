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

Dependabot auto-merge live on all 4 repos ([[reference_dependabot_automerge]]): green PRs self-merge, no involvement. Each repo = its own commits on main; full local CI gate before push. Node -> 24 and CodeQL cleanup DONE everywhere.

**Open items:**
* **Canari TS 6->7 majors (#168/#163/#162): DEFERRED until TS 7.1.** Breaking compiler jump fails `Test TS Backend`; ecosystem not ready. Hold the PRs (do not merge); TS stays `~6.0.3`. Revisit when 7.1 ships.
* **Watch (majors that may fail CI):** prettier-plugin-svelte 3->4 (Canari #143, MiGallery #260), lint-staged 16->17 (MiGallery #261), jsdom 28->29 (Sky #55), grouped bundles (MiGallery #265/#266, Sky #61).

---

### CANARI

All shipped work below is verified (on-device checks done per user). Only durable, forward-relevant gotchas kept; full implementation lives in git.

* **Security invariants (audit 2026-07, tracker `docs/wiki/security-audit-2026-07.md`):** nginx `auth_request` never blocks -> every client-exposed route needs its OWN guard/ownership check; `dm_group_members` is trusted by every MLS gate (never client-writable); public nginx locations must strip the FULL trust-header set `X-User-Id`/`X-User-Logged-In`/`X-Global-Admin`/`X-Internal-Token` PER-location (server-level resets are NOT inherited once a location sets any `proxy_set_header`). Reusable authz helpers: `assertCallerOwnsUserId`/`assertCallerMayMutateMembership`/`assertCallerIsGroupMember` (chat-delivery), `assertInternalSecret` (social + media). Accepted non-fixes: S9 (`canari_ws_token` JS-readable, needed for WS), S10 (`documentVaultKey` server-side plaintext, HKDF-sound).

* **MLS group recovery (a2d62a85, 7dd116c3):** `runUnderMlsLock` is NON-reentrant - any recovery seam (externalJoin/republishKeyMaterial re-acquires the lock) MUST run OUTSIDE it (hoist via a returned `DeferredRecovery`). Welcome-failure recovery is externalJoin-first (self-rejoin via GroupInfo), welcome_request fallback, driven immediately on failure #1. Group name+photo re-seed from `getUserGroups` on every discovery (`actions.ts::discoverMissingGroups`) - durable fallback for missed one-shot `groupRenamed`/`groupImageChanged` broadcasts. History-bundle readBy/readAt/reactions merged onto existing msgs via a dedicated merge pass (not the add-path). Prod DB: `ssh canari` -> `docker exec infrastructure-postgres-1 psql -U canari -d auth_db` (single db; tables `dm_groups`/`dm_group_members`/`dm_device_group_memberships`/`mls_group_info`); `ssh` works from the PowerShell tool ONLY.

* \[ \] **iOS native channel push (OPEN - needs Mac/CI, Léon owns).** FFI bridge mirrors the Android JNI surface incl. channel background decrypt (`canari_native_decrypt_channel_message`, `canari_push.mm` routes `type=channel`/`channel_read`). CANNOT compile on the Windows host (`cfg(target_os=ios/android)`); needs a Mac/CI build + on-device channel push test. iOS release workflow stays disabled until finalized.

* **Carte de la Vie Asso (design doc `docs/wiki/carte-vie-asso.md`):** editable poster generator; access `GlobalAdminOrBdeSuperAdminGuard`; project = opaque persisted JSON `layout` blob (content re-resolved from live data at render). GOTCHAS: prod applies `.sql` migrations manually; `{@const}` must be an immediate child of a block; PDF export is the shared searchable-raster path (`lib/pdf/searchableRaster.ts` + `appFonts.ts`: static TTF Nunito/Fredoka - jsPDF can't use woff2 *variable* families).

* **Document reviewer sharing (1f80e469):** reviewer/grant controller routes MUST be declared BEFORE `:id` routes (else `reviewer/documents` is shadowed by `:id/documents`). PUBLIC docs only: server derives per-doc CEK via `hkdfSync(vaultKey, salt=cekSalt, info="doc-vault")` - raw vault key never exposed; password-protected docs can't be public. Migrations `019`/`020`.

* **Verification service account:** hidden from non-admins via `SERVICE_ACCOUNT_USER_ID` env (wired into core-service + social-service in all 3 compose files + `cd.yml`/`cd-dev.yml` upserts; default in `infrastructure/.env.example`). Admin gate = `user.admin` (global). Empty env = no-op.

* **Cotisation tag:** all render sites go through shared `formatCotisationTag()` (`lib/associations/cotisationTag.ts`) + `CotisationTagRow.svelte` - keep new ones consistent.

* **Minesweeper leaderboard:** keep `apps/social-service/src/minesweeper/engine/game.ts` synced 1:1 with `frontend/src/lib/minesweeper/game.ts` (dual engine). Access = easter egg: `/settings`, tap the device-id footer 5x.

* **Agenda PDF export (`calendarExport.ts`):** searchable-raster PDF (shared with carte); themes in `calendarThemes.ts`. Weekday + month names are Intl-driven from the runtime locale (i18n, no hardcoded FR); event fill is translucent (`EVENT_BG_OPACITY`); co-owned events use `splitLogoWatermark` (one circle split into per-owner vertical bands); `HEADER_H` sized so the Fredoka month title clears the top edge. Breaks = `kind:'break'` full-day band. Pure helpers unit-tested in `calendarExport.test.ts`.

Normalization-sweep gotcha: accent-grep MISSES French comments written without accents ("Section Membres", "chiffre a une epoch perimee") - use both accent-grep AND French-token grep.

---

### SKY (../Sky) - COMPLETE (HEAD 174a8bd)

Nothing open. Conventions in memory: [[project_sky_conventions]], accents [[feedback_sky_french_accents]] (vitest include = `src/**` only -> co-locate tests in src/). Future nice-to-have: promo color legend.

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
