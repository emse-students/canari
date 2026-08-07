# **Canari \- Rules & Session State**

## **AGENT DIRECTIVES**

- NO BLIND GREP: Never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: State assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
- STATE PRUNING: When updating the roadmap, DELETE detailed descriptions of completed tasks. Keep the file small.
- CLAUDE.md HYGIENE: Actively trim this file. DELETE shipped Work Packages (keep only forward-relevant gotchas), collapse redundant notes, drop stale entries.
- UPDATE STATE: Update SESSION STATE at the bottom of this file before finishing a Work Package.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> `git add . && git commit -m "[summary]"` -> Update SESSION STATE" -> STOP (compact)
- DOCUMENTATION: Technical docs live in `docs/wiki/` (English, LLM-oriented, preferred search before code). User-facing guides in `docs/user-guide/` (French). UML diagrams in `docs/diagrams/`. Root-level docs: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- CHANGELOG: When adding features, fixing bugs, or making breaking changes, add an entry under `[Unreleased]` in `CHANGELOG.md` (Keep a Changelog format). Move to a version section on release.
- WIKI IS PREFERRED: Always search `docs/wiki/` before reading source code. Update the relevant wiki page alongside code changes — stale wiki is worse than no wiki. Cross-link freely between pages.
- SERVICE READMES: Each `apps/*/README.md` should stay synced with its wiki counterpart. If you expand the wiki page, reflect the summary in the README.
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` (Le Cercle, via ProxyJump canari; key installed
  2026-08-03, no password needed). Postgres db is `auth_db`, user `canari` (NOT `postgres`, and not
  the `admin` of `.env.example`, which is local-only). **Use the PowerShell tool, never Bash** - Git
  Bash strips the backslashes out of the cloudflared ProxyCommand path and the exec fails. Quote SQL
  with a SINGLE-quoted outer string and doubled literals: `ssh canari 'docker exec … psql -U canari
  -d auth_db -x -c "SELECT … WHERE id = ''uuid''"'`.
- CLASSIFIER DOWN: End of session signal. Stop ASAP, prepare compaction + easy resume for next session.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (Front) | Rust WASM openmls | NestJS + Rust Axum (Back).
- Nginx: Single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS Protocol (RFC 9420): All encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: Always rebuild WASM (`mls-wasm/`) and protobufs (`npm run proto:gen`) after structural changes.
- Auth: Access tokens in memory ONLY (never localStorage). Refresh tokens in HttpOnly cookie. WS auth via `canari_ws_token`.
- Media: Client generates CEK (AES-256-GCM) before upload. Backend sees opaque blobs.
- Infra Truth: Keep `infrastructure/MIGRATION.md` synced with new secrets, services, or bootstrap steps. When adding a new service or infrastructure component, add it to the wiki (`docs/wiki/infrastructure/`) and `README.md` architecture diagram.

## **CODING STANDARDS**

- Logs: Mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions, and error branches.
- Docs & Comments: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, do not restate types. All documentation files (`docs/`, `*.md` at root) are English except `docs/user-guide/` (French, user-facing).
- Factorization: Extract and export reusable logic. Zero duplication.
- Language: Code, comments, docs, and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline string literals.
- Punctuation: Normalize to ASCII (`'`, `"`, `-`) everywhere; escape quotes in code (`\'`, `\"`). Preserve French accents (`é`, `à`) ONLY in localized strings/French comments.
- Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.
- UI: Single source of truth is `src/app.css` (tokens, `--radius-*`). Use `.btn-glass` with modifiers. Dark-first glassmorphism. Avoid raw hex/px. `lucide-svelte` only (no aliases).
- Husky: Pre-commit runs oxlint + oxvelte + oxfmt + svelte-check. Fix errors; do not bypass.

## **KEY COMMANDS**

- Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); Makefile shells out to npm - both work. Prefer bun locally.
- Setup/Dev: make install, make run-services, cd frontend && bun run dev
- Tests: make test (All), make test-frontend, cargo test
- Frontend gates (before every commit): bun run check (0 errors), bun run lint, bun run format. Rust >= 1.97 (`rust-toolchain.toml`). cargo clippy for Rust crates. Pre-commit hook runs oxfmt+oxlint+oxvelte+check across WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

## **SESSION STATE (Active Memory)**

State lives HERE (canonical). Five repos: Canari (this monorepo), Sky (../Sky), MiGallery
(../MiGallery) and Portail-etu (../refonte-portail-etu) are `emse-students/*` on GitHub;
**Le Cercle (../le-cercle)** is `gitlab.emse.fr:aurel.dautry/le-cercle`.
Sky, MiGallery and Portail-etu are COMPLETE - nothing open on any of them.
All on `main` EXCEPT Le Cercle: Aurel owns that repo. Never commit to its `main`; work on a branch
and hand him a merge request.

Work is tracked as Work Packages ordered by severity: **P1** (security, or a user-facing path that
is broken), **P2** (correctness, nothing at risk), **P3** (hygiene). `[ ]` open, `[~]` in progress.
Delete a WP outright once it ships: the rule it taught goes to DURABLE RULES, the story to
`CHANGELOG.md`.

### NEXT SESSION - START HERE (written 2026-08-07 at the close; this file was PRUNED here)

Every shipped Work Package was deleted from this file on 2026-08-07 - their stories are all in
`CHANGELOG.md` under `[Unreleased]`, the rules they taught are in DURABLE RULES below, and the
narratives are on the wiki pages each one points to. **Do not reconstruct them here.** What remains
below is only what is still OPEN or still OWED.

**1. THE APK GATE IS MOSTLY CLEARED (2026-08-07 evening).** A build carrying everything up to
`c53b6077` was flashed at **18:55:34** (`lastUpdateTime` moved from 12:53:19 - that is the only
discriminator, the version name does not move) and three of the four owed checks PASSED on hardware:

- **WP-DL-1 PASS.** The feed's PDF: log `[download] saving "ParlerMarteau_Rev03.pdf" (tauri=true)`,
  the SAF dialog opened (`documentsui/PickActivity`) prefilled with the right name, and after
  ENREGISTRER the file was **absent before / present after** in `/sdcard/Download`, 152 370 bytes,
  `%PDF-1.6` + `startxref 150485` + `%%EOF`, 166 objects. So `fs:allow-write-file`, the `content://`
  URI and the whole `blob:` routing fix are all proven. **Still owed on this WP: the backup export's
  Tauri branch**, which changed shape (it used to ask for a DIRECTORY, which SAF does not offer).
- **PDF pinch - the whole story, because it is the session's best lesson.** The first check PASSED on
  "column width 100 % -> 300 %, page image 395 -> 1186 px" and the user immediately reported it
  zoomed "pas a l'endroit qu'on veut". **The check asserted that the zoom CHANGED and never that it
  was ANCHORED**, so it would have returned the same PASS against a build with no focal point at
  all. `check-pdf-anchor.mjs` (now in `tools/cross-client-harness/`) replaces it: it identifies a
  CONTENT point before the gesture (page index + fraction within that page) and re-locates it after,
  which is the observable the user was describing.
  **It was validated as a NEGATIVE CONTROL against the unfixed build first**
  - drift (395, 1370) px - and that is the only reason its later verdicts mean anything.
  Two fixes followed, and the second is the interesting one: `f218bcc6` added the focal point and
  cut the drift to (-17, -49); `b88cf260` closed the rest. **A ratio-based scroll correction is
  wrong in a paged column** because `py-3` and `gap-3` are fixed CSS lengths that do NOT scale, so
  the ratio overshoots by `(ratio - 1) x (padding + gutters above the pinched page)` - measured 48 px
  on page 2 at x3, ~192 px by page 8. The settle now re-measures the pinched PAGE after relayout
  (`anchorScroll`/`anchorFraction`/`nearestBoxIndex`, 25 tests). Trap it introduced and closes: the
  column animates back to `scale(1)` over 120 ms and `getBoundingClientRect` reports the ANIMATING
  box, so the transition is suppressed while the settle measures.
- **PDF pinch ANCHOR: PASS on hardware** (build `lastUpdateTime 20:41:25`, commit `b88cf260`), drift
  **(-0.8, -0.5) px** at a 12 px tolerance, against (395, 1370) with no correction and (-16.8, -48.6)
  with the ratio one. Corroboration worth keeping: `scrollTop` 1679.24 -> 1631.24 is **48.00 px
  exactly**, the figure `pinchZoom.test.ts` predicts from the unscaled padding + gutter. Do not
  re-verify this.
