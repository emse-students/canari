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

* \[~\] **SECURITY AUDIT REMEDIATION (ACTIVE, tracker `docs/wiki/security-audit-2026-07.md`).** Read-only audit found a cluster that breaks E2EE + payments. Fix order: S1 -> S2 -> S3 -> S4 -> S5 -> S6, then S7/S8/B1. Each fix = its own commit; update the tracker status column as they land. Core invariant: nginx `auth_request` never blocks, so any client-exposed route with no guard/ownership check is abusable; `dm_group_members` is trusted by every MLS gate, so it must not be client-writable. VALIDATE each authz addition against the real call sites (group creation, invite, device register, recovery re-add) before tightening - see the tracker's "fix campaign" notes. **PROGRESS: S1 (1a4531ae, addGroupMember `assertCallerMayMutateMembership`) + S2 (a2fb5c4c, register-device/prekeys `assertCallerOwnsUserId`) + S3 (shared `assertInternalSecret` util in social-service `internal/internal-secret.util.ts`; the 3 association `stripe-account`/`stripe-complete`/`purchase-completed` routes verify `x-internal-secret`; the 4 core-service payment/webhook callers send it via existing `internalSocialRequestConfig()`; `INTERNAL_SECRET` already in all compose - no infra change) DONE. NEXT = S4** (devices.controller write/delete routes `updateDeviceMetadata`/`purgeDevicePrekeys`/`pruneDevicePrekeys`/`deleteDevice` -> `assertCallerOwnsUserId`; GET routes `getUserDevices`/`getDeviceKeyPackage` MUST stay cross-user for invite flows), S5 (removeGroupMember -> reuse `assertCallerMayMutateMembership(...,false)`; gate `getGroupUserMembers`/`getGroupMembers` roster reads on membership), S6 (media `DELETE /media/:id` owner check), S7/S8/B1. Nothing pushed yet (all local commits on main).

No open code work. Shipped this cycle, pending ON-DEVICE verification only (implementation recoverable from git):
* Pre-join history bundle durable cross-session retry (24b6480c) - verify: real 2nd device, peer offline at join, reconnect -> bundle arrives.
* History refetch-storm bounded retry (finding C, 0de94457) + discovery-gap check (finding D, a365d96e, closed - not a gap) - verify: external joiner, storm stops, no message loss.
* Server-authoritative admin-button gating on the community modal (71bfe02c) - verify: non-admin member sees no change-image/invite controls; admin does.

**iOS native parity (background push).** The iOS FFI bridge now mirrors the full Android JNI surface. Last gap closed: channel/community background decryption. `decrypt_channel_message` (shared, `background.rs`) is now exposed to iOS via `canari_native_decrypt_channel_message` (`ios_ffi.rs` + `canari_rust_bridge.h`), and `canari_push.mm` routes `type=channel` (lookup key in `channel_keys.json` -> AES-256-GCM decrypt -> notif `#<channel>`, generic fallback if key/ciphertext absent) and `type=channel_read` (cancel `channel_<id>` notif, cross-device read sync). 1:1 with Android `handleChannelMessage`/`nativeDecryptChannelMessage`. **Cannot compile-verify on Windows host (mobile mod is `cfg(target_os=ios/android)`); needs Mac/CI build + on-device channel push test.** Léon owns secrets/CI/verify. iOS release workflow stays disabled until finalized.

Residual otherwise = on-device MLS mobile native verification only.

