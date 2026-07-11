# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES (OPUS AUTONOMOUS MODE)**

* NO BLIND GREP: Never run generic grep or find across the project. Check the SESSION STATE below first, or ask the user for exact paths.
ASK EARLY: State assumptions explicitly. If uncertain about architecture, multiple interpretations, or a bug, ASK during the planning phase. No guessing.
* SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
* STATE PRUNING: When updating the roadmap, DELETE the detailed descriptions of completed tasks. Keep the file small.
* UPDATE STATE: You MUST update the SESSION STATE at the bottom of this file before finishing a Work Package.
* BASH OVER SUBAGENTS: Use native `rg`/`find` to filter text BEFORE the LLM sees it. 10 lines of `rg` output in Opus is cheaper than 1000 lines of `cat` in a Haiku subagent.  
* EDITING STRATEGY: Opus must write surgical edits directly. ONLY spawn subagents for broad, semantic codebase audits or massive multi-file refactors. 
* WORKFLOW CYCLE:  
  1. Plan the step and read files (using `rg`/tools).  
  2. Ask questions EARLY if uncertain (or during execution if needed).  
  3. Execute the code (Goal-driven, fix tests first).  
  4. Run tests/checks.  
  5. Run `git add . && git commit -m "[Task summary]"`.  
  6. Update SESSION STATE below.  
  7. STOP and output: "Task committed. Please run `/compact` (or `/clear` if switching to a new theme)."  
* WIKI & CLEANLINESS: Documentation goes EXCLUSIVELY in `docs/wiki/`. Delete unused/legacy code immediately.  
* PROD ACCESS: You can connect to production via SSH using `ssh canari` (or `ssh mitv`).

## **ARCHITECTURE & CONSTRAINTS**

* Stack: SvelteKit 5 \+ Tailwind 4 \+ Tauri 2 (Front) | Rust WASM openmls | NestJS \+ Rust Axum (Back).  
* Nginx: Single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`. If adding API routes, update this config.  
* MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.  
* Build requirements: Always rebuild WASM (`mls-wasm/`) and protobufs (`npm run proto:gen`) after structural changes.  
* Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via `canari_ws_token`.  
* Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.  
* Infra Truth: Keep `infrastructure/MIGRATION.md` synced with any new secrets, services, or bootstrap steps.

## **CODING STANDARDS**

* Logs: Mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions, and error branches.  
* Docs & Comments: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, do not restate types.  
* Factorization: Extract and export reusable logic. Zero duplication.  
* Language: Code, comments, docs, and dev-strings MUST be English. User-visible strings use Paraglide (FR/EN).  
* Punctuation: Normalize to ASCII (`'`, `"`, `-`) everywhere. Preserve French accents (`é`, `à`) in localized strings and text. Escape strings in code (`\'`, `\"`) instead of using typographic quotes.  
* Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.

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

### CROSS-PROJECT: Quality & Security cleanup (asked 2026-07-11, AWAITING "depart")

Goal: clean all 4 repos - CodeQuality/CodeQL alerts, security warnings, Dependabot, Node 20->22 EOL, wiki + English-comments audit (our CLAUDE.md base standards). Investigation done via `gh`; execution NOT started (user gates it).