- **LEON's TWO UI COMMITS: BOTH PASS on hardware.** `6139969d` edge-to-edge - `env(safe-area-inset-*)`
  resolves to **top 51 px / bottom 24 px**, which is the only real proof since compiling establishes
  nothing here. `30979c57` nav opacity - the bottom nav computes `oklab(0 0 0 / 0.8)` under
  `data-theme="dark"`, light untouched at 0.7, theme restored to `light` afterwards. **Two locator
  faults on the way, both the documented rule:** `document.querySelector('nav')` returns the SIDEBAR
  (transparent), the bottom nav is `nav.fixed.bottom-0`; and the theme is driven by `data-theme` on
  `<html>`, NOT by a `.dark` class, so adding the class measures the light rule the commit
  deliberately left alone. Tailwind 4 emits `oklab`, so the alpha is after a `/`, not a 4th comma.
- **WP-RELOAD-DL-1 PASS**, with the mechanism visible: cold start on `fr.emse.canari://chat/<dm>`,
  claim `fr.emse.canari://chat/642f389a-...` written to `sessionStorage`, parked on `/posts`,
  reloaded - claim STILL there, route still `/posts` after the 250/750/2000 ms re-checks.
- **PDF TWO-SCALE RENDER: PASS on hardware** (build 21:29:49, commits `1637ed39` + `cb427031`).
  `check-pdf-render.mjs` samples the first page every 16 ms while the zoom ladder is walked:
  **473 blank-or-cut frames out of 475 before, 0 out of 474 after**, and 1 -> 1.5 -> 2 -> 3 now costs
  ONE rasterisation instead of four. Answers the user's report of 2026-08-07 in full.
- **FEED RETRY: PASS on hardware** (`cb427031`). `check-feed-retry.mjs` injects a one-shot
  `/api/posts` failure in-page, clicks Reessayer: the error screen and its button are gone and two
  cards are back, where the same injection on the previous build left the error screen up after a
  `200`. **The failure injection must be in-page** - CDP's Network domain is blind to the app's own
  requests on mobile, since `hooks.client.ts` replaces `window.fetch` with the Tauri plugin's Rust
  client - and the navigation must stay CLIENT-SIDE or the document reload takes the patch with it.
- **THE APK GATE IS NOW FULLY CLEARED except the backup export's Tauri branch.** Leon's two UI
  commits are verified above; `9d636d6a` only adds WP-SAFELINK-1 to this file.

**What that evening also established about the rig, and must not be re-derived:**

- **`connect()` in `cdp.mjs` is NOT ready-aware** - it does not await the socket open and throws
  `Sent before connected`. Use `client(port)` from `chat.mjs`. (Cost two runs, twice now.)
- **Git Bash mangles an absolute device path** in `adb shell`: `/sdcard/ui.xml` became
  `/Files/Git/sdcard/ui.xml`. Same class as the prod-SSH rule - **use PowerShell for adb shell
  commands carrying an absolute path**.
- The PDF reader renders pages as **`<img>`, never `<canvas>`** (blob URLs), and the SETTLED zoom is
  the page column's inline `width: N%` - `transform: scale()` is the live preview and returns to 1,
  so asserting on it would pass against a build with no settle at all.
- **The phone has NO wifi at this location** (`wlan0` carries no address); it is on 4G via `rmnet1`,
  which is fine for the campaign but makes `adb tcpip` impossible - USB only, and **that USB link
  drops on its own** (it did twice, killing a logcat capture and the 9222 forward each time). After
  every drop: re-read the socket (`webview_devtools_remote_<pid>`, the pid changes on a cold start)
  and re-do the `forward`. adb serial is `2A251JEGR05373` (Pixel 6a).
- New one-shot scripts in the scratchpad, reuse them: `probe-a1-state.mjs`, `probe-find-pdf.mjs`,
  `check-dl.mjs`, `check-pdf-pinch.mjs`, `check-reload-dl.mjs`.
- **A debug APK is now ~644 MB where the content it declares is 331 MB**, the unaccounted 312.7 MB
  matching the native lib to 0,04 % - the `.so` is physically in the archive twice. Harmless and
  investigated: one ABI only, and the SHIPPED artefacts are 15 MB (`.aab`) / 35 MB (`.apk`). Do not
  re-measure it.

**1bis. OWED RIGHT NOW, and it is the FIRST thing to do (2026-08-07, ~21:00).** The user reported
that re-rasterising at every zoom step is heavy and "ca peut couper l'image". Fixed by `1637ed39`:
`RENDER_ZOOMS = [1, last step]` (a pinch through 1.5 and 2 to 3 now costs at most ONE re-render, and
1.5 -> 2 -> 3 costs none), and the current bitmap is never taken off screen - it is replaced in
place, an old bitmap being the right image at the wrong resolution. The cutting was the swap: the
placeholder is an `aspect-ratio` box with `overflow-hidden`. Guard is `renderedAt` (the CSS width a
page was rendered FOR), never `RenderedPdfPage.width`, which is DEVICE pixels.
**Gates green, committed, NOT on the phone**: the APK build was still running and the USB link then
dropped for good (device no longer enumerated - needs a physical re-plug, the user was asked).
`check-pdf-render.mjs` is WRITTEN but has **never run, not even as a negative control** - run it
against the OLD build first if the phone still carries it, because its two assertions (never blank
or clipped, and <= 2 distinct bitmap srcs across the whole ladder) are exactly what the old build
should fail.

**2. THE AUDIT / CAMPAIGN RESUMES** - the phase dashboard at the top of
[cross-client-testing](docs/wiki/cross-client-testing.md) is the source of truth, not this file. In
order: re-run the checks that touch the repair mechanism now that WP-HIST-3 is deployed (**reload
BOTH browsers first** - a long-lived tab keeps its old bundle), then NOTIF-2/3/5/6 and the NOTIF-10
re-run, HEAL-W1..W4 (section 7.1), PIN/MULTI/CORRUPT. **LIFE-5 needs the USER** (the unlock pattern
after a reboot) - pause and ask, never work around it.

**3. CONVERGENCE MEASUREMENTS the user asked for explicitly** (2026-08-07): does it converge, does
the server's pending-message count match what the clients hold, is the client count right. Three
things to reconcile, all reachable: `recon.mjs` for the per-thread marker diff between W1 and W2;
`SELECT recipientId, deviceId, count(*) FROM queued_message GROUP BY 1,2` on prod against what each
client actually shows; and `DeviceGroupMembership` against live key packages (the WP-GHOST-1
predicate) to confirm the platform still holds ZERO memberships without one.

**4. Then the remaining WPs**, which the user wants done "un jour, apres l'audit": WP-VIEWER-1,
WP-STORAGE-1 (its item 1 is config only and divides the backup requirement by ~16), WP-DRAIN-2,
WP-ECHO-1's verification, WP-PENDING-1/2's, WP-OIDC-TAB-1. WP-LINK-1 shipped 2026-08-07 (see
DURABLE RULES / the whitelist entry below) - do not re-add it here.

---

**LEON PUSHES TO CANARI's `main` TOO** (asked by the user 2026-08-07). So `git fetch` at the START of
a session and again before any measurement - never assume the local `main` is the deployed truth. His
commits are often style/UI and they land in the same files the campaign measures, so what is owed for
each is a WEB and a MOBILE pass, logged next to our own checks. He follows the conventions - his
WP-KBD-1 fix (`cc540145`) carried tests, the wiki page, `CHANGELOG.md` and the SESSION STATE entry -
so a rebase is normally clean; the thing to actually verify is his change RUNNING, on both surfaces,
which no test of his can establish.

---

### LE CERCLE (../le-cercle) - MR !4 PUSHED, AWAITING AUREL

**MR !4** - `chore/project-conventions`, 13 commits, rebased onto `main` and pushed 2026-08-05 -
https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/4
**Description still to PASTE by hand: `../MR-CERCLE-2.md`** - which also carries what !4 contains and
every decision behind it, so do not re-litigate any of them from here. Git refuses a push option
containing newlines, so `merge_request.description` is unusable, while `merge_request.create` +
`.target_branch` + `.title` over SSH DO work (that is how !4 was opened, no `glab`, no token).

**VEILLE - on demand, never scheduled.** He keeps working on `main`; run this loop when asked:

1. `git fetch` in `../le-cercle`, then `git log --oneline origin/main --not chore/project-conventions`.
2. `git rebase --onto origin/main <merge-base>`. Never a commit on `main` - it is his repo.
3. Two files conflict every time: `.env.example` (HIS placeholder convention wins) and
   `.prettierignore` (keep his `/db/sql/seed.sql` line, or prettier reformats the fixture dump).
