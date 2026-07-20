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

Normalization-sweep gotcha: accent-grep MISSES French comments written without accents ("Section Membres", "chiffre a une epoch perimee") - use both accent-grep AND French-token grep.

#### OPEN BACKLOG (reported 2026-07-20, triaged by severity x speed)

**P1 - broken functionality:**
* \[ \] **Mobile: cannot enter a community channel after being added, until the app is relaunched.** Freshly-added membership isn't usable in-session on mobile (channel open fails); works after restart. Likely the community/channel analogue of the MLS group-discovery/recovery seam (see MLS group recovery gotcha above) - channel not hydrated until the next `discoverMissingGroups`/relaunch. Investigate channel join hydration path on mobile.
* \[ \] **System-message notifications show `Message de XXX`** when someone changes the group photo or a member is added - the system/control message isn't decoded into human text. Map system message kinds (photo changed, member added/removed, etc.) to localized notif strings.
* \[ \] **User search cannot find yourself:** self is excluded from user-search results (e.g. adding yourself to an association). Allow self to appear/be selectable in the relevant search zones.
* \[ \] **Biometric stale-PIN detection never fires:** `biometricLoginImpl` tests the login error against `/PIN incorrect/i`, but `loginImpl` actually throws `"Incorrect PIN"` (reversed word order) - the regex never matches, so a stale PIN behind biometric unlock is never detected/cleared and the user gets a silent/confusing failure instead of a re-enrollment prompt. Fix the regex (or match on an error code instead of a string) so stale-PIN recovery actually triggers.

**P2 - UI correctness / polish:**
* \[ \] **Share link uses `tauri.localhost`** instead of `canari-emse.fr` when sharing a group link from the app. Use the canonical public origin for share URLs, not the Tauri webview origin.
* \[ \] **Community profile picture:** (1) re-enable changing a Community's avatar via the UI (seems to have existed before, now missing); (2) remove per-salon/channel avatars entirely (no placeholder either - show just the channel name). Also fix a large left padding/margin before the text in the "Nom du Canal" input in "Parametres du canal" (and likely other similar inputs) - reduce to normal.
* \[ \] **Klipy GIFs pollute the "Liens" tab** (Medias, liens & fichiers) - don't surface Klipy GIFs in any dedicated category. Plus z-index bug: the GIF picker's blur veil doesn't cover the whole interface like "Parametres du canal" does. Plus the "show members" toggle appears to do nothing (members are shown permanently on desktop at least) - fix or reconcile the toggle.
* \[ \] **Message input placeholder overflows on narrow/mobile screens:** "Ecrivez un message" gets clipped. (1) add ellipsis (`...`) so it truncates cleanly, and (2) shorten the copy to "Ecrire" (keep EN short too). i18n both locales.
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