* \[~\] **Carte de la Vie Asso - editable poster generator (ACTIVE, design doc `docs/wiki/carte-vie-asso.md`).** Data-driven re-editable PDF of the assos poster via the snapdom pipeline; access `GlobalAdminOrBdeSuperAdminGuard`; project = persisted JSON `layout` blob (content re-resolved from live data at render). **P0 (38cf58b4/949f9cb6) + P1 (7500e4f3) + P2 (eb779a5f) DONE:** category table (migrations `021`/`022`) + CRUD + `/admin/carte` hub; `lib/carte/{theme,generator,export,layout}.ts` + `PosterCanvas.svelte` freeform editor (draggable absolute stage, 4-corner uniform center-fixed resize, z-index, per-bubble panel: color/president/front-back/reset pos); persists `bubbles`+`directoryVisible`; PDF export nulls selection. **P3a (03e10272) DONE:** free-text decoration layer - `Decoration` union + `TextDecoration`, generalized `Drag{target:'bubble'|'decoration',baseWidth}` machinery (`data-el-root`), Elements palette + decoration panel; export nulls both selections. **P3b (70395056) DONE:** doodle palette - second decoration kind `DoodleDecoration`(shape/color) on the same drag/resize machinery, rendered as inline lucide SVGs (snapdom-safe, "lucide only"). New `lib/carte/doodles.ts` (`DOODLE_SHAPES` 12-shape catalog, `doodleIcon` Star-fallback, `isDoodleShape`); `layout.ts` adds `DOODLE_BASE_SIZE`/`createDoodleDecoration` + per-kind branches in `sanitizeDecorations`/`stageHeight`; `PosterCanvas` `{:else if deco.kind==='doodle'}` render branch; editor `addDoodle` + doodle button grid + `selectedTextDeco` narrowed derived (text-only controls gated, color/front/back/delete common). `patchDecoration` spread cast to `Decoration` (union-narrowing). i18n `carte_doodles_label`+`carte_doodle_*`. **P3c DONE (this commit):** snap guides - alignment while moving, ALL inside `PosterCanvas.svelte` (no data model/migration/persisted state). `beginMove` -> `collectGuides` snapshots live DOM rects of other `[data-el-root]` (accurate variable bubble heights) -> poster-px left/center/right + top/center/bottom guide lines + stage center-x + content margins; dragged footprint `w0`/`h0` captured. `onWindowMove` -> `nearestSnap` (SNAP_THRESHOLD 8px) pulls closest edge/center onto a guide, dashed lines render while dragging (gated `editable` so export never rasterises). Roots gained `data-el-id` (self-exclusion). Hold **Alt** = free placement; `carte_editor_hint` updated (both locales). GOTCHAS: prod applies `.sql` migrations manually; frontend `format` MUST pass `-c ../oxfmt.json`; layout stays an opaque JSON blob (no migration). **BROWSER-VERIFY (snapdom can't run on host):** doodles add/drag/resize/recolor/z-index/delete + mix with text+bubbles + persist; snap-align two elements' edges/centers (guide line appears), Alt frees it; Export PDF matches preview sans handles/guides. **NEXT = P3 remaining:** theme background blobs.

* \[x\] **MLS group invites - parallel + optimistic UI + picker unification + session-expiry fixes (443ca3b7):** invite path (`groupCreation.ts`) now parallelizes everything AROUND the single staged bulk commit (which stays unique under the add-lock - epoch integrity untouched): device fetches across users (`Promise.all`), Welcome deliveries via shared `deliverWelcomes()` in `groupActions.ts` (reused by createNewGroup/processBulkAddition/performDirectAdd; unit-tested), `registerMember` deduped per user; `fetchDevicesWithRetry` 6->2 attempts (targets always come from autocomplete). Optimistic pending rows: `pendingGroupInvites` (useConversations, keyed by groupId) -> prop-drilled MainChatPage->ChatArea->ChatHeader->ChatGroupPanel (amber pulsing `chat_group_invite_pending_label` badge). `MultiUserSelector` REWRITTEN to compose `UserAutocomplete` (new `clearOnSelect`/`excludeIds` props; free-text raw-ID add REMOVED); chips show names instantly via `seedUserDisplayName()` (displayName.ts). Session expiry: `_doRefresh` throws `SessionExpiredError` ONLY on 401/403 (5xx during deploys no longer logs out + revokes cookie); transient getToken failures show retryable `auth_server_unreachable` in the PIN modal (the lying hardcoded "Session expired" is gone); true session death always redirects to /login (direct `goto` fallback when `onSessionExpired` unwired). i18n added: `user_search_placeholder`/`user_unknown_label`/`user_selector_remove_label`/`auth_server_unreachable`/`chat_group_invite_pending_label`; dropped `chat_group_user_id_placeholder`. Verify in browser: invite 2+ users -> pending badges appear instantly, members resolve; chips show names not IDs; kill backend -> PIN modal shows network message (not session expired); revoke cookie -> redirected to /login.

* \[x\] **Verification service account restriction + annuaire moved to admin:** a Google/Apple review account (id from `SERVICE_ACCOUNT_USER_ID` env, GitHub-secret-overridable; default in `infrastructure/.env.example`, wired into core-service + social-service in all 3 compose files + `cd.yml`/`cd-dev.yml` upserts) is now hidden from non-admin users. core-service `UsersService` (`search()` + `directory()`): shared `applyServiceAccountVisibility(qb, requesterId)` + `isUserAdmin()` helpers - non-admins never see the SA; the SA itself only discovers global admins (`user.admin = true`); global admins unaffected; empty env = no-op. social-service `PostsService.listPosts`: `serviceAccountFilter` (mirrors existing `hiddenFilter` pattern) excludes SA-authored posts from all 4 feed variants for everyone except admins + the SA itself; `serviceAccountId` validated as hex so it can be safely inlined into the raw SQL. Admin = `user.admin` (global admin only, confirmed by user). Direct `/profile/<id>` NOT blocked (user choice) - only feed/annuaire/search. **Annuaire relocated:** removed the `/directory` link from `/profile` (assoc section header) + dropped orphan i18n key `profile_directory_link`; added a `directory` card (BookUser icon, reuses `directory_heading`/`directory_subtitle`) to the admin dashboard `/admin` base card list (visible to all admin-dashboard viewers). `/directory` page itself left ungated (user choice: "juste deplacer le lien"). Verify: non-admin sees no SA in feed/annuaire/@search; SA account only finds admins; admin still sees SA everywhere; annuaire reachable from /admin, gone from /profile.

* \[x\] **Agenda PDF export - snapdom migration + themed refonte (5415a2fa, 96246e23):** dropped dead `html2canvas@1.4.1` (reimplemented CSS layout -> mis-rendered flex/`-webkit-line-clamp` -> event titles clipped to a band) for `@zumer/snapdom` (SVG `<foreignObject>` = real browser render). Shared `rasterizeElementToCanvas` (`frontend/src/lib/utils/pdfRaster.ts`) used by calendar export AND trombinoscope; html2canvas now only a jspdf optionalDep. Then refonte toward Justine's hand-made agenda: theme presets (`calendarThemes.ts`: Rentree photo+scrim / Canari dark / Minimal), settings panel simplified (theme picker + bg + shadows up top, ~15 fine pickers in a collapsed "Personnaliser" `<details>` drawer). New backward-compat options in `calendarExport.ts`: `scrimOpacity/scrimColor`, event-title shadows, `weekdayFullNames`, `breakTintOpacity`, `pageBg`. Event CARD structure UNCHANGED (user: current is fine). Vacances/jours feries = existing `kind:'break'` (created via `AssociationCalendarSection` formKind toggle, no auto FR-holiday import), rendered as full-day band, now strengthenable on busy bg. **VERIFY (browser, cannot rasterize on host): /calendar/export - each theme, upload bg, multi-event + co-owned cell, a break, PDF matches preview; re-export a trombinoscope.**

* \[x\] **Document sharing private/public + cross-association reviewer page (1f80e469):** the per-asso encrypted vault (`AssociationDocumentManager.svelte`) now has a per-doc **prive/public** toggle + **rename** (display `name`; `originalFilename` kept for extension). New entity `DocumentReviewerGrant` + migrations `019` (visibility+originalFilename) `020` (grants). Global admins + BDE super-admins designate reviewers at `/admin/document-reviewers`; reviewers (school/MDE, non-ICM ok) browse all public docs at standalone **`/documents`** (accordion per asso, dashboard entry card gated on `getReviewerAccess()`). CRYPTO: server derives per-doc CEK via `hkdfSync(vaultKey, salt=cekSalt, info="doc-vault")` for PUBLIC docs only and returns just that CEK - raw vault key never exposed; password-protected docs can't be public. New guards `GlobalAdminOrBdeSuperAdminGuard` + `ReviewerAccessGuard`. Reviewer/grant controller routes declared BEFORE `:id` routes (else `reviewer/documents` shadowed by `:id/documents`). Verify: mark a doc public -> non-member reviewer sees+downloads it at /documents; private/protected never appear.

* \[x\] **Cotisation tag UI de-systemized (7efd1247):** raw slugs (`cotisant:bde` / "Sans expiration") now render as an enriched row - issuing-asso avatar+name + "Cotisant - Permanente|Expire le X" subtitle. Shared `formatCotisationTag()` + memoized `resolveIssuingAssociation()` in `frontend/src/lib/associations/cotisationTag.ts`; shared `CotisationTagRow.svelte` on profile subs section + `/account/purchases`; admin roster (EditMembersTab) just prettifies the label (no redundant own-logo). 4 new FR/EN keys (`cotisation_tag_*`). GOTCHA: all 3 tag render sites go through the shared helper - keep new ones consistent. Verify: logged-in cotisant sees asso logo/name (not slug).

* \[x\] **Minesweeper ranked leaderboard (shipped, d1061bee..85398570):** on **social-service** (`/api/minesweeper`), seeded challenges + move-replay anti-cheat, guess-free grid generation, auto-flagging disabled. Score = server wall-clock only. Access = hidden easter egg: `/settings`, tap the device-id footer 5x quickly (`onDeviceIdTap` -> `MinesweeperModal`). GOTCHA: keep `apps/social-service/src/minesweeper/engine/game.ts` synced with `frontend/src/lib/minesweeper/game.ts` (dual engine, must stay 1:1). Migration `018_minesweeper_leaderboard.sql`.

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