4. Re-apply our conventions to HIS new code. The canonical checklist is `../le-cercle/AGENTS.md` -
   do not duplicate it here. He does not run the gates, so expect `prettier --check` failures on what
   he merged; formatting-only fixes belong in their own commit.
5. Resync the wiki - `authentication.md`, `ledger.md`, `data-model.md`, `deployment.md` and
   `frontend.md` rot fastest. A fork followed in parallel drifts in the DOC first: the rebase is
   mechanical, what the wiki asserts about his code is not.
6. Gates, `push --force-with-lease`, then paste the MR description by hand.

**No Work Package is open on the Cercle.** What is left is his to decide (the ledger's unwritable
`undo`/`cashout`, `JWT_OLD_SECRET`, the placeholder `AUTH_SECRET`) and it is written up, with the
fingerprints that establish it, in [PROD-TEST-CERCLE](docs/PROD-TEST-CERCLE.md) - to RAISE, never to
patch. Three prod tests there need a human and are not WPs: V1 (a real MiConnect round trip), V2 (the
access gate), V4 (the alcohol gate at a till). The link itself is LIVE and proven both directions;
every probe and its answer is in that file, do not re-derive it.

**Architecture decisions taken 2026-07-28 (do not re-litigate):** ledger + cached column; the
Cercle keeps `memberships` as a display-only mirror while Canari owns tier assignment; cercleux
get site access without a cotisation but may NOT consume; cash top-ups allowed with an audit
trail; Canari credits but never displays the balance. **His membership model, overriding any older
note:** no cotisant snapshot, no TTL - `syncCanaryMembership` writes `users.id_membership` at login
and on the 5-minute session-JWT refresh.

**Ours, not the repo's** (its own traps are in `../le-cercle/AGENTS.md`, the prod facts and every
probe already run in [PROD-TEST-CERCLE](docs/PROD-TEST-CERCLE.md) **here**):
`CANARI_INTEGRATION_ENABLED` sits in the deployed `.env` and is referenced NOWHERE since the rewrite
- dead, not a switch. Never test the Canari link against the DEV server: `$env/dynamic/private` there
came from a stale process and read the OLD `.env`, silently disabling it - build, then
`bun ./build/index.js` with the env explicit on the command line. `TaskStop` does NOT free the port;
kill by port with `Get-NetTCPConnection ... | Stop-Process`. Prod is `ssh cercle` (10.0.0.6,
ProxyJump canari); our audit branch is archived
(`archive/audit/security-and-canari-integration`) and must never be redeployed.

---

### PORTAIL-ETU (../refonte-portail-etu) - COMPLETE, nothing open

The avatar 502s closed 2026-08-06, verified on prod. Four facts survive the work:

- **The residual cause is UNKNOWN and is NOT an app defect**: for ~20 min the host could not open
  outbound connections at all (479 x bun `Unable to connect`). Everything was ruled out with
  measurements - **do not re-run any of them**: inbound rate-limiting, load, DNS/TLS/secrets, IPv6,
  conntrack, bun-vs-curl, and CrowdSec (refuted by its own evidence). What is left is the egress path
  upstream of the box. A recurrence is now timestamped in a clean, rotating log.
- **`deploy.yml` has a `workflow_dispatch`** and it is a keeper. An Actions outage drops push triggers
  outright and a lost trigger never comes back; a dispatch 500s while STILL creating the run, so check
  `gh run list` before re-dispatching. It skips the CI gate on purpose (the pre-push hook runs them).
- **No SSH to that box** - the self-hosted runner is the only way in, and the shape is a dispatch-only
  workflow then removed. The repo is **PUBLIC**, so every run log must redact - and `grep -a` is
  mandatory, the pm2 log holds binary bytes.
- **`pm2 flush`, never `rm`** - pm2 holds the fd.

The full legacy dump (12 databases, 24.4 MB) lives at
`../refonte-portail-etu/data-export/legacy-full-dump-2026-08-04.sql` - gitignored, PII, NEVER commit.
If it ever has to be redone: no SSH, only the CD runner (account `muselli`, passwordless sudo), and
the only usable MySQL credential is `/etc/mysql/debian.cnf` (a read-only `mysqldump@localhost` that
lacks `EVENT` on the `mysql` DB, so `--events` must be dropped).

---

### CANARI - THE TEST CAMPAIGN

**[campaign] CROSS-CLIENT TEST CAMPAIGN.** The whole plan AND the built harness are
**[cross-client-testing](docs/wiki/cross-client-testing.md)**, which OPENS with a "Where this campaign
stands" dashboard (phase table, every defect it produced and its state, what is left in order).
**Read that dashboard rather than re-deriving the state from here** - do not maintain a second copy.
One line: Phase 0/MSG/FWD/TAB complete, LIFE done except LIFE-5 (needs the user), NOTIF partly
(2/3, 5, 6 left, plus the NOTIF-10 re-run), then HEAL/PIN/MULTI/CORRUPT. What a compaction must not
lose:

- Runs against **PRODUCTION**, two real accounts, credentials in the scratchpad
  `test-accounts.json`, **never in the repo**.
