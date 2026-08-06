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
- Frontend gates (before every commit): bun run check (0 errors), bun run lint, bun run format. Rust >= 1.93 (`rust-toolchain.toml`). cargo clippy for Rust crates. Pre-commit hook runs oxfmt+oxlint+oxvelte+check across WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

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

---

### LE CERCLE (../le-cercle) - MR !4 PUSHED, AWAITING AUREL

**!3 MERGED 2026-08-04** into `main` (`385c15e`), with 5 commits of Aurel's on top - our branch is
rebased on all of it.

**MR !4** - `chore/project-conventions`, 13 commits, rebased onto `main` and pushed 2026-08-05 -
https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/4
**Description still to PASTE by hand: `../MR-CERCLE-2.md`** - which also carries what !4 contains and
every decision behind it, so do not re-litigate any of them from here. Git refuses a push option
containing newlines, so `merge_request.description` is unusable, while `merge_request.create` +
`.target_branch` + `.title` over SSH DO work (that is how !4 was opened, no `glab`, no token).
Gates at that push: `check` 5009 files 0 errors, lint clean, `bun test` 31/31, `bun run build`, and a
fresh DB `create -> migrate -> seed -> check` = 20 accounts reconciled, exit 0.

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
`CANARI_INTEGRATION_ENABLED` sits in the deployed `.env` and is
referenced NOWHERE since the rewrite - dead, not a switch. Never test the Canari link against the
DEV server: `$env/dynamic/private` there came from a stale process and read the OLD `.env`, silently
disabling it - build, then `bun ./build/index.js` with the env explicit on the command line.
`TaskStop` does NOT free the port; kill by port with `Get-NetTCPConnection ... | Stop-Process`.
Prod is `ssh cercle` (10.0.0.6, ProxyJump canari); our audit branch is archived
(`archive/audit/security-and-canari-integration`) and must never be redeployed.

---

### PORTAIL-ETU (../refonte-portail-etu) - ONE WP OPEN: a fix is PUSHED but NEVER DEPLOYED

- \[ \] **WP-PORTAIL-AVATAR-1 (P2) - `2b390c4` is on `main` and has never reached the server.**
  **The DIAGNOSIS IS CLOSED - do not re-derive it.** 2026-08-06, bursts of HTTP 502 on
  `/api/users/:id/avatar`: it is the route's own `catch`, not nginx and not a rate limit on the
  visitor (empty body, while `/api/users/!!!/avatar` answers 400). 479 recorded failures, all one
  message - `Unable to connect` on a well-formed URL, so neither DNS, TLS nor the secrets - and all
  inside the last 19k lines of a 1,925,156-line append-only log, in bursts (469 of 478 gaps = exactly
  6 lines). **ONE episode, not a chronic fault.** The host reaches MiGallery fine over IPv4 (401 in
  75-127 ms, 8/8 bun calls). **The IPv6 lead is DEAD**: no global IPv6 address, so `AI_ADDRCONFIG`
  keeps AAAA out of an ordinary lookup. The residual cause is the host's outbound path, NOT an app
  defect - and the wiki already records that this host cannot reach `canari-emse.fr` server-side
  (hairpin NAT); the avatar proxy is its ONLY server-side fetch.
  **What `2b390c4` fixes is the amplification only**: with no cache a page of N members opened N
  connections per visitor per visit. In-process cache (1 h image / 10 min absence / 500 entries,
  injected clock), `X-Cache: hit|miss` to verify from outside, `isCacheableAbsence` so only a literal
  404 is stored (`!res.ok` reads like "no avatar" and is not), and a transport failure stays a 502
  `no-store`. `9073a03` added `time: true` to `ecosystem.config.cjs`. Gates green, 19/19 tests.
  **OWED - two commands, both refused to me by the classifier, so a HUMAN runs them** (in
  `../refonte-portail-etu`; a dispatch 500s intermittently during the outage and a 500 STILL creates
  the run, so check `gh run list` before re-dispatching):
  1. **`gh workflow run deploy.yml --ref main`** - `deploy.yml` gained `workflow_dispatch` in
     `02953af` because the outage drops push triggers outright (`Run Tests` cancelled in queue ->
     `Deploy` skipped -> a lost trigger never comes back). Its `if:` gained a branch with it: a manual
     run has no `github.event.workflow_run`, so the old condition alone would have skipped the job
     silently. **This path skips the CI gate on purpose** - the pre-push hook runs lint, format,
     check, test and build locally.
  2. **`gh workflow run clean-pm2-logs.yml --ref main`** - to finish the rotation, see below.
  3. **Then verify**: `X-Cache: miss` then `hit` on the avatar endpoint. Prod currently returns **no
     `X-Cache`** at all, which is the proof it is not deployed (it still runs the 2026-08-04 build).
  4. **Then DELETE both one-off workflows** (`clean-pm2-logs.yml`, and `deploy.yml`'s dispatch is a
     keeper).

  **LOGS: DONE 2026-08-06.** 117 MB error + 131 MB out flushed to 0 via `pm2 flush` (**never `rm`** -
  pm2 holds the fd), tail archived at `~/pm2-archive/portail-etu-error-20260806-204729.log.gz`. ~1.9M
  of those lines were the LEGACY portal's, under the same pm2 app name (`mysql2`,
  `/api/users/login/...`, 74,693 x `Unknown column 'r.hiererarchy'`) - none of it in this repo.
  **Rotation is NOT active yet**: `pm2 install pm2-logrotate` died on `ConnectionRefused downloading
  package manifest`; `clean-pm2-logs.yml` now retries it 5 times (`02953af`).

  **NEW EVIDENCE on the residual cause, and it is the thread to pull next:** that `ConnectionRefused`
  was to the **npm registry**, from **bun**, at a moment when `curl` succeeded in the same run. So the
  intermittent outbound failure is NOT specific to MiGallery, and may well be specific to bun's HTTP
  client on that host rather than to the network itself.
  **Access, which is the whole difficulty:** no SSH to that box; the self-hosted runner is the ONLY
  way in; the repo is **PUBLIC**, so any run log must redact (`grep -a` is mandatory - the log holds
  binary bytes, and `grep -c` counted 479 while `grep -A3` printed nothing with its stderr hidden).
  Precedent for the shape: a one-off dispatch-only workflow, then removed (`d986062`/`d128501`, and
  mine `928bd0c` -> `2b390c4`).