**Findings (gh, 2026-07-11):**
* Dependabot: ENABLED on all 4 repos; **0 open security alerts** everywhere. (Still TODO tomorrow: check for open Dependabot version-update PRs + presence/quality of each repo's `.github/dependabot.yml`.)
* CodeQL / code scanning OPEN alerts:
  * Canari: 20 total = 2 critical + 1 high + 1 medium security, +16 quality. Security ones:
    * critical js/request-forgery (SSRF): apps/chat-delivery-service/src/controllers/security.controller.ts:301
    * critical js/type-confusion-through-parameter-tampering: apps/core-service/src/users/users.service.ts:168
    * high js/remote-property-injection: apps/social-service/src/channels/channel.service.ts:1612
    * medium js/log-injection: frontend/src/lib/services/WebMlsService.ts:434
  * MiGallery: 7 total = 2 high + 4 medium + 1 quality. Notable:
    * high js/file-system-race: src/routes/api/albums/[id]/og-cover/+server.ts:100 (real runtime path)
    * high js/clear-text-logging: scripts/migrate-export-db.cjs:175 (script only)
    * medium js/missing-origin-check: static/mitm.html:34 & :69 (postMessage; verify if mitm.html is shipped)
    * medium js/log-injection: scripts/mock-immich.js:14 & :29 (dev mock only)
  * Sky: 3 quality alerts (no security-severity).
  * Portail-etu: 1 quality alert.
* Node 20 EOL: NOT yet verified (classifier outage interrupted the sweep). TODO tomorrow: grep `node-version:` in every repo's .github/workflows + `engines.node` in package.json; bump 20 -> 22 (LTS) and matching Docker base images.

**Plan when GO given (order = severity first):**
1. Canari 2 criticals (SSRF + type-confusion) then high (property-injection) then medium (log-injection). Real fixes, not suppressions; add/adjust tests.
2. MiGallery file-system-race (runtime) first; triage script/mock/mitm.html alerts (fix or dismiss-with-reason if non-shipping).
3. Node 20->22 bump across all 4 (workflows + engines + Docker), each repo its own commit, CI green before push.
4. Wiki + English-comment audit per repo (our base standards), fold into the touched files.
5. Sky/Portail quality alerts (low sev) last.
Each repo = its own commits on main; run that repo's full local CI gate before pushing.

---

### CANARI

**A. Cotisations & Boutique rework (WIP).** Full design + decisions D1-D10: docs/COTISATIONS-REWORK-PLAN.md. Wiki: docs/wiki/cotisations.md. HEAD after 3b = 3a8241c2 (then CLAUDE.md doc commit ecb08011).

Locked design (condensed): Cotisant status = UserTag rows, NOT a boolean - lifetime `cotisant:<slug>`, dated `cotisant:<slug>-<academicYear>` (academic year: month >= Aug -> year, else year-1; expiry 31 Aug). `association_members` = staff roster (separate concept). One cotisation/asso = a single canonical `membership` product; tag auto-derived by deriveCotisationTag() in apps/social-service/src/associations/cotisation-tag.util.ts (ONLY source of truth); expiry derived server-side, never admin-picked. Product `type` dropdown -> tabs Produits (`other`) + Cotisations (`membership`); `balance_topup` moved to /admin/cercle (global-admin only, beneficiary-asso selector). Products gate/price on cotisant status via `membersOnly` + `amountCentsMember` (null = same price). Permissions: reuse MANAGE_MEMBERS / MANAGE_PRODUCTS, NO new flag; balance_topup create/update also require global admin - enforced server-side in products.service.ts (~L85, ~L136). Roster = active tags only, promo-sorted NULLS LAST, searchable, offset-paginated, xlsx export (headers Nom, Prenom, Promo, Cotisation, Date, Echeance). Manual add = grant tag only, no payment.

* \[x\] Phase 1 backend: migration 016_cotisations.sql; cotisation-tag.util.ts; product member gating/pricing; balance_topup global-admin gate; resolveGrantTag (grant derived at FULFILLMENT time - fixes academic-year rollover).
* \[x\] Phase 2a backend: GET/POST :id/cotisants (roster) + GET :id/cotisants/export (xlsx) in user-tag.service.ts.
* \[x\] Phase 2b frontend: EditCotisationsTab.svelte (enable/mode config, roster infinite-scroll, add, revoke, export); expiry server-derived in associations.service.update.
* \[x\] Phase 3a frontend: EditBoutiqueTab type-dropdown removed + membersOnly/amountCentsMember controls; membership price editor; /shop member price + members-only gating.
* \[x\] Phase 3b frontend: /admin/cercle page (balance_topup + beneficiary selector + webhook-failure retry moved out of EditBoutiqueTab). Commit 3a8241c2.
* \[ \] Phase 4: (a) i18n FR/EN completeness - no hardcoded user-visible strings in the new tabs/pages, both locales present; (b) docs - finish docs/wiki/cotisations.md + cross-links in associations/social-service/admin wiki + a "cotiser" section in docs/user-guide/membre.md; (c) `make run-ci` green; (d) follow-up: expose per-product member flags server-side to drop the client-side deriveCotisationTagName mirror in frontend/src/lib/associations/api.ts.

**B. Parent-association Stripe delegation (NEW, feature).** Some "associations" are really clubs depending on a parent asso. In the asso payment-management UI, a club must be able to declare a "parent association" that (1) receives the club's payments on ITS Stripe account, and (2) can access the club's accounting. Effect: a club with no Stripe account of its own can still run paid forms / sell products, routed to the parent's Stripe. Keep the "association" wording in the UI (do NOT rename to "club"). Scope TBD: data model (parent_association_id on association), payment routing to parent's Stripe Connect account, accounting-visibility permission for the parent. Confirm scope before building.

**C. MLS on a fresh device - notification decrypt + history bundle (NEW, bug/investigation).** When a new device sends a message to a mobile device that has NOT been opened: the push notification is NOT decrypted, even though the Welcome was delivered and normal comms work. Separately, the new device never receives the conversation history bundle - is it even requested? Can the mobile deliver it in background, or at least on next app-open? Relates to existing findings: [[project_notif_decrypt_readonly_limit]] (background push decrypt is read-only/ephemeral, can't apply commits -> newer-epoch messages fail), [[project_welcome_request_dual_receiver]] (re-add has 2 paths). Investigate: (1) does the fresh device request the history bundle at all; (2) background delivery vs. deferred-to-app-open; (3) why the first push after Welcome can't decrypt.

**D. MLS + Communautes audit (track).** Ladder: docs/AUDIT-MLS-2026-06.md. Open findings: C1/C2 (Android dual MLS engine - WebView vs JNI both write mls.bin, foreground never reloads on resume; needs on-device diagnosis), C4/C5 (mls-core), H1-H5 (recovery/backend), strictness pass. Confirm scope of the deferred "correction de..." ask before starting.

**E. UI/UX bugs (NEW).**
* \[ \] Switching Discussions tab -> Communautes tab keeps the PREVIOUS discussion's content displayed (stale state not cleared on tab switch).
* \[ \] Clicking a "Filleul / Filleule" on /profile changes the URL but does NOT navigate (page doesn't re-render - suspect SvelteKit reactivity/`$page`/load not re-running on same-component param change; likely needs `afterNavigate`/`invalidate` or a keyed component).
* \[ \] PIN modal "Session expired: Please Sign In Again" -> instead of showing that message in the modal, log the user out and redirect straight to the login page (current message leaves people lost).

**F. i18n(chat) - DONE.** \[x\] Hardcoded FR/EN chat system messages (group events, deletions, removal notice, channel invite, call texts, previews) migrated to Paraglide. Call finalization guarded by a structured `endedAt` flag on SystemEnvelope.callEvent (survives translation), NEVER `text.includes(...)`. Gotcha: callSystemMessages.test.ts still asserts the FR literal (default test locale = FR).

**G. Device/APK verification backlog.** keyboard-GIF commitContent (chat + comments), channel push #2, channel_read cross-device dismissal, mobile keyboard-open off-screen scroll.

**H. Normalization sweep (ongoing).** Paraglide FR/EN + English comments + docs/wiki across remaining chat/community modules.

---

### SKY (../Sky)

Family = connected component (isSameFamily gates edits). Conventions: [[project_sky_conventions]], accents rule [[feedback_sky_french_accents]].

* \[ \] Parrainage rules (NEW, hardening - some partly exist, verify + enforce):
  * A filleul is ALWAYS a strictly higher (more recent) promo than their parrain.
  * Promo is a number >= 1816 - validate at creation.
  * Parrain<->filleul promo gap is AT MOST 3 years. (Existing conventions memory notes merge-year tolerance <=3; align this with the parrainage constraint.)
* \[ \] Promo color gradient (NEW, nice-to-have): tint nodes by promo so a branch's direction reads visually - lighter = more recent. Compute from the min/max promo bounds across the displayed graph.
* \[ \] i18n: pages + all user-facing errors localized; remaining = French code comments in server layer ([[project_sky_i18n_progress]]).
* \[ \] Cleanup (see cross-project): 3 quality CodeQL alerts, Node bump, wiki/comment audit.

---

### MIGALLERY (../MiGallery)

* \[ \] Normalization: wiki + Paraglide infra done+pushed; remaining = UI string migration + English comments + tolerant search ([[project_migallery_normalization]]).
* \[ \] Cleanup (see cross-project): 2 high + 4 medium CodeQL alerts (file-system-race is the real one), Node bump, wiki/comment audit.

---

### PORTAIL-ETU (../refonte-portail-etu) - Vitrine SPA

Vitrine SPA (SvelteKit 5 + Tailwind 3.4 + svelte-adapter-bun, `ssr = false` because deploy host can't reach canari-emse.fr / hairpin NAT). Reads Canari public API `/api/public/*` from the browser. Standards target = MiGallery/Sky/Canari level.

* \[x\] Redesign v2 (A1-A4): brand "Portail Etudiant ICM" (src/lib/site.ts), Tailwind + dark-mode glassmorphism, hero v2 + stats, `reveal` IntersectionObserver (honors prefers-reduced-motion).
* \[x\] Avatar photos: same-origin proxy src/routes/api/users/[userId]/avatar/+server.ts -> MiGallery (x-api-key, key in server .env). userId = Authentik uid; MemberCard falls back to initials on 404.
* \[x\] N1 CI integrity: .husky/pre-push mirrors full CI (lint+format:check+check+test+build, blocks dirty index); test.yml pins Bun 1.3.14 + --frozen-lockfile + build.
* \[x\] N2 Tailwind + dead code: 10 dead files removed, `<style>` -> Tailwind, `@tailwindcss/typography` wired.
* \[x\] N4 License: PolyForm Noncommercial 1.0.0 + "Required Notice:" CREDIT line (Les ROOTZ / Jolan Boudin, Leon Muselli, Mathieu Daussin) - credit only, NO copyright assertion.
* \[x\] N5 Docs: README rewritten (English); docs/wiki/{index,architecture,deployment}.md; GitHub-docs deleted.
* \[~\] N3 i18n Paraglide (uncommitted local tree): infra done (messages/{fr,en}.json ~59 keys, vite plugin strategy localStorage->preferredLanguage->baseLocale, /src/lib/paraglide gitignored). Converted: Header, Footer, new LocaleToggle. REMAINING to swap: +page.svelte (home), associations/+page.svelte, lists/+page.svelte, liens/+page.svelte, AssociationCard, EntityDetail, MemberCard (m.member_fallback), FeaturedLinks+links.ts (add id -> m.link_*_tagline), associations/[handle] & lists/[handle] (titles via pageTitle, meta descriptions, backLabel -> m.detail_back_*), ThemeToggle aria. Then recompile paraglide + check/lint/build + commit/push.
* \[ \] N6 English-only comments: sweep remaining FR comments (e.g. ThemeToggle observer), fold in as files are touched.
* \[ \] N7 CD via GitHub Secrets (the big "a la fin"): inject ALL secrets via GitHub Secrets, rotate keys, DROP the server .env dependency (user has no server .env access). Clean deploy.yml leftovers (sharp install / rollup external in vite.config.ts). Replicable on a fresh machine.
* \[ \] Cleanup (see cross-project): 1 quality CodeQL alert, Node bump.

---

### SHARED GOTCHAS (do not repeat)

* Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@` (Git Bash takes it literally and prefixes the subject with `@`).
* Canari pre-commit hook sweeps the WHOLE frontend and re-stages; isolate unrelated dirty files (e.g. CLAUDE.md) before committing a feature.
* Before push (Canari): `rm -rf apps/*/dist` (pre-push replays compiled specs) then `git pull --rebase --autostash origin main`.
* Client-side deriveCotisationTagName (api.ts) is display-only; the server is authoritative for tag + price.
* Portail: SPA (`ssr = false`); avatar proxy is portail-side same-origin (gallery.mitv.fr IS reachable, canari-emse.fr is not); eslint-plugin-svelte v3 ignores inline `no-at-html-tags` disables -> per-file override in eslint.config.js for EntityDetail.svelte; `data-export/` holds PII, never commit; push shows "Bypassed rule violations" (admin bypass) but lands.
* Sky UI French must keep accents + straight apostrophes (user flags missing ones repeatedly).