- **The harness is BUILT, proven, and ARCHIVED IN THE REPO** at **`tools/cross-client-harness/`**
  (47 files, flat on purpose so every relative import and every `execFileSync('pin.mjs')` still
  resolves; its README covers the rig). The scratchpad copy is the working one for a live session,
  and also holds the ~60 one-shot `probe-*`/`*-triage` scripts deliberately left out of the archive.
  A later session REUSES these, it does not rebuild them. One `cdp.mjs` drives all three clients
  (W1 on 9224, W2 on 9223, A1's WebView on 9222 via `adb forward`); `a1.py` is only for native
  surfaces. W1 moved OFF the chrome-devtools MCP on purpose, so no password is ever a tool-call
  argument, and `test-accounts.json` is gitignored in both places.
- **A1 is signed in and PIN-unlocked.** Its device id is `tauri-d82cd226...-msgnk8nf-gyb2`; the DM
  under test is `642f389a-2800-412d-ab7c-cc521587f97f`. Check the APK's mtime before trusting a run,
  since the version name no longer moves.
- **Reading the phone, and flashing it.** **The version name is still 0.13.0, so it no longer
  distinguishes builds** - the discriminators are `lastUpdateTime` and, in the artefacts, Rust
  strings inside `libmines_app_lib.so`. Rebuild with `bun tauri android build --target aarch64
  --debug` in `frontend/`, install
  `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` (NOT
  `arm64/`, which holds a stale July APK) with `adb install -r`. Web assets are brotli-compressed
  inside the `.so`, so only RUST strings can be grepped there. The package is `fr.emse.canari`, NOT
  `fr.emse.canari.app`. **`am force-stop` is NOT "the user killed the app"**: Android's STOPPED state
  cancels every FCM broadcast until a manual launch (proven in logcat), so every killed-app cell must
  use a SWIPE from recents or `am kill` - and `am kill` does NOT reclaim a FOREGROUND process, so go
  HOME first and assert the death. The phone's whole web console is in logcat under `Tauri/Console`,
  which is how to read it while the WebView is unreachable; a busy device overruns the logcat ring in
  minutes, so capture continuously to a file rather than dumping after the fact.
- **Re-logging the phone in IS automatable**: the Android login opens the SYSTEM browser (`openUrl`),
  so forward CDP to `localabstract:chrome_devtools_remote` and run `login.mjs --match cas.emse.fr`.
  Never `realClick` the CAS fields (the hit test reaches "mot de passe oublie" on that layout) -
  focus by element and assert `activeElement`.
- **An offline RECEIVER cannot be faked in the browser** - `emulateNetworkConditions` fails every
  new request in 10 ms and W2 still rendered the message twice over. Cause not established; do not
  re-explain it. MSG-9 belongs on the phone (`svc wifi disable` + `svc data disable`), which needs
  adb on **USB** - the wireless transport dies with the wifi, and this device's USB link drops on
  its own, so re-do the `forward` and wake the screen before every phone run.
- **A green check's observation log is where two shipped bugs came from.** MSG-6 passed while its
  log carried a `400` on `/api/mls/link-preview` - which turned out to be every URL containing a
  closing bracket being truncated. Read the noise; that is the whole point of section 9.
- **RECONCILIATION is the only way this campaign's loss class can be SEEN**, and `recon.mjs` does
  it: markers on W1 diffed against markers on W2 for one thread. Re-run it after any batch of sends;
  a green per-check verdict cannot substitute for it - it is what found WP-LOSS-1 and WP-ECHO-1.
  **Two corrections it needed:** the message list is VIRTUALISED, so reading `innerText` once after
  scrolling to the top returns a single screenful and drops the rest (it must accumulate at every
  scroll position); and each side loads a different amount, so the diff must be BOUNDED to the time
  window both cover, using the timestamp baked into every marker. Before those fixes it reported two
  messages as permanently lost when both were present. **A diff between unequal windows looks
  authoritative and is noise.**
- **The phone's IP moves between sessions** (it has already changed subnet). `watch.mjs` therefore
  RESOLVES the adb serial from `adb devices`, preferring the wireless entry over USB; never
  hard-code it again. **USB ADB drops on this phone** - promote to `adb tcpip 5555` +
  `adb connect <ip>:5555` at once, and never bind a long capture to the USB serial.
- **The two browsers MUST be relaunched with occlusion detection off** if they are ever restarted:
  `--disable-features=CalculateNativeWinOcclusion,ChromeWhatsNewUI --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`,
  plus `--user-data-dir=<scratchpad>/chrome-w1|w2`. **A page Chrome considers HIDDEN discards every
  input event**, and native occlusion detection marks a fully covered window hidden while
  `windowState` stays `normal` - that, not any framework quirk, is why a synthetic click could reach
  an element and fire nothing. Consequence: a backgrounded tab must be made by focusing another TAB,
  never by covering the window. A relaunch keeps the login (persistent profile) but re-locks the PIN
  - `pin.mjs` handles it. On the mobile PIN modal use `Saisie manuelle`, because the keypad has no
  readable buffer.
- **OBSERVATION IS PART OF EVERY CHECK, not a debugging step** (`watch.mjs`, wiki section 9). A
  verdict is `PASS` only if the assertions hold AND the run is clean - errors, 4xx, page exceptions,
  WS events, `notable` MLS lines, `stateChanges` and anything `unexplained` are reported next to it.
  A line that turns out to be routine is ADDED to the benign list, never ignored in place.
- **TWENTY-FIVE harness faults have produced a false result, all fixed, and every one is written up
  in the wiki page** (search "harness fault"). Do not re-derive them - collectively they say four
  rules,
  and these are the ones to apply without opening it:
  - **A check that puts the app through a transition must restore every precondition that transition
    destroys.** A kill, a reboot, a radio cycle and an `install -r` all re-lock the PIN, and #22 read
    a whole 69 s verdict through the modal - it would have returned the identical FAIL against a
    fixed build. **A precondition found by one check belongs to every check sharing the transition.**
  - **An action that cannot prove it took effect still yields a verdict**, and that verdict is
    fiction. Every action asserts its own post-condition (`send` fails if the composer still holds
    text; a kill asserts the process died), because the faults were a kill that killed nothing, a
    "relaunch" that was a new tab, a dump too large to read scored as "no notification", and a
    `pidof` that exits 1 exactly when the thing it measures happens.
  - **"Did the state change" is almost never the assertion; "did it change into the RIGHT state" is.**
    The PDF pinch check asserted `width% 100 -> 300` - true, real, and identical for a build that
    zooms about the top edge and one that zooms about your fingers, which is exactly what the user
    reported minutes later (fault #23). A check must be validated as a NEGATIVE CONTROL against the
    unfixed build before its green means anything, and its tolerance set from those two measurements
    rather than from taste - the intermediate fix here cut the drift from 1370 px to 49 px, which a
    human spot-check calls fixed and a 12 px tolerance correctly refused.
  - **Assume a green check is wrong until its evidence says otherwise - and a FAIL too.** MSG-4
    passed on a fixture with invalid PNG CRCs (a broken `<img>` keeps its `src`, hence
    `naturalWidth > 0`); check M failed only because it looked for a `<canvas>` where the preview is
    an `<img>`; MSG-8b invented an app-level loss out of an unsent draft. **Check the fixture and the
    selector before blaming the app.**
  - **CDP's Network domain is BLIND to the app's own requests on mobile.** `hooks.client.ts`
    replaces `window.fetch` with the Tauri HTTP plugin's, which is a RUST client, so nothing it
    sends ever touches the WebView's network stack: `Network.responseReceived` reported NOTHING
    while the app was demonstrably fetching a 200. Record from INSIDE the page (wrap `window.fetch`
    and read the log back) - and for the same reason `emulateNetworkConditions` cannot fail an app
    request either, so inject the failure in the page too. Keep such navigation CLIENT-SIDE, or the
    document reloads and takes the patch with it.
  - **A locator is a guess unless it is disambiguated - and a DEVICE is a locator**: `u2.connect()`
    with no serial raises the moment the phone is attached over both USB and wifi, which every long
    run makes true; `/json/list` is not creation order, a document-wide text match hits the first
    hidden action row, a tie picks the scroll container over its button, and an `aria-label` must
    never outrank visible text. **A selector shared by two surfaces is not a post-condition either**:
    `.chat-composer-editor` belongs to the shared `MentionComposerInput`, so it is on `/posts` too
    and "the composer is on screen" was TRUE on the social feed - `send()` would have typed its
    marker into a comment box on somebody's post. Every use is now scoped to
    `.chat-composer-footer .chat-composer-editor`. **And a locator failure does not bias the verdict
    in a predictable direction** - faults #24/#25 came from the same hour and landed opposite ways: a
    `/zoom/i` selector matched nothing (the label is `Agrandir`), so a check returned PASS on a zoom
    ladder it never walked, while `article`/`data-post-id` matched nothing in the feed (`PostCard`'s
    root is `group/card`), so another returned FAIL against a page that was visibly rendering posts.
    **Name an element from the component source, never from what the markup ought to be.**
- **The venue is a NEW COMMUNITY, `Campagne de test`, not a channel in MiTV** - a private channel is
  still readable by every association admin, and no association has jolan as sole admin. Two members
  only. Section 11 of the wiki page says why; do not re-derive it.
- **Restore Firefox as the device's default browser when the campaign ends**
  (`cmd role add-role-holder android.app.role.BROWSER org.mozilla.firefox`); it was switched to
  Chrome because Firefox exposes no CDP.

A check that FAILS earns a WP with its captured log; a check that passes earns a row in section 10
and nothing else.

**A BROKEN GROUP HAS ONLY EVER BEEN SEEN HEAL ON THE PHONE.** Asked by the user 2026-08-06: the same
repair must be measured on the BROWSER. Four checks - epoch gap, unknown group, generation gap, and
the pair nothing has ever exercised together (a recovery while a SECOND tab holds the leader role) -
are section 7.1 of [cross-client-testing](docs/wiki/cross-client-testing.md). The break is a RESTORED
older snapshot of `CanariDBMls_<dev>`; take the snapshot first. Both browsers must be RELOADED first.

**[device] The verification pass is NOT a Work Package.** Everything native is verified by COMPILING,
which proves nothing about running, and the whole owed list lives in
**[device-verification](docs/wiki/device-verification.md)** - checks B-P, the build to install, the
verdict log line of each, and the PASS/owed table. Android passed the ladder on v0.11.7; **iOS has
never run one check on hardware**. Owed on both: H (deep link into the conversation), K (quick
reply), L (revoked device re-enrolling), N (offline unlock + promotion), O (the store/update
destination, what is left of WP-STORE-1), P (the iOS cookie jar). **Open a WP only when a check
FAILS**, and only with its captured log. Capture tool: `test_adb.py` at the repo root.
The four human checks left from the SEO work are the same shape -
[seo > what no test here can prove](docs/wiki/frontend/seo.md#what-no-test-here-can-prove).

**Release status:** v0.13.1 released 2026-08-07, all five workflows green, four artefacts attached,
prod answering `{"version":"0.13.1"}`. **`minClientVersion` stays at 0.13.0 on purpose**: the store
rollout has not reached devices, and raising it first locks everyone out.

---

### CANARI - OPEN WORK PACKAGES

- \[ \] **WP-LOSS-1 (P1) - both halves SHIPPED; what is left is verification.** A reload rewound the
  sender's ratchet and the receiver silently dropped the next message. Root cause, the tables, the
  retired hypotheses and both halves of the fix are in
  [cross-client-testing > root cause](docs/wiki/cross-client-testing.md#root-cause-found-2026-08-06-a-reload-rewinds-the-senders-ratchet).
  Do not re-derive it, and do not re-open the load hypothesis or "forwarding is special": both are
  dead. The sender half is VERIFIED on prod (3/3 delivered where it lost 2/2) - do not re-verify it.
  **Owed:** a LOSS-branch verification (no reproduction has produced one since the sender fixes
  landed, which is itself the point); the **ANDROID** half - the code is on the device but no phone
  run has exercised either branch. **Two deliberate gaps, not defects:** the `recentSends` ring dies
  on a reload, and nothing tells the receiver's USER that a message was lost.

- \[ \] **WP-PENDING-1 (P1) - fixed and deployed; the ONE verification owed is against a REAL
  backlog.** A single `AbortController(10_000)` wrapped a whole paginated pull, so a backlog bigger
  than 10 s of transfer aborted forever, ACKed nothing, and only grew. Now a deadline per PAGE, each
  page ingested and ACKed as it lands. **The server hypothesis is dead** - 8.909 ms on the composite
  `(recipientId, deviceId)` index. **The verification cannot be re-run on A1** (that phone's backlog
  was deleted to prove the cause), so it needs a device that falls behind again. The trap that cost
  three runs: the abort surfaces on Android as `TypeError: Failed to fetch` plus orphaned
  `Uncaught (in promise) The resource id NNNN is invalid` - indistinguishable from a network failure
  by text alone.

- \[ \] **WP-PENDING-2 (P1) - fixed, SEEN firing end to end, conversation HEALED.** Write-up in
  [cross-client-testing](docs/wiki/cross-client-testing.md#root-cause-a-generation-gap-answered-by-an-epoch-verdict);
  the rule is in DURABLE RULES (epoch and generation are different axes). **The reason this stays
  open:** `map_decrypt_outcome` in `src-tauri/src/state.rs` - the BATCH path used by history replay -
  still answers `ok: true, data: None` on `SecretReuse`, the same "a native layer threw the diagnosis
  away" that hid this bug for a day.

- \[ \] **WP-ECHO-1 (P2) - the SENDER loses its own message across a reload. FIXED (`214592e5`);
  the VERIFICATION is owed.** The loss is inside `addMessageToChat`: the `bulkIngestActive` early
  return buffers and returns BEFORE `saveMessage`, the flag is raised on EVERY inbound drain, and the
  buffer is cleared without flushing by a second drain and by `resetMessageCatchupState`. The outbox
  cannot repair it - `persistSent` -> `findMessage` only scans `conversations`, which a buffered
  message never reached. That also explains the MSG-10 asymmetry (offline there is no inbound drain).
  **Owed: re-run `recon.mjs` over a batch of sends made DURING a drain** - and the phone, which
  shares the composable. Distinct from WP-LOSS-1 (which loses it at the receiver); do not merge them.

- \[ \] **WP-RELOAD-DL-1 (P3) - fixed 2026-08-07; the ON-DEVICE verification is owed** (see the APK
  gate above). A WebView reload replayed a launch deep link fifteen minutes old, because the guard
  against replaying it was a module variable, which a reload wipes. Fixed by
  `$lib/mobile/deepLinkClaims.ts` (`sessionStorage`, whose lifetime is exactly the plugin's).

- \[ \] **WP-STORAGE-1 (P2 today, P1 the moment usage grows) - THE BACKUP SCHEME FAILS BEFORE THE
  DATA DOES.** Answer to the user's question of 2026-08-06 ("can the server hold several hundred
  users"). The whole model, every measured unit cost and the three scenarios are in
  **[storage-forecast](docs/wiki/infrastructure/storage-forecast.md)** - do not re-derive or
  re-measure it. The one sentence: `backup.sh` tars the ENTIRE MinIO volume nightly and keeps 15
  copies, so every live byte costs **16 bytes** on a 125 GB disk, and at 400 daily users the disk
  fills in **9 to 34 days** in EVERY scenario. Media are 87 % of the total; encrypted blobs are
  incompressible, so gzip buys nothing and dedup buys everything. **Ordered actions, highest leverage
  first:** (1) stop re-archiving MinIO nightly - use `restic`/`borg`/`rclone sync`, keep the 14-day
  full scheme for the 29 MB `pg_dump`; config only, and it divides the requirement by ~16; (2) cap +
  re-encode images CLIENT-SIDE before encryption in `frontend/src/lib/media.ts` (measured p90
  4.25 MB, max 8.06 MB - raw phone photos), the only lever that touches the live figure; (3)
  content-linked media deletion, which does not exist at all today - message delete and account
  delete leave the blobs, a GDPR point as much as a storage one; (4) Redis `maxmemory` +
  `volatile-lru` (it is `0`/`noeviction` today); (5) autovacuum on `queued_message`. `docker system
  prune` frees 5.45 GB right now. **One thing needs the USER, not a fix:** media are GC'd after 30
  days of no access, so a new device or a reinstall sees no image older than 30 days, silently. That
  is what makes the forecast survivable and it may not be intended - section 6 of the page.

- \[ \] **WP-DRAIN-2 (P2) - the inbound drain still has no watchdog, so ANY hung await inside it
  stops every inbound message with no diagnostic.** `isDraining` is lowered only when the message
  callback RETURNS, and two different awaits inside it have already frozen all inbound traffic - a
  `requestAnimationFrame` yield in a hidden document, and a recovery re-acquiring the MLS mutex the
  drain holds. Each was fixed in place; the SHAPE was not. The flush belongs behind
  `isDraining = false`, or the queue needs a watchdog that reports a drain that never completed.
  Nothing type-checks that the next await added there is safe.

- \[ \] **WP-VIEWER-1 (P2) - UNIFY THE IMAGE LIGHTBOX AND THE PDF READER.** Asked by the user
  2026-08-07: "c'est presque la meme interface, ca meriterait d'etre joli, pratique et homogene".
  Two full-screen modals with the same job and two different implementations of every part of it:
  `shared/MediaLightbox.svelte` (417 lines) and `shared/PdfViewerModal.svelte` (~380). **The
  gestures are the concrete debt**: the lightbox has a MATURE pinch/pan - `zoomAt` with a focal
  point, clamped translation, drag panning, wheel zoom, a percentage readout - while the PDF reader
  had none at all until 2026-08-07. **The START of the shared gesture now EXISTS and is the thing to
  build on, not to redo**: `utils/pinchZoom.ts` (pure, 16 tests) carries `focalScroll`,
  `nearestStepIndex` and the touch geometry, and the PDF reader consumes it - the user reported the
  same day that pinching zoomed "pas a l'endroit qu'on veut", which was the missing focal point, and
  it is fixed on both halves of the gesture (live `transform-origin`, then a scroll correction after
  `tick()`). Reasoning and the MiGallery equivalence are in
  [posts > the pinch](docs/wiki/frontend/modules/posts.md#the-pinch-and-why-it-needs-a-focal-point).
  **What is still owed is the UNIFICATION**, and the real difference to respect while doing it: a
  photo is one bitmap that may be scaled continuously about its centre, a PDF page is RE-RASTERISED
  per zoom level (sharp text is the whole reason pages are not upscaled) and lives in a SCROLLING
  column, so the shared gesture must expose a continuous live scale AND a settle callback the PDF
  binds to its step list - a single translate model cannot serve both. Chrome to share besides: the
  header (title, page/percentage readout, zoom pair, download, close), the safe-area padding, the
  backdrop + focus trap + Escape, and the download button routing through `utils/fileDownload.ts`.
  **Drag panning is still missing on the PDF at zoom > 1** (the scroll container is the only way to
  move), which the shared gesture should bring.

- \[ \] **WP-OIDC-TAB-1 (P3) - On Android the browser tab opened for the login is NEVER closed.**
  Reported by the user 2026-08-06 and reproduced during the WP-ANDROID-SESS-1 re-login: the app comes
  back to the foreground on the deep link, and the system browser is left sitting on the last
  Authentik page, which reads as "the login failed" to anyone who looks at it. Cause: `auth.ts`
  launches the flow with `openUrl` from `@tauri-apps/plugin-opener`, i.e. a plain browser launch -
  nothing can dismiss that tab afterwards, from inside or outside. The remedy is a **Chrome Custom
  Tab**, which the OS closes when the app resumes; that is a native change (the opener plugin has no
  such affordance), so scope it before starting. iOS has the same shape with
  `ASWebAuthenticationSession` as the equivalent, and it has never been checked on hardware.

- \[ \] **WP-SAFELINK-1 (P3) - Warn before opening a link Google Safe Browsing flags as unsafe.**
  Asked by the user 2026-08-07. Today `AppLink` (the terminal renderer for every external link in
  chat and posts, including the WP-LINK-1 bare-domain ones) opens whatever `href` it is given with
  zero safety check - a phishing or malware link pasted into a message reads identically to a
  legitimate one. The lookup MUST be server-side: a Safe Browsing API key is a secret and can never
  ship client-side, and there is already a precedent to extend rather than a new one to invent -
  `apps/chat-delivery-service/src/controllers/security.controller.ts` and `utils/url-guard.ts`
  already server-side-fetch and SSRF-guard every URL found in a message for the link-preview
  pipeline (`docs/wiki/services/chat-delivery.md`), so the server already learns which URLs are
  shared; a Safe Browsing lookup alongside that fetch is not a new privacy boundary crossed, only a
  second use of one already crossed. Not to re-litigate when scoping starts: **cache verdicts by
  URL with a TTL** (Safe Browsing has query quotas, and a per-render or per-click lookup would burn
  through them on the same handful of links); **decide fail-open vs fail-closed explicitly** for a
  timed-out or quota-exhausted lookup, the same shape of decision as an empty key elsewhere in this
  file - blocking every link because the safety service is unreachable is its own outage; and the
  warning belongs at the point of navigation INTENT (an interstitial only when a link is actually
  flagged), never decorating every rendered link, which would be alert fatigue for a check that is
  almost always going to say "fine".

**Known and deliberately NOT a WP yet** (do not "fix" these by reflex):

- A device holding SOME of a conversation, missing older messages, and never failing to decrypt
  carries no marker, so it never asks for history - it learns only by being someone else's elected
  responder (WP-HIST-3).
- **`history_request` is deliberately NOT made durable** the way `welcome_request` is (Redis + FCM):
  a stored request drained hours later has no digest (60 s MLS rendezvous), so the responder would
  fall back to the full-store dump WP-HIST-3 exists to remove, for a device that may need nothing -
  and the requester must reconnect to read anything anyway, which re-solicits. The related half: a
  missing Welcome BLOCKS a group, missing history only degrades it.
- **One MLS client in a SharedWorker**, shared by every tab (the successor to WP-MULTITAB-1). It
  would remove the class outright rather than gating each write path one at a time, and nothing
  type-checks that a new path went through the queue. Cost is why it is not the fix: the worker
  transport, startup, the PIN unlock and the Safari/mobile fallback where `SharedWorker` is absent
  all have to be redone. Evaluate relevance and cost before starting.

---

### CANARI - DURABLE RULES

One line per rule, with the page that carries the reasoning. If a rule needs a paragraph, the
paragraph belongs in `docs/wiki/` - put it there and leave the pointer here.

#### MLS state and keys -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [auth](docs/wiki/frontend/modules/auth.md)

Everything that touches the device key, the PIN, `mls.bin` or an unlock path is on those two pages.
The four traps worth seeing without opening one:

- An at-rest envelope change needs a reader for the previous format in the SAME commit.
- `isValidPin` (>= 4 chars) guards setup, change, recovery AND unlock - one rule, or a lockout.
- A status code is an ANSWER, a transport failure is not: only a 401/403 may log a user out, and
  `navigator.onLine` alone never proves reachability (a captive portal reports `true`).
- Offline unlock is only ever the paths that ALREADY skip the server check online (biometrics,
  vault); widening it to the PIN is a security change wearing a UX hat.

#### Community channels -> [chat](docs/wiki/frontend/modules/chat.md), [social-service](docs/wiki/services/social-service.md)

Deep links, system events, rosters and the channel/DM asymmetry are all on those two pages. The
three that must be seen without opening one:

- Never return a `Channel` entity to a client: it carries `masterSecret`. Project fields explicitly.
- `/c/<groupId>` and `/chat/<groupId>` are NOT routes; a conversation opens by publishing to `notifNav`.
- "A refresh ran" and "the list is current" are two different facts; a loader that conflates them
  empties the sidebar on one dropped request. Fail loudly in state, never by returning stale truth.

#### MLS membership and routing -> [mls-protocol](docs/wiki/protocols/mls-protocol.md), [chat-delivery](docs/wiki/services/chat-delivery.md)

- MLS membership says who can decrypt; `DeviceGroupMembership` says who is actually sent to.
- A join is NOT evidence of a gap: the message store and the seen-frame ledger are keyed by USER, so
  a rotated identity rejoins every group while the browser still holds every message.
- A durable marker must carry the EVIDENCE that justified it, or nothing can ever revisit the
  diagnosis; one written without evidence is legacy - drop it, do not replay it.
- A LIVENESS clock must be written by the thing whose liveness it measures. `updatedAt` answers "when
  was this row last written" and was asked "when was this device last seen" - so a peer's sync kept
  nine dead devices alive forever (WP-GHOST-1). Same shape as an epoch verdict answering a generation
  question: a column is only evidence for the question it was written to answer.
- A device good enough to be MESSAGED must be at least as valid as one good enough to be INVITED. The
  invitation path checks the key package, the fan-out does not - and the gap is where the ghosts live.
- An error says what it says: "this generation is consumed" is NOT "I already have this message".
  Keep the evidence that distinguishes them (the frame's own bytes) - and never let a native layer
  answer `Ok(None)` where the shared classifier could have decided.
- EPOCH and GENERATION are different axes, and so are their repairs: a commit replay heals an epoch
  gap and can do nothing for a ratchet one (`TooDistantInTheFuture`), which only a new epoch clears.
  A verdict computed over one axis must never answer a question asked about the other - `epoch >=
  activeEpoch` after applying ZERO commits is "there was nothing to replay", never "it is healed".
- A wrapper string carries BOTH markers (`GAP_QUEUED:<group>:<the real OpenMLS error>`), so the order
  of a substring classifier is a decision, not a formality.

#### Outbound delivery -> [chat](docs/wiki/frontend/modules/chat.md), [mobile](docs/wiki/frontend/mobile.md)

The queue, its barrier, the token rules and the native mirror are on those two pages. The three to
carry in the head:

- The outbox is best-effort at every step, so every swallowed branch logs - that is all a loss leaves.
- A tab is "read-only" only where something CHECKS: leadership gated the socket, not the queue, so
  the follower encrypted anyway. And gating a writer freezes its state - whoever inherits the role
  must reload it, or it resumes exactly as far behind as the tab it replaced had moved on.
- The inbound drain lowers `isDraining` only when the message callback RETURNS, so every await inside
  it is a potential freeze of all inbound traffic - and the recovery seams re-acquire the MLS mutex
  the drain already holds, so awaiting one there is a DEADLOCK, not a slow path. A repair whose
  result nobody reads (a re-add, a Welcome, an external join) must be STARTED, never awaited - and it
  must log how it settles. `DeferredRecovery` on the Welcome path is the same lesson, learnt earlier.
- `requestAnimationFrame` NEVER fires in a hidden document, so it can never be the only resolver of
  anything a background path awaits - and a "yield" that can hang is a deadlock, not a delay. Race it
  with a `MessageChannel` message; a timer fallback is clamped to ~1 Hz in the background.
- A deadline's SCOPE is part of its meaning: one budget over a paginated catch-up is a budget the
  devices that most need it can never meet, and an all-or-nothing pull makes each failure bigger than
  the last. Per page, ingested and ACKed as it lands - partial progress must be kept.
- MLS gives no echo of your OWN message, so the sender's optimistic update is the only writer it
  gets: apply it in memory AND persist it (`persistLocalMutation`), or it dies at the next load.
- A UI buffer placed IN FRONT of a persistence call is a persistence bug, not a rendering choice:
  it returns early, so the write never runs, and a buffer that can be cleared without flushing loses
  it for good. `addMessageToChat`'s bulk-ingest return did exactly this to the sender's own message
  (WP-ECHO-1). Buffer AFTER the durable write, and make every discard log what it dropped.
- The mirror is READ as well as written: a file one side rewrites wholesale silently deletes
  whatever the other side appended, so every such pair needs an adoption pass, not just a drain.
- **A REPAIR THAT RECORDS ITS OWN OUTPUT AS NEW INPUT HAS NO FIXED POINT.** A replay is not a send:
  re-noting one into `recentSends` under a fresh id and a fresh timestamp defeated the expiry AND
  the dedup at once, so a five-minute decaying buffer became a permanent playlist and a bounded
  repair became a standing broadcast (WP-RETRANSMIT-1, ~430 frames/min for 13 min on prod). Ask of
  every self-healing loop what makes it STOP, and make that the thing a test pins.
- A repair addressed by TIME is a broadcast, because a window cannot name its target - and it can
  only be as durable as what it reads. `decrypt_failed` asks for a window precisely because the
  frame never decrypted, so its id was never seen; that is why WP-HIST-3's manifest diff replaces it
  rather than being tuned.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md), [auth](docs/wiki/frontend/modules/auth.md) (native prompts)

Tokens, the one-way-colour sweep, the portalled dropdown, Svelte's whitespace trim and the native
prompt fields are all on those pages. What must not be forgotten between them:

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens - and the 31 the
  sweep left are DELIBERATE (switch thumbs, colour-picker handles, always-dark call/lightbox chrome,
  the white plate behind a QR). Do not "fix" them.
- Nothing types a string as user-visible, so no compiler enforces Paraglide - and no user-facing
  string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time).
- Re-run `bun run paraglide:compile` before `bun run test` after any build.
- **A promise that has REJECTED stays rejected, so an `{#await}` over one sits in `{:catch}` for the
  life of the component** - nothing re-enters `{:then}` but a new promise, i.e. a remount. State a
  RETRY writes must therefore be read from OUTSIDE the thing that failed: the feed read
  `postsOverride` only inside `{:then}`, so "Reessayer" fetched the posts (200 in 326 ms, measured)
  and had nowhere to render them, while leaving the page and coming back worked - which reads as a
  network fault and is not one. A retry whose result is only consulted on the success path of the
  failed attempt cannot work by construction. Not unit-testable here (the defect is purely WHERE the
  template reads its state, and there is no component-rendering setup) - `check-feed-retry.mjs`.
- A synchronous "unknown" PLACEHOLDER is indistinguishable from an answer once it is stored, so
  anything that later resolves the real value loses to it - and a module-level cache re-renders
  nothing when it warms, so whether a user ever sees the truth depends on cache timing. Return the
  absence (`peekUserDisplayName` -> `null`, or an explicit `*Resolved` flag), never the label.
- French inclusive writing and elided forms defeat a TLD-shape heuristic for "this looks like a
  domain" (`.es`/`.it`/`.re`/`.ne` collide with "auteur.rice"/"cher.e.s"-style endings) - an exact
  WHITELIST of real hosts sidesteps the ambiguity entirely instead of trying to out-narrow it
  (WP-LINK-1).

#### The public head, and the two adapters -> [frontend/seo](docs/wiki/frontend/seo.md), [nginx](docs/wiki/infrastructure/nginx.md)

The whole model - the injected head, the two escapers, the sitemap, the adapter split and the
fallback shell - is on those two pages, plus `BUILD_WEB` in
[frontend/architecture](docs/wiki/frontend/architecture.md). The four that cost a live outage:

- A crawler on this site sees NO content: Googlebot renders, but as an anonymous visitor, so what
  it renders is the login screen. The injected `<head>` is the whole indexable surface, and the
  SITEMAP is the entire link graph.
- CLOUDFLARE REPLACES the body of an origin 5xx with its own 16-byte page, so an `error_page`
  without `=` reaches nobody behind the tunnel. Measured 2026-08-05; hence `=200`.
- nginx does not TRUNCATE an oversized upstream header, it 502s - SvelteKit's
  `Link: rel=modulepreload` is ~7.5 KB against a 4 KB default `proxy_buffer_size`.
- A deploy being green proves the containers started, never that the site answers: probe the public
  URL for each SHAPE of path (root, an app route, a prerendered file, a dynamic endpoint).

#### Server-side fetches -> [chat-delivery](docs/wiki/services/chat-delivery.md), [nginx](docs/wiki/infrastructure/nginx.md)

The link-preview pipeline, the SSRF guard, the favicon cascade and the undici seam are on that page.
The three that generalise beyond it:

- An `<img src>` at a third party inside an E2E conversation tells that host who read and when.
  Proxying it is not a nicety - and the proxy is also the only thing checking the bytes are an image.
- `new URL(href, base)` RESOLVES hostile input rather than throwing - `javascript:` and `data:`
  survive as absolute URLs - so a try/catch around the parse guards nothing. Check the SCHEME.
- Serving a file is not serving it correctly: check the header, not the status code (nginx
  `mime.types` has no `.mjs`, so every ES-module asset went out as octet-stream).

#### Contracts the compiler does not check -> [development](docs/wiki/development.md)

Every unchecked seam - Tauri command names, plugin ACLs, `push_context.json`, `mlsWorkerProtocol.ts`,
`LoginErrorCode` - is enumerated there. Two to keep in the head:

- A cross-process contract is only as good as its test: pin the PATHS as well as the field names,
  or a writer on one OS fills a directory nothing ever reads.
- Never let a capability probe swallow its own failure, and never branch on an error MESSAGE.
- A plugin in `Cargo.toml` is not a plugin the app may CALL: Tauri v2 gates every plugin COMMAND
  behind `capabilities/`, and an ungranted one builds, ships and installs, then rejects on a real
  device. EVENTS are not gated - which is how `deep-link` worked warm and was dead cold for as long
  as the grant was missing. `tauriCapabilities.test.ts` is the guard.
- **A mocked repository never parses SQL**, so a query builder's output is unverified until a real
  Postgres sees it - and TypeORM does NOT preserve the order selects were declared in, so `DISTINCT`
  written into a `.select()` string lands mid-list once an `.addSelect()` follows (`.distinct(true)`
  is the only safe spelling). Where a test cannot reach, the DEPLOY LOG is the test.
- A batch of maintenance jobs must catch and log PER JOB. Sharing one try/catch means the first
  failure hides every job after it, and a GC that silently does nothing is indistinguishable from a
  GC with nothing to do. **The same holds for any observer list, and a COMMENT claiming the
  subscribers are independent is not independence** - `endBulkIngest` awaited them in one bare loop,
  so a failing checkpoint would have taken the UI's render buffer down with it (WP-RETRANSMIT-1).
  Isolation is a `try` per subscriber, or it does not exist.

#### Mobile and native -> [frontend/mobile](docs/wiki/frontend/mobile.md)

Push transports, the App Group, the NSE, the decrypt ladder and the update target are all on that
page. The five to carry, plus one status line:

- An app extension has its OWN data container: a path that is right in the app process is silently
  wrong in the NSE, and the App Group is the only shared storage.
- Background decrypt applies no commit, so a silent commit push leaves the next message unreadable -
  that is the epoch gap, not a bug to retry through.
- A Play-signed install and the GitHub-signed APK cannot update each other, and switching sides
  needs an uninstall that wipes `mls.bin` - so the update target is a RUNTIME fact, never a constant.
- `minClientVersion` is the ONLY thing that interrupts a user now; raising it before the store
  rollout has reached devices locks everyone out behind a button leading to the old version.
- Only user-VISIBLE native strings stay French; everything read while debugging is English.
- A path restriction written for iOS has NO effect on Android: the App Link claim lives in a
  different file per platform and `assetlinks.json` has no notion of a path, so the lists are
  GENERATED from one source. A host with no path attribute claims the whole host.
- A CSS custom property consumed at TWO nesting depths applies its correction TWICE if both
  consumers independently subtract the same inset: `.app-layout` re-pinned itself to
  `--app-viewport-height` even though its own ancestor chain was already correctly shrunk by that
  same variable structurally (`padding-top`), leaving a gap the height of the status bar (WP-KBD-1).
  The fix is not making the second consumer's math right - it is deleting the second consumer.
- Edge-to-edge on Android is NOT guaranteed by `env(safe-area-inset-*)` alone: whether the OS
  populates it depends on OS-enforced defaults (`targetSdk` 35+ on Android 15+) that some OEMs
  (seen on Xiaomi/HyperOS) do not honor consistently for a WebView. Call `enableEdgeToEdge()`
  explicitly in `onCreate` rather than relying on version-gated enforcement to make the insets this
  app's CSS already assumes everywhere actually show up.
- **`fetch` IS NOT `fetch` in the WebView**: `hooks.client.ts` replaces `window.fetch` with the Tauri
  HTTP plugin's, which is a NETWORK client and rejects every non-`http(s)` scheme with
  `scheme <x> not supported` - a bare rejection that reads as a dead network. The routing rule must
  name what the plugin CAN do, never the exceptions: written as an exception list it missed `blob:`,
  and since saving an attachment reads its object URL back, EVERY download on both platforms failed
  while the ACL, the save dialog and `fs.writeFile` were all correct. `utils/fetchRouting.ts`, pure
  and tested. `XMLHttpRequest` is not patched - a passing XHR beside a failing `fetch` is the
  fingerprint.
- A WEBVIEW HAS NO DOWNLOAD MANAGER: `<a download>` is a silent no-op on Android and iOS alike
  (Tauri installs neither a `DownloadListener` nor a `WKDownloadDelegate`), and the click still
  "succeeds", so there is no exception and no log - eleven buttons shipped dead. Everything saving a
  file goes through `$lib/utils/fileDownload.ts`. Never ask for a DIRECTORY on mobile (Android's SAF
  has only a document picker), and remember `fs:default` is READ-ONLY - the plugin being named in
  the capability file grants no write.
- A decision reachable from the CLEARTEXT push fields must never sit behind the decrypt ladder: an
  early return on "could not decrypt" silently swallows every action that never needed the plaintext
  (WP-NOTIF-1). And parity between the platforms is not parity of declarations - iOS was correct here
  and Android was not, differing only in WHERE an early return sat.
- `getCurrent()` answers "the last deep link this PROCESS was handed", never "the app was just
  started by one" - the Rust plugin holds it for the life of the process, so every re-read must be
  deduplicated. **And STATE WHOSE JOB IS TO SURVIVE AN EVENT MUST NOT LIVE WHERE THAT EVENT DESTROYS
  IT**: the guard was a module variable, which a WebView reload wipes, so the reload replayed a
  15-minute-old launch URL (WP-RELOAD-DL-1). "Module variable" is a LIFETIME, not a detail - pick it
  against the event, here `sessionStorage`, which matches the plugin's own boundary.

**Android/iOS parity: CODE audited 2026-08-03 (v0.12.0, file by file), CONFIGURATION audited
2026-08-07.** Do not re-audit either - the table of every surface, what each is guarded by, and the
OS-imposed asymmetries that are NOT defects, is
[mobile > parity](docs/wiki/frontend/mobile.md#android--ios-parity-and-where-it-is-actually-guaranteed).
**iOS cannot be tested for a long while (user, 2026-08-07), so parity is maintained BY
CONSTRUCTION**: one shared file wherever the platforms can share one, a test reading both trees
wherever they cannot. Every parity defect ever found has been in CONFIGURATION, never in code -
the `/auth/callback` capture (`56fc6129`), the missing `deep-link` ACL (WP-DEEPLINK-1, which broke
BOTH platforms), and `applinks:www.canari-emse.fr` claimed on iOS alone though `www` 301s and Apple
does not follow redirects (fixed 2026-08-07, now asserted by `appSiteAssociation.test.ts`).
**A no-op on one platform must say WHY**: "nothing to do" and "there is no API and nobody has
looked" are different, and only the first is evidence - the iOS cookie jar is the second, and is now
`check P`.

#### Release and CI -> [cicd](docs/wiki/cicd.md)

Signing, the bump script, the secrets and every compile-check trick are on that page. The three
that decide whether you believe a run:

- A manual `workflow_dispatch` run of either release workflow is a pure compile check that ships
  nothing - and the ONLY way to compile Swift/ObjC/Kotlin from Windows. Run both before believing
  any native change.
- A green run is not proof YOUR file compiled: the iOS pbxproj is hand-maintained, so grep the log
  for `SwiftCompile`/`CompileC` on the file. (iOS only - Gradle cannot skip a source set.)
- The CD regenerates `infrastructure/.env` from the repo secrets, so a value set over SSH lasts until
  the next deploy. A credential is only real once it is a GitHub secret AND named in `cd.yml`.
- A generated file the repo COMMITS needs both halves or neither: the bump must patch it, and
  `.gitignore` must really keep it - a later `*.lock` silently overrode the `!` written above it,
  and a lock nothing bumps is corrected by whatever unrelated commit next runs cargo.

#### Carte de la Vie Asso -> [carte-vie-asso](docs/wiki/carte-vie-asso.md)

The contract with the Portail, and every rendering trap (text sizing, the PDF anchor, the split
watermark, Preflight), are on that page. The three that decide the contract:

- A published carte is the poster RESOLVED (poster px + `stage`), never fractions and never a layout.
  The showcase decides nothing: what it is not told, it cannot copy.
- Association identity joins live; the displayed members are a snapshot, so a roster edit republishes.
- The two repos must agree on the FONTS, or every measured box is wrong.

#### Associations and agenda -> [social-service](docs/wiki/services/social-service.md)

- A second surface for an existing action mirrors the SERVER's rule, not the first surface's:
  the association page gates on `PROPOSE_EVENT` there, the server also lets any BDE
  `VALIDATE_EVENTS` holder edit any event - so that holder had the right and nowhere to use it.
- What a modal hides because it is redundant is a decision of the PAGE, never of `canEdit`.

#### Cotisations (Cercle) -> [cotisations](docs/wiki/cotisations.md)

The page carries the tier model, the webhook ladder and everything debugging the live link cost.
The two that are security, not plumbing:

- The tier XOR has ONE implementation, `UserTagService.revokeSiblingTierTags`, and a tag revoke MUST
  be scoped to `issuingAssocId` or it is a cross-tenant IDOR.
- A product entity carries `webhookSecret` and `/products/all` answers every logged-in user - same
  lesson as `Channel.masterSecret`. `toSafeProduct` is the one seam, and a guard is a decorator
  nothing type-checks, so assert the metadata.

#### Working in the Cercle repo -> `../le-cercle/AGENTS.md`, and the VEILLE loop above

That file is the contract for THAT repo - the per-action guard, the 403 rather than a redirect, the
empty signing key, the rollback that throws a success value, the date model, the `bun:sqlite` and
migration traps, the run-time config rule. Read it there; re-copying it here only makes the two
drift. One thing it cannot say from inside: a duplicate migration NUMBER is loud, not silent
(`exit(1)` before applying anything) - but only once both branches have merged, so check the highest
number on `main` before naming a file.

#### Sessions, in every app -> [sessions](docs/wiki/sessions.md)

Settled 2026-08-04 by WP-SESS-1 and WP-SESS-2, SHIPPED in all four apps. The whole model and every
rule it cost is on that page - read it before touching any login, cookie or rotation.

- A cookie whose content IS the identity it claims is not a credential, it is a form field.
- A replayed rotating token is TWO holders of one cookie: revoke the session - but only with a grace
  window, and settle the race in ONE conditional `UPDATE`, never read-then-write.
- An empty key can fail OPEN or CLOSED and you cannot guess which. Decide explicitly.
- Rotation makes DURABILITY part of the protocol: a client that loses the new token does not just
  fail to refresh, it gets revoked. Force the write where the rotation happens, and AWAIT it - on
  Android the cookie jar reaches disk only on `CookieManager.flush()`, and a kill with no lifecycle
  callback rewinds it one generation.
- A dead session is an ANSWER: never retry the request anonymously, or "you are logged out" renders
  as "there is nothing here". Reach the verdict in one place and announce it from there - every
  caller that re-decides is a path that can forget.
- A one-shot announcement and a late subscriber are a RACE: replay the verdict to whoever registers
  after it. A fallback only covers the race if it does everything the real handler does, which it
  never does - ours redirected without closing the PIN modal, so `/login` arrived unusable.

---

### SHARED GOTCHAS -> [development](docs/wiki/development.md), [cicd](docs/wiki/cicd.md)

- Bash-tool commit messages: use a heredoc or `git commit -F file`, NOT PowerShell `@'...'@`.
- **Postgres stores UTC and the prod host is `Europe/Paris` (CEST, +0200)**, so a DB timestamp is two
  hours behind the wall clock a test just wrote down - `18:09:47` in `queued_message` IS the
  `20:09:47` send. Both are CORRECT (`timedatectl` = CEST, `SHOW timezone` = UTC); do not "fix" the
  server clock, it would move the 03:30 backup cron and break every log correlation. Convert.
- MiConnect 2FA remembers the device for 8 h, so a later login only needs the code. If the CAS page
  stalls after Esup Auth accepts, go BACK to the browser tab and reload; ask the user rather than
  looping.
- A live credential is not a debugging input: reading the phone's cookie jar is refused, and the
  answer came from a probe that never touched the token. Reach for the observable, not the secret.
- Android Rust compiles from Windows: `NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125`, put
  `toolchains/llvm/prebuilt/windows-x86_64/bin` on PATH, `CC_aarch64_linux_android=aarch64-linux-android24-clang.cmd`,
  then `cargo check --target aarch64-linux-android`. It is the only local check of `#[cfg(android)]`
  code - and it proves compilation, never that a JNI `FindClass` resolves at runtime.
- Backend lint needs `npm install` in the app dir (bare `oxlint`/`oxfmt` + repo-level configs).
- The pre-commit hook sweeps the WHOLE frontend and re-stages - isolate unrelated dirty files.
- Before push: `rm -rf apps/*/dist`, then `git pull --rebase --autostash origin main`.
- Commit signing is ON globally over SSH - all commits Verified, do NOT disable.
- Never assert a wall clock in a test; two isolated browser contexts = two devices.
- Portail: SPA (`ssr = false`); `data-export/` holds PII, never commit.
- Sky UI French must keep accents + straight apostrophes.