### PORTAIL-ETU - otherwise COMPLETE

The full legacy dump (12 databases, 24.4 MB) lives at
`../refonte-portail-etu/data-export/legacy-full-dump-2026-08-04.sql` - gitignored, PII, NEVER commit.
If it ever has to be redone: there is no SSH to that box, only the self-hosted CD runner (account
`muselli`, passwordless sudo), and the only usable MySQL credential is `/etc/mysql/debian.cnf` (a
read-only `mysqldump@localhost` that lacks `EVENT` on the `mysql` DB, so `--events` must be dropped).

---

### CANARI - OPEN WORK PACKAGES

**[campaign] CROSS-CLIENT TEST CAMPAIGN - ACTIVE, Phase 0 nearly closed 2026-08-05.** The whole
plan AND the built harness are **[cross-client-testing](docs/wiki/cross-client-testing.md)** -
sections 1.1 (harness), 7 (real artefact names) and 11 (Phase 0 progress + what it cost). Do not
re-plan or re-derive any of it from here. What a compaction must not lose:

- Runs against **PRODUCTION**, two real accounts, credentials in the scratchpad
  `test-accounts.json`, **never in the repo**.
- **The harness is BUILT and proven**, at
  `C:\Users\jolan\AppData\Local\Temp\claude\c--Users-jolan-Documents-Programmation-canari\3dd9d8ba-077b-47ad-9f1d-33bb94f62dcd\scratchpad\`.
  Those files persist on disk - a later session REUSES them, it does not rebuild them. One
  `cdp.mjs` drives all three clients (W1 on 9224, W2 on 9223, A1's WebView on 9222 via
  `adb forward`); `a1.py` is only for native surfaces. W1 moved OFF the chrome-devtools MCP on
  purpose, so no password is ever a tool-call argument.
- **THE TAB PHASE IS COMPLETE (2026-08-06): 1,2,3,4,5,6,7 all PASS or retired into a shipped fix.**
  TAB-2 (tab closed, message, reopened - one copy, and the reopened tab does NOT re-ask the PIN),
  TAB-3 (browser killed, 2 messages, relaunched - no re-login, both present once; cold start renders
  in ~5 s over five runs, with ONE unexplained 77.7 s run recorded in section 10), TAB-6 (delete
  `canari_refresh` -> reload -> lands on `/login`, not a silent empty list; the IdP session survives
  so signing back in needs no credentials). **W1 was logged out and logged back in by TAB-6** -
  `login.mjs` then `pin.mjs`, both fine.
- **A1 runs the 2026-08-06 19:47:48 build** (WP-ANDROID-SESS-1 complete, all three defects), data
  preserved (`firstInstallTime` unchanged). The phone is signed in and PIN-unlocked; its
  `queued_message` backlog was emptied deliberately (see WP-PENDING-1) and is 0.
- **THE LIFE PHASE IS DONE EXCEPT LIFE-5 (2026-08-06).** LIFE-3, 4, 7, 8 PASS; **LIFE-6 FAILED 3/3
  and found TWO new P1s** - WP-PENDING-1 and WP-PENDING-2 below. Rows, logs and both root causes are
  in [cross-client-testing > the LIFE phase](docs/wiki/cross-client-testing.md#the-life-phase-2026-08-06);
  do not re-derive them. **LIFE-5 (reboot) needs the USER**: the device asks for its unlock pattern
  after a boot and `wm dismiss-keyguard` cannot answer it - pause and ask, never try to work around
  it. The 15th harness fault is there too: `am kill` does not kill a FOREGROUND app, so LIFE-8
  measured nothing and still returned a verdict; `enter()` now goes HOME first and the process death
  is an assertion folded into the verdict.
- **Reading the phone, and flashing it.** **The version name is still 0.13.0, so it no longer
  distinguishes builds** - the discriminators are `lastUpdateTime` and, in the artefacts,
  `already-consumed generation` inside `libmines_app_lib.so`. The APK is at
  `frontend/src-tauri/gen/android/...`, NOT `frontend/gen/...`, and web assets are brotli-compressed
  inside the `.so`, so only RUST strings can be grepped there. The package is `fr.emse.canari`, NOT
  `fr.emse.canari.app`. **`am force-stop` is NOT "the user killed the app"**: Android's STOPPED state
  cancels every FCM broadcast until a manual launch (proven in logcat), so NOTIF-1 and every
  killed-app cell must use a SWIPE from recents or `am kill` - and `am kill` does NOT reclaim a
  FOREGROUND process, so go HOME first and assert the death. The phone's whole web console is in
  logcat under `Tauri/Console`, which is how to read it while the WebView is unreachable; a busy
  device overruns the logcat ring in minutes, so capture continuously to a file rather than dumping
  after the fact.
- **PHASE 0 IS COMPLETE, and section 3 is under way (2026-08-06).** PASS so far: **MSG-1** (+38
  volume sends), **MSG-2**, **MSG-3**, **MSG-4** (image + PDF), **MSG-5**, **check M** (PDF preview
  on A1 hardware - `device-verification` updated), **FWD-1**. Rows and evidence are in section 10 of
  the wiki page, plus **MSG-6** (link preview proxied, zero third-party `<img src>`) and **MSG-7**
  (30 rapid sends: 30/30, ordered, no duplicate, no `SecretReuseError`), **MSG-8** and **MSG-8b**
  (backgrounded tab; the tab TITLE never signals an unread, only the badge, and only on refocus),
  **MSG-9** (phone's radios cut - nothing while down, one copy 26 s after, the delay being the
  app's own zombie-connection detection) and **MSG-10** (offline sender: queued, drained in 1 s,
  and it SURVIVED a reload - so the offline path persists correctly and WP-ECHO-1 is elsewhere).
  **FWD-4** (phone backgrounded 200 ms after the send: delivered). **FWD-3 and FWD-5 FAILED and
  found the campaign's root cause** - see WP-LOSS-1 below; it is a reload rewinding the sender's
  MLS ratchet, it is deterministic, and WP-FWD-1 is retired into it. **TAB-5 PASS** (7 rounds,
  reload 30-40 ms after submit, never lost, never doubled - the outbox survives the reload).
  **TAB-4 FAILED and found WP-HIDDEN-1**, a second P1: a backgrounded tab stops receiving
  altogether. **That also RETIRES MSG-8's PASS** - it asserted after restoring the tab, which is the
  act that released the drain; a single message can never expose it, the second one is the test.
  TAB-1 and TAB-7 are covered by MSG-8/MSG-10 respectively. **WP-HIDDEN-1 is FIXED and VERIFIED on
  prod** (both messages arrive while hidden, drains complete before the refocus); re-running TAB-4
  then turned 4a green and left 4c failing, which is **WP-MULTITAB-1**. Left in TAB: 2, 3, 6. Then
  LIFE, NOTIF/PIN/MULTI, CORRUPT last. **Reload BOTH browsers after every deploy before measuring** -
  a long-lived tab keeps its old bundle, and the first TAB-4 re-run failed for that reason alone.
- **An offline RECEIVER cannot be faked in the browser** - `emulateNetworkConditions` fails every
  new request in 10 ms and W2 still rendered the message twice over. Cause not established; do not
  re-explain it. MSG-9 belongs on the phone (`svc wifi disable` + `svc data disable`), which needs
  adb on **USB** - the wireless transport dies with the wifi, and this device's USB link drops on
  its own, so re-do the `forward` and wake the screen before every phone run.
- **A green check's observation log is where two shipped bugs came from.** MSG-6 passed while its
  log carried a `400` on `/api/mls/link-preview` - which turned out to be every URL containing a
  closing bracket being truncated, in the rendered `<a href>` as well as in the preview. Read the
  noise; that is the whole point of section 9.
- Bare-domain linkification is now **WP-LINK-1** below, not an open question.
- **RECONCILIATION is the only way this campaign's loss class can be SEEN**, and `recon.mjs` does
  it: markers on W1 diffed against markers on W2 for one thread. Re-run it after any batch of sends;
  a green per-check verdict cannot substitute for it - it is what found WP-LOSS-1 and WP-ECHO-1.
  **Two corrections it needed, and an earlier claim it forced me to retract:** the message list is
  VIRTUALISED, so reading `innerText` once after scrolling to the top returns a single screenful and
  drops the rest (it must accumulate at every scroll position); and each side loads a different
  amount, so the diff must be BOUNDED to the time window both cover, using the timestamp baked into
  every marker. Before those fixes it reported the two WP-LOSS-1 messages as permanently lost, and
  this file said so - **wrong: W2 has both.** A diff between unequal windows looks authoritative and
  is noise.
- The DM-name fix is verified on A1 from a COLD start, so `openDM()` no longer needs a full load for
  the phone - though nothing has been changed to rely on that yet.
- **The phone's IP moves between sessions** (it has already changed subnet). `watch.mjs` therefore
  RESOLVES the adb serial from `adb devices`, preferring the wireless entry over USB; never
  hard-code it again.
- **The two browsers MUST be relaunched with occlusion detection off** if they are ever restarted:
  `--disable-features=CalculateNativeWinOcclusion,ChromeWhatsNewUI --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`,
  plus `--user-data-dir=<scratchpad>/chrome-w1|w2`. Without it every click is silently discarded.
  A relaunch keeps the login (persistent profile) but re-locks the PIN - `pin.mjs` handles it.
- **To rebuild the phone:** `bun tauri android build --target aarch64 --debug` in `frontend/`, then
  install `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` (NOT
  `arm64/`, which holds a stale July APK) with `adb install -r`, and check its mtime AND
  `lastUpdateTime` - the version name does not move.
- **OBSERVATION IS PART OF EVERY CHECK, not a debugging step** (`watch.mjs`, wiki section 9). A
  verdict is `PASS` only if the assertions hold AND the run is clean - errors, 4xx, page exceptions,
  WS events, `notable` MLS lines, `stateChanges` and anything `unexplained` are reported next to it.
  A line that turns out to be routine is ADDED to the benign list, never ignored in place.
- **FOURTEEN harness faults have now produced false results, all fixed - the lesson generalises and
  is written up in the wiki page.** The three newest are all in READING THE PHONE, and all three said
  "no notification" about a notification that was on screen: a `dumpsys notification --noredact`
  dump larger than Node's default `maxBuffer` (it throws ENOBUFS, and a dump that cannot be read is
  not an absent notification); a matcher that only looked at the first 900 characters of each record
  while the marker sat past it; and `pidof`, which EXITS 1 when the process is gone, so the check
  died on the very kill it was there to measure. Before them, the TAB-2/3/6 batch, which all say one
  thing: an action that cannot prove it took effect still yields a verdict. A kill that killed nothing
  (PowerShell `-like` does not escape backslashes, and `powershell` is not on this shell's PATH -
  the ENOENT was swallowed); a "relaunch" that was really a new TAB, because a second `chrome.exe`
  on a live `--user-data-dir` hands its URL over and exits; `#encryption-pin` scored as a login form
  because it is `input[type=password]`, failing TAB-3 on the exact distinction it exists to make;
  and TAB-6 deleting Cloudflare's `cf_clearance` because `canari_refresh` is scoped to `/api/auth`
  and `Network.getCookies` for the site root never returns it (use `Storage.getCookies`). Plus:
  `client(port, match)` takes the FIRST matching target and `/json/list` is not creation order, so a
  leftover tab makes "the leader" a guess - close the extras first. `launch.mjs` now owns kill/start
  and verifies both. A document-wide `text=Répondre` hits the FIRST message's hidden
  action row (hence `clickBubbleAction`); a selector that ties on text picks the scroll CONTAINER
  over its button (hence RESOLVE drops any hit containing another hit); a synthetic pointer NEVER
  LEAVES, so the hover-expanded nav rail covered the conversation list and read as a layout bug
  (hence `realClick` parks the pointer afterwards); RESOLVE sorted by `innerText` length, so an
  avatar with an empty `innerText` and a matching `aria-label` beat the row that visibly carries the
  name (hence visible text outranks a label, and a hit that does not hit-test to itself is rejected
  rather than clicked); and **a `blob:` <img> is not a rendered image** - MSG-4 first passed on a
  fixture whose PNG CRCs were invalid, because a broken picture keeps its `src` (hence assert
  `naturalWidth > 0`, and CHECK THE FIXTURE before blaming the app). Assume a green check is wrong
  until its evidence says otherwise - and a FAIL too: check M reported FAIL only because it looked
  for a `<canvas>` where the PDF preview is an `<img>`. The last two invented an app-level loss on
  MSG-8b: the COMPOSER is inside the pane, so an unsent draft read back as a delivered message; and
  the soft keyboard moves the send button into the VISUAL viewport while CDP touch coordinates
  address the LAYOUT one, so the tap lands on `<html>` and the draft stays put. Hence: every action
  asserts its own post-condition (`send` fails if the composer still holds text), and the phone's
  submit goes through `activate()`.
