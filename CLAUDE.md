# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES (CRITICAL)**

* NO BLIND GREP: Never run generic grep or find across the monorepo. Check SESSION STATE or ask for paths.  
* THINK BEFORE CODING: State assumptions. Ask questions during planning. If multiple interpretations exist, surface them.  
* SIMPLICITY FIRST: Write minimum viable code. No speculative features. No abstractions for single-use code.  
* SURGICAL EDITS: Touch ONLY requested code. Do not refactor adjacent unbroken code. Remove unused imports/vars caused by your changes.  
* GOAL-DRIVEN: Define success criteria. Write/update tests to reproduce bugs or validate inputs, then make them pass.  
* MODEL DELEGATION: Opus \= reasoning/architecture. Haiku/Sonnet \= crawling, massive edits.  
* WIKI & CLEANLINESS: Documentation goes EXCLUSIVELY in docs/wiki/. Delete unused/legacy code immediately.  
* PROD ACCESS: You can connect to production via SSH using ssh canari (or ssh mitv for Canari-related systems).  
* SAVE TOKENS: After completing a Work Package, output exactly: "Task done. Please git add to clear diff context, then run /compact."  
* UPDATE STATE: You MUST update the SESSION STATE at the bottom of this file before finishing a Work Package.

## **ARCHITECTURE & CONSTRAINTS**

* Stack: SvelteKit 5 \+ Tailwind 4 \+ Tauri 2 (Front) | Rust WASM openmls | NestJS \+ Rust Axum (Back).  
* Nginx: Single public entry point. Source of truth is infrastructure/local/Dockerfile.frontend. If adding API routes, update this config.  
* MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.  
* Build requirements: Rebuild WASM after MLS changes (cd frontend/mls-wasm && wasm-pack build --target web --out-dir ../src/lib/wasm; core logic lives in frontend/mls-core/). Regenerate protobufs after .proto changes (cd frontend && bun run proto:gen).  
* Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via canari\_ws\_token.  
* Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.  
* Infra Truth: Keep infrastructure/MIGRATION.md synced with any new secrets, services, or bootstrap steps.

## **CODING STANDARDS**

* Logs: Mandatory (Log.d, appendLog, log::debug\!) at function entry, decisions, and error branches.  
* Docs & Comments: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, do not restate types.  
* Factorization: Extract and export reusable logic. Zero duplication.  
* Language: Code, comments, docs, and dev-strings MUST be English. User-visible strings use Paraglide (FR/EN).  
* Punctuation: Normalize to ASCII (', ", \-) everywhere. Preserve French accents (é, à) in localized strings and text. Escape strings in code (\\', \\") instead of using typographic quotes.  
* Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.

## **KEY COMMANDS**

* Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); the Makefile shells out to npm on the same package.json - both work. Prefer bun locally.  
* Setup/Dev: make install, make run-services, cd frontend && bun run dev  
* Tests: make test (All), make test-frontend, cargo test  
* Frontend gates (before every commit): bun run check (svelte-check, MUST be 0 errors), bun run lint (eslint), bun run format (prettier --write .). cargo clippy for Rust. The pre-commit hook runs prettier+eslint+check across the WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

## **SESSION STATE (Active Memory)**

State lives HERE (canonical - single source of truth). Full cotisations design + decisions D1-D10: docs/COTISATIONS-REWORK-PLAN.md. Feature wiki: docs/wiki/cotisations.md.

**Current WIP: Cotisations & Boutique rework**

* Status: Phases 1-3b DONE - reviewed, tested (backend 54/54, frontend check 0 errors), pushed to main. HEAD after 3b = 3a8241c2.  
* Next step: Phase 4 (i18n completeness + docs + final CI). Breakdown under "Remaining" below.  
* Branch: main only (never feature branches).

**Locked design (condensed - full detail in plan doc):**

* Cotisant status = UserTag rows, NOT a boolean. Lifetime tag `cotisant:<slug>`; dated tag `cotisant:<slug>-<academicYear>` (academic year: month >= Aug -> year, else year-1; expiry 31 Aug). `association_members` = staff roster, a separate concept.  
* One cotisation per asso = a single canonical `membership` product. Tag auto-derived by deriveCotisationTag() in apps/social-service/src/associations/cotisation-tag.util.ts (the ONLY source of truth). Expiry derived server-side from the mode, never admin-picked.  
* Product `type` dropdown replaced by tabs: Produits (`other`) + Cotisations (`membership`). Cercle recharge (`balance_topup`) moved to /admin/cercle (global-admin only, beneficiary-asso selector).  
* Products gate/price on cotisant status: `membersOnly` (gate) + `amountCentsMember` (member price; null = same price for everyone).  
* Permissions: reuse MANAGE_MEMBERS (roster) / MANAGE_PRODUCTS (price); NO new flag. balance_topup create/update additionally require global admin - enforced in products.service.ts (lines ~85, ~136), not just client-side.  
* Roster = active tags only, promo-sorted (NULLS LAST), searchable, offset-paginated (infinite scroll), xlsx export (headers Nom, Prenom-with-accent, Promo, Cotisation, Date, Echeance-with-accent). Manual add = grant tag only, no payment.

**Done (pushed to main):**

* \[x\] Phase 1 backend: migration 016_cotisations.sql; cotisation-tag.util.ts; product member gating/pricing; balance_topup global-admin gate; resolveGrantTag (derives granted tag at FULFILLMENT time - fixes academic-year rollover).  
* \[x\] Phase 2a backend: GET/POST :id/cotisants (roster) + GET :id/cotisants/export (xlsx) in user-tag.service.ts.  
* \[x\] Phase 2b frontend: EditCotisationsTab.svelte (enable/mode config, roster infinite-scroll, add, revoke, export); expiry derived server-side in associations.service.update.  
* \[x\] Phase 3a frontend: EditBoutiqueTab type-dropdown removed + membersOnly/amountCentsMember controls; membership price editor; /shop member price + members-only gating.  
* \[x\] Phase 3b frontend: /admin/cercle page (balance_topup + beneficiary selector + webhook-failure retry moved out of EditBoutiqueTab). Commit 3a8241c2.

**Remaining:**

* \[ \] Phase 4: (a) i18n FR/EN completeness - no hardcoded user-visible strings in the new tabs/pages, both locales present; (b) docs - finish docs/wiki/cotisations.md + cross-links in associations/social-service/admin wiki + a "cotiser" section in docs/user-guide/membre.md; (c) `make run-ci` green; (d) plan follow-up: expose per-product member flags server-side to drop the client-side deriveCotisationTagName mirror in frontend/src/lib/associations/api.ts.

**Memory Gotchas (do not repeat):**

* Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash takes it literally and prefixes the subject with `@`).  
* Pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.  
* Before push: `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.  
* Client-side deriveCotisationTagName (api.ts) is display-only; the server is authoritative for tag + price.
