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
- Husky: Pre-commit runs ESLint \+ Prettier \+ svelte-check. Fix errors; do not bypass.

## **KEY COMMANDS**

* Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); the Makefile shells out to npm on the same package.json - both work. Prefer bun locally.  
* Setup/Dev: make install, make run-services, cd frontend && bun run dev  
* Tests: make test (All), make test-frontend, cargo test  
* Frontend gates (before every commit): bun run check (svelte-check, MUST be 0 errors), bun run lint (eslint), bun run format (prettier --write .). cargo clippy for Rust. The pre-commit hook runs prettier+eslint+check across the WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

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
* **Node -> 24: MiGallery pending** (`release.yml` matrix->`[24]`, `engines>=24`, Docker `node:22`->`24`). Canari/Sky done.
* Wiki + English-comment audit per repo, folded into touched files. Sky (3) + Portail (1) low-sev CodeQL alerts last.

---

### CANARI - no open code tasks

All roadmap items resolved. Only residuals are non-code:
* **D. MLS + Communautes audit - CODE FULLY RESOLVED.** Every finding fixed; July re-architecture deleted the reboot/CAS/successor machinery. Residual = on-device verification of mobile native paths (Android/iOS, not compiler-verifiable here) - a device task.
* TS 6->7 deferred until 7.1 (see cross-project).

Gotcha for future normalization sweeps: accent-grep MISSES French comments written without accents ("Section Membres", "chiffre a une epoch perimee") - use both accent-grep AND French-token grep.

---

### SKY (../Sky) - COMPLETE (all roadmap items DONE + PUSHED, HEAD 174a8bd)

Nothing open. Conventions/gotchas in memory: [[project_sky_conventions]], accents [[feedback_sky_french_accents]] (vitest include = `src/**` only -> co-locate tests in src/). Possible future nice-to-have: promo color legend (was out of scope).

---

### MIGALLERY (../MiGallery)

* \[ \] Normalization: wiki + Paraglide infra done+pushed; remaining = UI string migration + English comments + tolerant search ([[project_migallery_normalization]]).
* \[ \] Cleanup (see cross-project): 2 high + 4 medium CodeQL alerts (file-system-race is the real one), Node bump, wiki/comment audit.

---

### PORTAIL-ETU (../refonte-portail-etu) - Vitrine SPA

Vitrine SPA (SvelteKit 5 + Tailwind 3.4 + svelte-adapter-bun, `ssr = false` because deploy host can't reach canari-emse.fr / hairpin NAT). Reads Canari public API `/api/public/*` from the browser. Redesign v2, avatar proxy, CI integrity, Tailwind cleanup, license, docs = DONE ([[project_portail_vitrine_migration]]).

**Open work:**
* \[x\] **N3 i18n Paraglide DONE** (pushed f4797f2): all UI strings swapped to `m.*` across home/associations/lists/liens pages, AssociationCard/EntityDetail/MemberCard/FeaturedLinks/ThemeToggle, [handle] detail pages, Header nav aria. Added `nav_primary_aria`; FeaturedLinks taglines resolve via link `id`->message map (links.ts dropped hardcoded tagline). check/lint/build all green.
* \[ \] **N8** Markdown not rendered in association descriptions (portail-etu.emse.fr/associations/[id]) - investigate. Lead: EntityDetail renders `{@html sanitizeDescription(entity.description)}` (src/lib/html.ts) - upstream data is likely raw markdown never converted to HTML; check sanitizeDescription + whether Canari public API returns MD or HTML.
* \[ \] **N6** English-only comments: ThemeToggle done; sweep remaining FR comments, fold in as files are touched.
* \[ \] **N7 CD via GitHub Secrets** (the big "a la fin"): inject ALL secrets via GitHub Secrets, rotate keys, DROP server .env dependency (user has no server .env access). Clean deploy.yml leftovers (sharp install / rollup external in vite.config.ts). Replicable on a fresh machine.
* \[ \] Cleanup (see cross-project): 1 quality CodeQL alert, Node bump.

---

### SHARED GOTCHAS (do not repeat)

* Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash takes it literally and prefixes the subject with `@`).
* Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.
* Before push (Canari): `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.
* Cotisant status is server-authoritative: `/products/all` returns per-product `viewerIsCotisant` (no client-side tag derivation). The old client mirror deriveCotisationTagName was removed in 4e205ef.
* Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
* Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