- **The venue is a NEW COMMUNITY, `Campagne de test`, not a channel in MiTV** - a private channel is
  still readable by every association admin, and no association has jolan as sole admin. Two members
  only. Section 11 of the wiki page says why; do not re-derive it.
- **USB ADB drops on this phone** - promote to `adb tcpip 5555` + `adb connect <ip>:5555` at once,
  and never bind a long capture to the USB serial.
- **A page Chrome considers HIDDEN discards every input event** - and native occlusion detection
  marks a fully covered window hidden while `windowState` stays `normal`. That, not any framework
  quirk, was the real cause of "a synthetic click reaches the element and nothing fires" (the older
  note here said otherwise; it was wrong). Both browsers now launch with
  `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows`, after
  which `realClick` produces the full trusted sequence. Consequence: a backgrounded tab must be made
  by focusing another TAB, never by covering the window. On the mobile PIN modal still use
  `Saisie manuelle`, because the keypad has no readable buffer.
- **Restore Firefox as the device's default browser when the campaign ends**
  (`cmd role add-role-holder android.app.role.BROWSER org.mozilla.firefox`); it was switched to
  Chrome because Firefox exposes no CDP.

A check that FAILS earns a WP with its captured log; a check that passes earns a row in section 10
and nothing else. The campaign's prime target is now SHOT: **WP-LOSS-1 has a deterministic
reproduction and a root cause.** What is left is to keep the remaining phases honest, and to fix it.

**[device] The verification pass is NOT a Work Package.** Everything native is verified by COMPILING,
which proves nothing about running, and the whole owed list lives in
**[device-verification](docs/wiki/device-verification.md)** - checks B-N, the build to install, the
verdict log line of each, and the PASS/owed table. Android passed the ladder on v0.11.7; **iOS has
never run one check on hardware**. Owed on both: H (deep link into the conversation), K (quick
reply), L (revoked device re-enrolling), N (offline unlock + promotion), plus M (PDF preview) on
Android. **Open a WP only when a
check FAILS**, and only with its captured log. Capture tool: `test_adb.py` at the repo root.

- \[ \] **WP-STORE-1 - shipped 2026-08-05; what is owed is ON-DEVICE, not code.** The nag modal is
  gone, `minClientVersion` is the only interrupt left, and the update destination is a runtime fact.
  The three checks a test cannot replace are **check O** in
  [device-verification](docs/wiki/device-verification.md). Open a WP only if one FAILS.

- \[ \] **WP-SEO-1 / WP-SEO-2 / WP-PREV-2 - shipped, deployed and VERIFIED on prod 2026-08-05**
  (every path shape 200, real `<title>`/`og:*`/JSON-LD, which is also the proof `INTERNAL_SECRET`
  reached the container). Three nginx faults from that first deploy are fixed and their rules are in
  DURABLE RULES. What remains is four human checks -
  [seo > what no test here can prove](docs/wiki/frontend/seo.md#what-no-test-here-can-prove).
  Open a WP only if one FAILS.

- \[ \] **WP-HIST-3 (P2) - Pool history per MESSAGE between devices, not all-or-nothing.** Successor
  to WP-HIST-2 (shipped 2026-08-02), which stopped the blind soliciting but left the exchange binary.
  **Nothing is open - it only has to be written.** The design, the order of work and the three
  defects that ride with it are all in
  [chat > pooling history between devices](docs/wiki/frontend/modules/chat.md#pooling-history-between-devices-designed-not-built).

- \[ \] **WP-LOSS-1 (P1) - A RELOAD REWINDS THE SENDER'S RATCHET, AND THE RECEIVER SILENTLY DROPS
  THE NEXT MESSAGE. Root cause found 2026-08-06; DETERMINISTIC.** This supersedes WP-FWD-1, which
  was the same defect wearing a forward: FWD-5 lost 4/4 and every loss carried the identical
  fingerprint - `POST /api/mls/send -> 201`, then on the receiver
  `Ciphertext generation out of bounds <N>` / `SecretReuseError` / `[MLS] Duplicate ... - silent ACK`,
  with **the same N on all four runs**. Two experiments, neither involving forwarding, settle it:
  after a reload only the FIRST send dies (#0 lost, #1 630 ms, #2 660 ms); and reloading 300 ms
  after a send loses the next message twice over while reloading 20 s after it delivers.
  **MLS disk writes are deferred, so a reload that beats the checkpoint restores a ratchet behind
  the one already used**, and the next message is encrypted at a generation the peer has consumed.
  `[MLS] Disk writes deferred` was on the harness's benign list; it was the loudest line in the log.
  Everything - the tables, the retired hypotheses, both halves of the fix - is in
  [cross-client-testing > root cause](docs/wiki/cross-client-testing.md#root-cause-found-2026-08-06-a-reload-rewinds-the-senders-ratchet).
  Do not re-derive it, and do not re-open the load hypothesis or "forwarding is special": both are
  dead. **The SENDER half is SHIPPED AND VERIFIED ON PROD** (`a8cc7027`, verified 2026-08-06):
  `scheduleOutboundMlsPersist` now checkpoints instead of marking dirty, because the
  `pagehide`/`visibilitychange` hooks can only START an async save and the document dies first - an
  unload hook is never the guarantee. Re-running the reproduction against the deployed build gives
  **3/3 delivered at 700/681/772 ms** where it lost 2/2, matching the 694 ms no-reload control - do
  not re-verify it. The trap that verification cost: a priming send made by the OLD build never
  wrote a checkpoint, so both clients must be RELOADED before a post-deploy round is measured.
  **The RECEIVER half is now SHIPPED too** (2026-08-06), and its remedy was never `onOutOfSync` -
  the message is cryptographically unrecoverable there, and a re-add destroys a valid membership to
  fix nothing. `inboundFrameLedger.ts` fingerprints every frame processed, so a consumed generation
  can be told apart from a real double delivery; a miss is logged as `LOST frame` and emits
  `decrypt_failed { withinMs }`, which the sender answers from `recentSends.ts` with the exact
  protos it kept. It asks for a WINDOW because the frame never decrypted so its id was never seen;
  that is safe only because the receiver dedups on the `messageId` inside the proto, which is also
  why a false positive costs one frame. Rate-limited to one signal per group per 30 s. **The Rust
  path had thrown the diagnosis away** (`Ok(None)` on `SecretReuse` read as "nothing to show"), so
  Android dropped every rewound message with no trace - it now surfaces the error into the same
  classifier. **The classifier was SEEN firing on prod the same day**, taking the benign branch on a
  real double delivery: `Ciphertext generation out of bounds 2393 / SecretReuseError` then
  `[MLS] Duplicate delivery for 642f389a… - silent ACK (null payload, WASM duplicate flag)` - the new
  wording, so the ledger recognised the frame. **Owed: a LOSS-branch verification** (no reproduction
  has produced one since the sender fixes landed, which is itself the point), the **ANDROID** half -
  the code is now ON the device (re-flashed 2026-08-06, `already-consumed generation` verified inside
  the shipped `.so`) but no phone run has yet exercised either branch - and two deliberate gaps - the ring dies on a reload, and nothing
  tells the receiver's USER that a message was lost. Reasoning on the wiki page.

- \[ \] **WP-HIDDEN-1 (P1) - A BACKGROUNDED TAB STOPS RECEIVING MESSAGES ENTIRELY, IN SILENCE.
  Found and FIXED 2026-08-06 (`d1bedee1`); what remains is the prod verification and one deliberate
  gap.** `yieldToMainThread` resolved from `requestAnimationFrame`, which a browser NEVER fires for a
  hidden document. It is awaited on the first line of `runSaveEncrypted`, which runs in `onDrainEnd`,
  which `drain()` awaits in front of `isDraining = false` - so a hidden tab never finishes a drain,
  `enqueueMessage` then skips starting one (and logs nothing when it does), and every later message
  piles up unprocessed. The message in flight does not even render: its UI flush is buffered by
  `beginBulkIngest({ bufferUi: true })` and released by the stuck `endBulkIngest`. Deterministic: one
  tab backgrounded, #1 invisible, #2 never drained, both appear at the exact millisecond of the
  refocus (26 s measured on prod). **Two tabs were never the point** - TAB-4 found it only because
  opening a second tab hides the first; do not re-open "leader election" as a cause. IndexedDB
  answered in 1 ms from inside the stuck tab and the encrypt worker has a 60 s timeout, so neither is
  it. The fix RACES the frame against a `MessageChannel` round trip: choosing on `visibilityState`
  still hangs when the tab is hidden after the callback is queued, and a timer fallback would be
  clamped to ~1 Hz in the background. Everything is in
  [cross-client-testing > backgrounded tab](docs/wiki/cross-client-testing.md#root-cause-found-2026-08-06-a-backgrounded-tab-stops-receiving-silently-wp-hidden-1).
  **STILL OPEN, on purpose:** any hung await inside `onDrainEnd` can still stop every inbound message
  with no diagnostic - the flush belongs behind `isDraining = false`, or the queue needs a watchdog.
  The yield was one way in, not the only one.

- \[ \] **WP-MULTITAB-1 (P1) - TWO TABS OF ONE ACCOUNT DIVERGE THEIR RATCHET; the message of
  whichever is behind is dropped. Found 2026-08-06, FIXED and VERIFIED ON PROD the same day**
  (`260084c5`): `tab4-cross.mjs` went **9/9** where it had lost 4 of 9, and `tab4-mech.mjs` then
  read BOTH tabs' logs to prove the delegation rather than infer it from a green result - the
  follower queues and skips, the leader flushes the same entry id one second later. Diagnosis, kept
  because it is what makes the fix legible: each tab holds its OWN MLS client loaded from one
  snapshot, and leadership gated the WebSocket and `initializeConnection` but **NOT sending** - the
  follower was caught flushing the LEADER's outbox entry and persisting its own checkpoint. **Same
  three lines as WP-LOSS-1 but a different bug**: there one client rewound its own state across a
  reload, here two live clients overwrite each other; a fix for either does nothing for the other.
  The fix is in two halves, and the second is the one that is easy to miss: the follower's
  `runFlush` returns before any send and nudges the leader over `canari-tab-messages` (the entry
  itself never crosses - the outbox is in IndexedDB, which both tabs share), AND a follower
  PROMOTED to leader reloads instead of merely reconnecting, because gating the flush leaves its
  in-memory ratchet frozen at load time while the leader advances the one on disk. Both halves,
  what is guarded and what is not, in
  [cross-client-testing > two tabs](docs/wiki/cross-client-testing.md#two-tabs-of-one-account-diverge-their-ratchet-and-the-losers-message-is-dropped-wp-multitab-1).
  **Future, NOT scheduled - to evaluate for relevance and cost before anyone starts it:** one MLS
  client in a SharedWorker, shared by every tab. It removes the class outright rather than gating
  each write path one at a time, and nothing type-checks that a new path went through the queue.
  Cost is the reason it is not the fix: the worker transport, startup, the PIN unlock and the
  Safari/mobile fallback where `SharedWorker` is absent all have to be redone.

- \[ \] **WP-ANDROID-SESS-1 (P1) - ON ANDROID, A SESSION THAT CANNOT REFRESH LEAVES THE APP LOOKING
  SIGNED IN, SHOWING NOTHING. THREE defects, all fixed, and ALL VERIFIED ON THE DEVICE 2026-08-06.
  The only thing owed is the WEB DEPLOY.** The 401 was a **replay**: the phone presented a cookie one
  rotation behind, because the refresh token lives only in the WebView cookie jar, Chromium commits it
  lazily, and `MainActivity` flushed only from `onPause`/`onStop`. **Do not re-open the concurrency
  hypothesis, it is dead.** The three fixes: (1) persistence - `flush_webview_cookies` (Rust JNI ->
  `android.webkit.CookieManager`, VM cached in `JNI_OnLoad`) awaited after login, refresh and logout;
  (2) visibility - the verdict is announced once from `auth.ts` (`setSessionExpiredHandler`), and
  `apiFetch` no longer retries a dead session anonymously; (3) **found BY the verification** - the
  verdict beat its own handler on a cold start, so the fallback's bare redirect left the PIN modal
  over `/login` with the sign-in button underneath and no way back in; the verdict is now replayed to
  a handler that registers after it. **Verified on hardware, do not re-derive:** persistence 2/2
  (`previousTokenId` was exactly the flushed token, 94 s and 107 s after the rotation, well past the
  grace window), and `[Cookies] flushed after refresh` in the phone's own log is what proves the JNI
  `FindClass` resolves at runtime. Every number, both tables and the third defect are in
  [cross-client-testing > verified on the device](docs/wiki/cross-client-testing.md#verified-on-the-device-2026-08-06---and-the-verification-found-a-third-defect);
  the rules are in [sessions](docs/wiki/sessions.md). **OWED: the web deploy only** - GitHub Actions
  was in a major outage 2026-08-06 (`Failed to resolve action download info`), so run 31120637374
  failed at *Set up job*; rerun the failed jobs, nothing is wrong with the code. **Re-logging the phone
  in IS automatable** - the Android login just opens the SYSTEM browser (`openUrl`), so forward CDP
  to `localabstract:chrome_devtools_remote` and run `login.mjs --match cas.emse.fr` against it. The
  one trap, which cost a run: never `realClick` the CAS fields (the hit test reaches "mot de passe
  oublié" on the phone's layout) - focus by element and assert `activeElement`, as `login.mjs` now
  does.

- \[ \] **WP-PENDING-1 (P1) - A DEVICE THAT FALLS FAR ENOUGH BEHIND CAN NEVER CATCH UP: the
  catch-up pull is all-or-nothing under a fixed 10 s deadline, so a backlog bigger than 10 s of
  transfer aborts forever and only grows.** Found by LIFE-6 2026-08-06, PROVEN, **FIXED the same day
  (`pageTimeoutMs` + `onPage` per page, 4 tests) - OWED: the deploy, a phone rebuild, and the
  re-verification against a real backlog.**
  `fetchPendingMessages` ([BaseMlsService.ts:516](frontend/src/lib/services/BaseMlsService.ts#L516))
  puts ONE `AbortController(10_000)` around `pullPendingMessagesJson`, which itself loops `limit=500`
  pages behind an `after` cursor - and nothing is enqueued or ACKed unless the WHOLE pull returns. The
  phone held 5 526 rows = 12 pages of ~465 KB; the abort fired at 10.03 / 10.26 / 10.30 s after each
  reconnect while the WS was connected and `/api/presence` answered 200. **The server is not the
  cause and the hypothesis is dead**: `EXPLAIN (ANALYZE, BUFFERS)` on prod is **8.909 ms** on the
  composite `(recipientId, deviceId)` index. Proven by experiment: `DELETE 5431` -> 95 rows left ->
  the very next reconnect logged `[PENDING] Fetched 95 pending messages` in **0.6 s**. The remedy is
  a deadline per PAGE, with each page ingested and ACKed as it lands, so every pull makes progress -
  which is what shipped; the Android half is the same bundle, so it needs a rebuild, not a fix.
  Note the abort surfaces on Android as `TypeError: Failed to fetch` plus orphaned
  `Uncaught (in promise) The resource id NNNN is invalid` - indistinguishable from a network failure
  by text alone, which is why three runs read as "the phone was offline".

- \[ \] **WP-PENDING-2 (P1) - A MESSAGE PULLED WHILE OFFLINE DECRYPTS, IS ACKED, AND THEN EXISTS
  NOWHERE. Established 2026-08-06, root cause NOT found.** With the backlog emptied, LIFE-6 still
  fails: the frame is pulled (`Fetched 2 pending messages`), decrypts (`messageCallback -> true`), is
  ACKed and DELETED server-side (witness row `eb45c135-5fa2-413e-bdac-4ba38f21589e` gone from
  `queued_message`), and the message is in no conversation - verified by an accumulating scroll read,
  not a screenful. **The WP-LOSS-1 ledger never sees it**: no `LOST frame`, no `SecretReuseError`, no
  `Ciphertext generation out of bounds`, no duplicate line. **Two hypotheses are dead, do not re-open
  them:** the FCM push did not consume the generation (`CanariFCM: App in foreground -> MLS handled
  by the foreground (WS), skip background processing` for both frames), and it is not the backlog.
  What is unknown is where between `messageCallback -> true` and the message store it goes -
  instrument that seam. Evidence in
  [cross-client-testing > the LIFE phase](docs/wiki/cross-client-testing.md#the-life-phase-2026-08-06).

- \[ \] **WP-BANNER-1 (P3) - the sync banners cover the conversation header.** Reported by the user
  2026-08-06 with a screenshot. `isCatchingUpMessages` and `historyPendingLabel` in
  [ChatArea.svelte](frontend/src/lib/components/chat/ChatArea.svelte) are both `absolute top-0`, and
  their containing block is the `<section class="relative">` that ALSO holds `<ChatHeader>` - so they
  paint over the avatar and the name instead of stacking under the header. Anchor them to the
  messages container, not the section.

- \[ \] **WP-ECHO-1 (P2) - the SENDER loses its own message across a reload.** Found by the same
  reconciliation: `HUNT06`/`HUNT07` are present on the RECEIVER and absent from the sender that sent
  them. This is the failure the durable rule about `persistLocalMutation` predicts - MLS gives no
  echo of your own message, so the optimistic update is the only writer, and if it is not persisted
  it dies at the next load. Distinct from WP-LOSS-1, which loses it at the receiver; do not merge
  them. **MSG-10 narrows it:** the OFFLINE send path persists correctly - queued offline, drained on
  reconnect, and still there after a reload - so whatever loses the echo is a different route.

- \[ \] **WP-KBD-1 (P2) - On Android the composer ends up BEHIND the soft keyboard.** Found
  2026-08-06 while chasing a harness fault; reproduced with an ordinary gesture: tap the composer,
  press HOME, come back. The shell is pinned to `visualViewport.height` but does not start at the
  viewport's top - an ancestor carries the status-bar inset - so it overflows by exactly that inset
  and the composer footer goes under the keyboard. Every measured number, the second suspect
  (`layoutInsetBottom` is 0 precisely when it is needed) and the invariant to restore are in
  [mobile > the soft keyboard and the app shell](docs/wiki/frontend/mobile.md#the-soft-keyboard-and-the-app-shell-wp-kbd-1-open).
  Do not re-derive them. The file is `frontend/src/lib/stores/keyboardViewport.svelte.ts`, whose
  geometry is already pure and unit-tested - so the fix belongs in `computeSnapshot`'s contract plus
  a test, not in a component.

- \[ \] **WP-OIDC-TAB-1 (P3) - On Android the browser tab opened for the login is NEVER closed.**
  Reported by the user 2026-08-06 and reproduced during the WP-ANDROID-SESS-1 re-login: the app comes
  back to the foreground on the deep link, and the system browser is left sitting on the last
  Authentik page (`auth.canari-emse.fr/if/flow/default-source-authentication/?code=…`), which reads
  as "the login failed" to anyone who looks at it. Cause: `auth.ts` launches the flow with `openUrl`
  from `@tauri-apps/plugin-opener`, i.e. a plain browser launch - nothing can dismiss that tab
  afterwards, from inside or outside. The remedy is a **Chrome Custom Tab**, which the OS closes when
  the app resumes; that is a native change (the opener plugin has no such affordance), so scope it
  before starting. iOS has the same shape with `ASWebAuthenticationSession` as the equivalent, and it
  has never been checked on hardware - see [device-verification](docs/wiki/device-verification.md).

- \[ \] **WP-LINK-1 (P3) - Linkify bare domains, without linkifying inclusive writing.** Today a
  chat link needs its `https://` scheme, and a post runs GFM, which autolinks only `www.`-prefixed
  hosts and e-mail addresses - verified against `marked`, where "auteur.rice", "cher.e.s" and
  "Bonjour.Comment" all produce nothing. So `canari-emse.fr` typed bare is dead text on both
  surfaces, which is the gap to close. **The whole difficulty is that an allowlist of "known
  extensions" is not enough in French**: `.es` is Spain's, so "cher.es" becomes a link; `.it`,
  `.re` and `.ne` collide with inclusive and elided forms the same way. Ship a deliberately narrow
  allowlist - `com org net fr eu io dev app edu gov`, **no other two-letter TLD** - in
  `messageDisplay.ts` next to `HTTP_URL_RE`, require a label before the dot and a non-word
  character after the TLD, and reuse `trimUrlTrailingPunctuation`. Same list must gate the post
  renderer, or the two surfaces disagree. Tests belong with the five that
  `messageDisplay.test.ts` already carries, and must include the French false positives above.

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
- An error says what it says: "this generation is consumed" is NOT "I already have this message".
  Keep the evidence that distinguishes them (the frame's own bytes) - and never let a native layer
  answer `Ok(None)` where the shared classifier could have decided.

#### Outbound delivery -> [chat](docs/wiki/frontend/modules/chat.md), [mobile](docs/wiki/frontend/mobile.md)

The queue, its barrier, the token rules and the native mirror are on those two pages. The three to
carry in the head:

- The outbox is best-effort at every step, so every swallowed branch logs - that is all a loss leaves.
- A tab is "read-only" only where something CHECKS: leadership gated the socket, not the queue, so
  the follower encrypted anyway. And gating a writer freezes its state - whoever inherits the role
  must reload it, or it resumes exactly as far behind as the tab it replaced had moved on.
- `requestAnimationFrame` NEVER fires in a hidden document, so it can never be the only resolver of
  anything a background path awaits - and a "yield" that can hang is a deadlock, not a delay. Race it
  with a `MessageChannel` message; a timer fallback is clamped to ~1 Hz in the background.
- A deadline's SCOPE is part of its meaning: one budget over a paginated catch-up is a budget the
  devices that most need it can never meet, and an all-or-nothing pull makes each failure bigger than
  the last. Per page, ingested and ACKed as it lands - partial progress must be kept.
- MLS gives no echo of your OWN message, so the sender's optimistic update is the only writer it
  gets: apply it in memory AND persist it (`persistLocalMutation`), or it dies at the next load.
- The mirror is READ as well as written: a file one side rewrites wholesale silently deletes
  whatever the other side appended, so every such pair needs an adoption pass, not just a drain.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md), [auth](docs/wiki/frontend/modules/auth.md) (native prompts)

Tokens, the one-way-colour sweep, the portalled dropdown, Svelte's whitespace trim and the native
prompt fields are all on those pages. What must not be forgotten between them:

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens - and the 31 the
  sweep left are DELIBERATE (switch thumbs, colour-picker handles, always-dark call/lightbox chrome,
  the white plate behind a QR). Do not "fix" them.
- Nothing types a string as user-visible, so no compiler enforces Paraglide - and no user-facing
  string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time).
- Re-run `bun run paraglide:compile` before `bun run test` after any build.
- A synchronous "unknown" PLACEHOLDER is indistinguishable from an answer once it is stored, so
  anything that later resolves the real value loses to it - and a module-level cache re-renders
  nothing when it warms, so whether a user ever sees the truth depends on cache timing. Return the
  absence (`peekUserDisplayName` -> `null`, or an explicit `*Resolved` flag), never the label.

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

**Android/iOS native parity is COMPLETE as of v0.12.0** (audited 2026-08-03, file by file), for
code. The asymmetries are OS-imposed - no boot broadcast on iOS, CallKit vs full-screen intent, no
self `Person` on iOS. Do not re-audit; extend this line.

**That audit read source files, so it could not see a divergence expressed in CONFIGURATION**: the
App Link path claim was iOS-only for as long as it existed, and Android captured `/auth/callback`
out of the browser mid-login (fixed 2026-08-05, `56fc6129`). Parity of code is not parity of the
manifests, entitlements and served association files - those are a separate surface with its own
tests.

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
