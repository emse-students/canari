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

**LEON PUSHES TO CANARI's `main` TOO** (asked by the user 2026-08-07). So `git fetch` at the START of
a session and again before any measurement - never assume the local `main` is the deployed truth. His
commits are often style/UI and they land in the same files the campaign measures, so what is owed for
each is a WEB and a MOBILE pass, logged next to our own checks (before or after ours, either way).
He follows the conventions - his WP-KBD-1 fix (`cc540145`) carried tests, the wiki page, `CHANGELOG.md`
and the SESSION STATE entry - so a rebase is normally clean; the thing to actually verify is his
change RUNNING, on both surfaces, which no test of his can establish.

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

### PORTAIL-ETU (../refonte-portail-etu) - COMPLETE, nothing open

**The avatar 502s are CLOSED 2026-08-06** - fix deployed and verified on prod (`X-Cache` miss then
hit, the 404 branch carrying `max-age=600`), `pm2-logrotate@3.0.0` installed, one-off workflows
deleted (`0d3dd93`). The cache, its status table and why only a literal 404 may be stored are in
that repo's `docs/wiki/architecture.md`. Four facts that survive the WP:

- **The residual cause is UNKNOWN and is NOT an app defect**: for ~20 min the host could not open
  outbound connections at all (479 x bun `Unable to connect` on a well-formed URL, in bursts). Ruled
  out with measurements, do not re-run any of them: inbound rate-limiting, load (60 concurrent =
  100%), DNS/TLS/secrets, IPv6 (`AI_ADDRCONFIG`, no global v6 address), conntrack (140/262144),
  bun-vs-curl (40/40 agreement), and **CrowdSec - refuted by its own evidence**: 7 alerts in 48 h,
  **0** naming a Cloudflare edge range, none inside the window. What is left is the egress path
  upstream of the box. A recurrence is now timestamped (`time: true`) in a clean, rotating log.
- **`deploy.yml` has a `workflow_dispatch`** and it is a keeper. A GitHub Actions outage drops push
  triggers outright (`Run Tests` cancelled in queue -> `Deploy` skipped, and a lost trigger never
  comes back), and a dispatch 500s while STILL creating the run - check `gh run list` before
  re-dispatching. It skips the CI gate on purpose; the pre-push hook runs the gates locally.
- **No SSH to that box** - the self-hosted runner is the only way in, and the shape is a dispatch-only
  workflow then removed (`d986062`/`d128501`, `928bd0c`/`2b390c4`, `89ec902`/`0d3dd93`). The repo is
  **PUBLIC**, so every run log must redact - and `grep -a` is mandatory: the pm2 log holds binary
  bytes, so `grep -c` counted 479 while `grep -A3` printed nothing with its stderr hidden.
- **`pm2 flush`, never `rm`** - pm2 holds the fd. 117 MB + 131 MB were flushed this way; ~1.9M of
  those lines belonged to the LEGACY portal running under the same pm2 app name, none of it this repo.

### PORTAIL-ETU - the legacy dump

The full legacy dump (12 databases, 24.4 MB) lives at
`../refonte-portail-etu/data-export/legacy-full-dump-2026-08-04.sql` - gitignored, PII, NEVER commit.
If it ever has to be redone: there is no SSH to that box, only the self-hosted CD runner (account
`muselli`, passwordless sudo), and the only usable MySQL credential is `/etc/mysql/debian.cnf` (a
read-only `mysqldump@localhost` that lacks `EVENT` on the `mysql` DB, so `--events` must be dropped).

---

### CANARI - OPEN WORK PACKAGES

**QR SYNC IS DELETED 2026-08-07** (user reaffirmed after being told Leon had just polished its UI -
"c'est juste un choix cosmetique qui n'a plus lieu d'etre"). It never worked: the server required a
`salt` the frontend never sent, so every non-empty manifest upload 400d, and the two exchanged public
keys were read by nothing. WP-HIST-3 replaces it by construction. `SettingsSyncSection.svelte` is now
`SettingsBackupSection.svelte` (`.canari` export/import only) and the `profile_sync_*` keys are
`profile_backup_*` - the old description literally offered a QR transfer that no longer exists.

**[campaign] CROSS-CLIENT TEST CAMPAIGN - PAUSED ON PURPOSE, pending WP-HIST-3 (below).** The whole
plan AND the built harness are **[cross-client-testing](docs/wiki/cross-client-testing.md)** - and
that page now OPENS with a "Where this campaign stands" dashboard (phase table, the eleven defects
it produced and their state, what is left in order). **Read that dashboard rather than re-deriving
the state from here.** Sections 1.1 (harness), 7 (real artefact names), 9 (observation) and 10
onwards (every check's row and what it cost) are unchanged. What a compaction must not lose:

- Runs against **PRODUCTION**, two real accounts, credentials in the scratchpad
  `test-accounts.json`, **never in the repo**.
- **The harness is BUILT, proven, and now ARCHIVED IN THE REPO** at
  **`tools/cross-client-harness/`** (47 files, flat on purpose so every relative import and every
  `execFileSync('pin.mjs')` still resolves; its README covers the rig). The scratchpad copy is still
  the working one for a live session
  (`C:\Users\jolan\AppData\Local\Temp\claude\c--Users-jolan-Documents-Programmation-canari\3dd9d8ba-077b-47ad-9f1d-33bb94f62dcd\scratchpad\`,
  which also holds the ~60 one-shot `probe-*`/`*-triage` scripts deliberately left out of the
  archive). A later session REUSES these, it does not rebuild them. One `cdp.mjs` drives all three
  clients (W1 on 9224, W2 on 9223, A1's WebView on 9222 via `adb forward`); `a1.py` is only for
  native surfaces. W1 moved OFF the chrome-devtools MCP on purpose, so no password is ever a
  tool-call argument, and `test-accounts.json` is gitignored in both places.
- **W1 was logged out and logged back in by TAB-6** (`login.mjs` then `pin.mjs`, both fine), and one
  cold start in five took **77.7 s** for no reason anyone established - recorded in section 10, still
  unexplained.
- **A1 runs a build carrying WP-PENDING-1, WP-PENDING-2 and WP-DRAIN-1** - check
  `frontend/src-tauri/gen/android/.../app-universal-debug.apk`'s mtime before trusting a run, since
  the version name no longer moves. The phone is signed in and PIN-unlocked. Its device id is
  `tauri-d82cd226…-msgnk8nf-gyb2`; the DM under test is `642f389a-2800-412d-ab7c-cc521587f97f`
  (Claire VAN RUYMBEKE). That group HEALED through the re-add on 2026-08-06 (3/3 fresh messages at
  2.9/1.5/4.1 s) after being more than 2 000 generations behind - the frames had been deleted from
  `queued_message` deliberately, so nothing but the re-add could recover it.
- **LIFE-6 PASSES on the re-run (2026-08-06 22:16)**, once the group was rejoined at a fresh epoch:
  one copy 18 ms after restore, drained by the new per-page path (`Fetched 2 pending messages`) with
  no `LOST frame`, no `SecretReuse`, no re-add. The three earlier losses were the undrainable
  2 000-generation debt, nothing else. Row in section 10 of the wiki page.
- **LIFE-5 (reboot) is the one check left in that phase and it needs the USER**: the device asks for
  its unlock pattern after a boot and `wm dismiss-keyguard` cannot answer it - pause and ask, never
  try to work around it.
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
- **WHERE THE CAMPAIGN STANDS: the phase table is the DASHBOARD at the top of the wiki page** - do
  not maintain a second copy here. One line: Phase 0/MSG/FWD/TAB complete, LIFE done except LIFE-5
  (needs the user), NOTIF partly (2/3, 5, 6 left), then HEAL/PIN/MULTI/CORRUPT - **all of it after
  WP-HIST-3**, by the decision above. The four checks that FAILED each became a P1 and each has its
  own entry below:
  FWD-3/FWD-5 -> WP-LOSS-1 (which retires WP-FWD-1), TAB-4 -> WP-HIDDEN-1 then WP-MULTITAB-1,
  LIFE-6 -> WP-PENDING-1 + WP-PENDING-2. **MSG-8's PASS was RETIRED** by TAB-4: it asserted after
  restoring the tab, which is the very act that released the drain - a single message can never
  expose that bug, the second one is the test. **Reload BOTH browsers after every deploy before
  measuring** - a long-lived tab keeps its old bundle, and the first TAB-4 re-run failed for that
  reason alone.
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
- **TWENTY-TWO harness faults have produced a false result, all fixed, and every one is written up in
  the wiki page** (search "harness fault"). Do not re-derive them - what they say collectively is
  three rules, and these are the ones to apply without opening it:
  - **A check that puts the app through a transition must restore every precondition that transition
    destroys.** A kill, a reboot, a radio cycle and an `install -r` all re-lock the PIN, and #22 read
    a whole 69 s verdict through the modal - it would have returned the identical FAIL against a
    fixed build. NOTIF-10 had already learnt this and the fix went into `notif.mjs` alone; **a
    precondition found by one check belongs to every check sharing the transition.**
  - **An action that cannot prove it took effect still yields a verdict**, and that verdict is
    fiction. Every action asserts its own post-condition (`send` fails if the composer still holds
    text; a kill asserts the process died), because the faults were a kill that killed nothing, a
    "relaunch" that was a new tab, a dump too large to read scored as "no notification", and a
    `pidof` that exits 1 exactly when the thing it measures happens.
  - **Assume a green check is wrong until its evidence says otherwise - and a FAIL too.** MSG-4
    passed on a fixture with invalid PNG CRCs (a broken `<img>` keeps its `src`, hence
    `naturalWidth > 0`); check M failed only because it looked for a `<canvas>` where the preview is
    an `<img>`; MSG-8b invented an app-level loss out of an unsent draft. **Check the fixture and the
    selector before blaming the app.**
  - **A locator is a guess unless it is disambiguated - and a DEVICE is a locator**: `u2.connect()`
    with no serial raises the moment the phone is attached over both USB and wifi, which every long
    run makes true; `/json/list` is not creation order, a
    document-wide text match hits the first hidden action row, a tie picks the scroll container over
    its button, and an `aria-label` must never outrank visible text. **A selector shared by two
    surfaces is not a post-condition either**: `.chat-composer-editor` belongs to the shared
    `MentionComposerInput`, so it is on `/posts` too and "the composer is on screen" was TRUE on the
    social feed - and `send()` would have typed its marker into a comment box on somebody's post.
    Every use is now scoped to `.chat-composer-footer .chat-composer-editor` (20th harness fault).
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

**A BROKEN GROUP HAS ONLY EVER BEEN SEEN HEAL ON THE PHONE.** Asked by the user 2026-08-06: the same
repair must be measured on the BROWSER. Four checks - epoch gap, unknown group, generation gap, and
the pair nothing has ever exercised together (a recovery while a SECOND tab holds the leader role) -
are section 7.1 of [cross-client-testing](docs/wiki/cross-client-testing.md). The break is a RESTORED
older snapshot of `CanariDBMls_<dev>`; take the snapshot first. Gated on the web deploy, and both
browsers must be RELOADED after it.

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

- \[~\] **WP-HIST-3 (P1) - ALL STEPS SHIPPED 2026-08-07, NOT YET DEPLOYED.** The exchange is a manifest diff instead of a full bundle. Everything built - the
  flipped direction, the two digest modes, UTC months, the codepoint sort, the rendezvous,
  `announceComplete`, the null-vs-empty read, what ends a wait, the give-up counter - is in
  [chat > pooling history between devices](docs/wiki/frontend/modules/chat.md#pooling-history-between-devices-legs-1-3-built-2026-08-07-steps-3-4-owed).
  **Read that, do not re-derive it, and above all do not "restore" the design's direction**: the
  REQUESTER broadcasts the digest and the elected RESPONDER diffs (backwards compatible with no
  negotiation, one round trip fewer). New files: `utils/chat/historyManifest.ts` (pure, 42 tests),
  `utils/chat/historyDigestRendezvous.ts` (11 tests). 1043/1043 green, `check` 7571 files 0 errors.
  Two rules it added, each verified by a negative control: **only an EMPTY bundle ends a wait
  unconditionally** (a non-empty one voids a presumption, never a proof - a chunked history used to
  end the solicitation on its first chunk), and **`noteDesyncDetected` returns `{signal, escalate}`,
  never both** - three signals in five minutes hand the group to the diff instead of asking a fourth
  time. `REASON_RANK` had been declared and never used, so `peer-holds-more` was downgradeable.

  The three riding defects are fixed too (`no_peer_online` now heard, a peer's RETURN re-solicits,
  `checkPresenceNow` coalesces). **What is OWED is the WEB DEPLOY**, then the campaign checks that
  touch the repair.

  **ANSWERING THE USER'S QUESTION OF 2026-08-07 FOUND A P1, now fixed** (the question: what happens
  when no peer is online as a device joins, are completeness checks regular, do devices compare
  COUNTS). `pending` in `historySolicit.ts` was read as `pending.has(groupId)` and NOTHING removes an
  entry when a burst ends unanswered - so a group whose peers were all offline during its 3-minute
  burst was "already soliciting" for the life of the tab, and the reconnect, the peer-return edge and
  the escalation ALL skipped it. **The situation the retries exist for was the one that disabled
  them.** `isSolicitInFlight` now reads the burst's own schedule. A slow sweep
  (`startAwaitingHistorySweep`, 15 min, pausable) was added as the floor under the four event
  triggers. The table of triggers is in the wiki section; do not re-derive it.

  **Three things from that answer that must NOT be re-litigated:** devices compare IDENTITIES (sorted
  ids under 1000, else per-`YYYY-MM` count AND truncated SHA-256), never counts - a count is a
  guaranteed false negative. Presence is only polled for DISPLAYED users, so the edge covers DMs on
  screen and a channel only with its member panel open. And **`history_request` is deliberately NOT
  made durable** the way `welcome_request` is (Redis + FCM): a stored request drained hours later has
  no digest (60 s MLS rendezvous), so the responder would fall back to the full-store dump this WP
  exists to remove, for a device that may need nothing - the requester must reconnect to read
  anything anyway, and reconnecting re-solicits. The related half (no FCM: a missing Welcome BLOCKS a
  group, missing history only degrades it) was already recorded on `notifyHistoryRequest`.

  **Still open, and NOT worth a WP yet:** a device holding SOME of a conversation, missing older
  messages, and never failing to decrypt carries no marker, so it never asks - it learns only by
  being someone else's elected responder.

  **Why it was promoted, and why the alternatives were rejected as band-aids** (user's call, do not
  re-litigate): WP-RETRANSMIT-1 showed `decrypt_failed` has three harmful properties, none accidental
  - it is addressed by TIME rather than identity, EVERY peer answers it, and it reads an in-memory
  ring so the repair races a reload. The diff has none of the three.

  **Then re-run the campaign checks that touch it** - the remaining phases run AFTER, so they test
  the mechanism that will actually ship.

- \[ \] **DELETE the QR-code device-sync feature - APPROVED by the user 2026-08-07, not started.**
  ~2 470 lines (`SyncSessionModal.svelte`, `useSyncSession.svelte.ts`, `sync/syncEngine.ts` and its
  server side). **PRESERVE the ~55 lines of `.canari` file import/export in
  `SettingsSyncSection.svelte`** - that is a different feature. Its algorithm is what WP-HIST-3 now
  carries, so nothing is lost. The evidence, verified by hand and not taken from the audit agent:
  the server REQUIRES a `salt` field (`sync-types.ts:203`) that the frontend has **zero** occurrences
  of, so every non-empty upload 400s - the feature is simply broken; and `offerPublicKey` /
  `answerPublicKey` are generated, sent, stored and echoed back but **never read by any client**,
  with no ECDH primitive anywhere in the path, so the comments promise a key agreement that does not
  exist (the transfer works only because `deviceKeyB64` = PBKDF2(userId, pin, per-USER serverSalt),
  which two devices of one user derive identically). Also: reachable at `/settings` behind no flag, a
  dead second mount at `MainChatPage.svelte:1028-1040` that ironically holds the CORRECT post-sync
  callbacks, the server sees conversation names + all message ids and timestamps in plaintext, a
  mismatched PIN on device B imports permanently undecryptable rows while reporting success,
  `deviceId` is unauthenticated and `chunks/ack` has no participant check, zero tests. Own commit.

- **WP-RETRANSMIT-1 (P1) is SHIPPED 2026-08-07** (`9a0b199a`) - the decrypt-failure repair fed
  itself. A replay went out through `enqueueControlEvent` (fresh `randomUUID()`, fresh `sentAt`) and
  the flusher re-retained it, which defeated BOTH bounds of `recentSends`: the 5-minute window never
  aged, and the id dedup no longer matched so the ring accumulated copies. Every later signal
  replayed all 25. Measured on prod: **~430 frames/min for 13 min across three clients, 4 921 queued
  for one phone**, which then spent 18 min draining them - with nobody typing. It stopped only
  because the ring is in memory and a tab reloaded. Fixed by `isRetransmission` on the outbox entry;
  the flusher skips `noteSentFrame` for it. **In the same commit**, `BaseMlsService.endBulkIngest`
  now isolates its observers per subscriber: they were awaited in one bare loop although the code
  calls them "independent", so a failed encrypted checkpoint (the FIRST observer, which rethrows)
  would have skipped the UI one - leaving the sync banner up for the session AND `bulkIngestActive`
  raised, buffering every inbound message instead of rendering it, then discarding it. Full story in
  [cross-client-testing > the retransmission storm](docs/wiki/cross-client-testing.md#the-retransmission-storm-2026-08-07-a-repair-that-fed-itself).
  **Owed: the web deploy.** Found because the user asked whether the sync banners were normal - they
  were, and the banner was the honest symptom.

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
  the shipped `.so`) but no phone run has yet exercised either branch - and two deliberate gaps: the
  ring dies on a reload, and nothing tells the receiver's USER that a message was lost. Reasoning on
  the wiki page.

**WP-GHOST-1 (P1) is SHIPPED AND VERIFIED ON PROD 2026-08-07** (`5335a71f` + `eed39f51`). A revoked
device wrote its own routing membership back through `POST /api/mls/invitations/status` and was then
messaged forever, collectable by nothing: the queue was **98 210 rows / 150 MB**, 99.1 % of it for
nine device ids that no longer existed. The boot sweep collected the preserved reproduction on its
first clean run - `purged device=…-ms8xyqkk-2rwh groups=3 queued=124`, and the platform now holds
**zero** memberships without a key package. `auth_db` is **29 MB** after `VACUUM FULL` (was 103).
Root cause, the `deviceAddressability` predicate, the three minting seams it guards and the SQL fault
the first deploy exposed are all in
[cross-client-testing > how big the queue gets](docs/wiki/cross-client-testing.md#how-big-the-queue-gets---and-it-was-not-by-design-wp-ghost-1).
The rules it taught are in DURABLE RULES; do not re-derive any of it.

**WP-NOTIF-1 (P2) is SHIPPED and VERIFIED ON THE DEVICE 2026-08-07** (NOTIF-4 PASS, dismissed 263 ms
after the read, `shadeBefore 1 -> shadeAfter 0`). An Android notification was not dismissed when the
message was read elsewhere, whenever the read receipt failed to decrypt - the dismissal sat BELOW the
decrypt ladder although it only ever needed the cleartext `silent` + `senderId` fields. iOS was
already correct. The story, the 18th harness fault (`document.hasFocus()` is false in BOTH browsers,
so a read receipt could never be emitted - now `Emulation.setFocusEmulationEnabled`) and why that
fault was NOT the cause are in
[cross-client-testing > the NOTIF phase](docs/wiki/cross-client-testing.md#the-notif-phase-2026-08-07).
The rule went to DURABLE RULES. **NOTIF-9 also PASSES** (one notification, one copy on W1).
**NOTIF-10 FAILED and is NOT a bug yet** - its `counts: [0,0,0,0,0]` was read off the phone's FEED,
because the app had restarted onto `/posts` when the radios came back, so it measured nothing. Real
from that run and worth the re-run: only 1 of 5 messages notified, and nothing after reconnect.
Presence of the five on A1 is UNKNOWN - the re-count timed out in `openDM` from the feed. **Re-run
it, asserting the conversation is on screen before counting.** NOTIF-1/2/3/5/6/7/8 have not been run.

- \[ \] **WP-STORAGE-1 (P2 today, P1 the moment usage grows) - THE BACKUP SCHEME FAILS BEFORE THE DATA
  DOES.** Answer to the user's question of 2026-08-06 ("can the server hold several hundred users").
  The whole model, every measured unit cost and the three scenarios are in
  **[storage-forecast](docs/wiki/infrastructure/storage-forecast.md)** - do not re-derive or re-measure
  it. The one sentence: `backup.sh` tars the ENTIRE MinIO volume nightly and keeps 15 copies, so every
  live byte costs **16 bytes** on a 125 GB disk, and at 400 daily users the disk fills in **9 to 34
  days** in EVERY scenario including the most conservative - before media ever reach their plateau.
  Media are 87 % of the total; encrypted blobs are incompressible, so gzip buys nothing and dedup buys
  everything. **Ordered actions, highest leverage first:** (1) stop re-archiving MinIO nightly - use
  `restic`/`borg`/`rclone sync`, keep the 14-day full scheme for the 29 MB `pg_dump`; this is config
  only and divides the requirement by ~16; (2) cap + re-encode images CLIENT-SIDE before encryption in
  `frontend/src/lib/media.ts` (measured p90 4.25 MB, max 8.06 MB - raw phone photos), the only lever
  that touches the live figure; (3) content-linked media deletion, which does not exist at all today -
  message delete and account delete leave the blobs, which is a GDPR point as much as a storage one;
  (4) Redis `maxmemory` + `volatile-lru` (it is `0`/`noeviction` today); (5) autovacuum on
  `queued_message` (~132 k churn/day at that scale). `docker system prune` frees 5.45 GB right now.
  **One thing needs the USER, not a fix:** media are GC'd after 30 days of no access, so a new device
  or a reinstall sees no image older than 30 days, silently. That is what makes the forecast
  survivable and it may not be intended - section 6 of the page.

- \[ \] **WP-DRAIN-2 (P2) - the inbound drain still has no watchdog, so ANY hung await inside it
  stops every inbound message with no diagnostic.** What is left of WP-HIDDEN-1 and WP-DRAIN-1, both
  shipped and verified (`d1bedee1`, and the deadlock via `startRecovery`) - the stories are in
  `CHANGELOG.md` and
  [cross-client-testing](docs/wiki/cross-client-testing.md#root-cause-found-2026-08-06-a-backgrounded-tab-stops-receiving-silently-wp-hidden-1).
  `isDraining` is lowered only when the message callback RETURNS, and two different awaits inside it
  have already frozen all inbound traffic - a `requestAnimationFrame` yield in a hidden document, and
  a recovery re-acquiring the MLS mutex the drain holds. Each was fixed in place; the SHAPE was not.
  The flush belongs behind `isDraining = false`, or the queue needs a watchdog that reports a drain
  that never completed. Nothing type-checks that the next await added there is safe.

- **Two tabs (WP-MULTITAB-1) is SHIPPED and VERIFIED ON PROD** (`260084c5`, 9/9 where it lost 4 of 9,
  with both tabs' logs read to prove the delegation). **Future, NOT scheduled - evaluate relevance
  and cost before starting:** one MLS client in a SharedWorker, shared by every tab. It removes the
  class outright rather than gating each write path one at a time, and nothing type-checks that a
  new path went through the queue. Cost is why it is not the fix: the worker transport, startup, the
  PIN unlock and the Safari/mobile fallback where `SharedWorker` is absent all have to be redone.

**WP-DEPLOY-1 is CLOSED**: the GitHub Actions outage of 2026-08-06 is over, the dispatch went green,
and every CD run since has succeeded. **v0.13.1 was RELEASED 2026-08-07** and all five workflows are
green - bump 18 s, CD 4m58, AppImage 10m04, iOS 13m32, Android 13m45 - with the four artefacts
attached (`.aab`, `.apk`, `.ipa`, `.AppImage`), prod answering `{"version":"0.13.1"}` and every path
shape probed 200 with the right content type. `minClientVersion` stays at **0.13.0** on purpose: the
store rollout has not reached devices, and raising it first locks everyone out. **Reload BOTH browsers
before measuring anything** - a long-lived tab keeps its old bundle, and a priming send made by the
old build writes no checkpoint.

- **WP-ANDROID-SESS-1 is SHIPPED and ALL THREE defects VERIFIED ON THE DEVICE 2026-08-06** (a dead
  session no longer looks signed in; the 401 was a cookie replay one rotation behind, not
  concurrency). Numbers, tables and the third defect - the verdict beating its own handler on a cold
  start - are in
  [cross-client-testing](docs/wiki/cross-client-testing.md#verified-on-the-device-2026-08-06---and-the-verification-found-a-third-defect);
  the rules are in [sessions](docs/wiki/sessions.md). Two facts worth keeping for later runs:
  `[Cookies] flushed after refresh` in the phone's own log is what proves the JNI `FindClass` resolves
  at runtime, and **re-logging the phone in IS automatable** - the Android login opens the SYSTEM
  browser (`openUrl`), so forward CDP to `localabstract:chrome_devtools_remote` and run
  `login.mjs --match cas.emse.fr`. Never `realClick` the CAS fields (the hit test reaches "mot de
  passe oublié" on that layout) - focus by element and assert `activeElement`.

- \[ \] **WP-PENDING-1 (P1) - a catch-up pull that can never make partial progress. FIXED, deployed
  to the phone, and the ONE verification still owed is against a REAL backlog.** A single
  `AbortController(10_000)` wrapped the whole paginated pull, so a backlog bigger than 10 s of
  transfer aborted forever, ACKed nothing, and only grew (5 526 rows = 12 pages; aborts at 10.03 /
  10.26 / 10.30 s). **The server hypothesis is dead** - 8.909 ms on the composite
  `(recipientId, deviceId)` index, and `DELETE 5431` -> 95 rows -> next reconnect in 0.6 s. Now a
  deadline per PAGE, each page ingested and ACKed as it lands (`pageTimeoutMs` + `onPage`, 4 tests).
  **The verification cannot be re-run on A1** - that phone's backlog was deleted to prove the cause,
  so it needs a device that falls behind again. The trap that cost three runs: the abort surfaces on
  Android as `TypeError: Failed to fetch` plus orphaned
  `Uncaught (in promise) The resource id NNNN is invalid` - indistinguishable from a network failure
  by text alone.

- \[ \] **WP-PENDING-2 (P1) - a frame too far ahead was ACKed off the server as delivered. FIXED,
  SEEN firing end to end on the device, and the conversation HEALED (3/3 at 2.9/1.5/4.1 s) - only
  the web deploy is owed.** Full write-up in
  [cross-client-testing > root cause](docs/wiki/cross-client-testing.md#root-cause-a-generation-gap-answered-by-an-epoch-verdict);
  the rule it taught is in DURABLE RULES (epoch and generation are different axes). **Deliberately
  left open, the reason this stays a WP:** `map_decrypt_outcome` in `src-tauri/src/state.rs` - the
  BATCH path used by history replay - still answers `ok: true, data: None` on `SecretReuse`, which is
  the same "a native layer threw the diagnosis away" that hid this bug for a day.

**WP-DEEPLINK-1 (P1) is SHIPPED and VERIFIED ON THE DEVICE 2026-08-07** (`916ed696`; NOTIF-7 killed
re-run **PASS** - conversation + marker 6.2 s after the unlock, 1 copy). `deep-link` had NO entry in
`capabilities/default.json`, so `getCurrent()` - the only path a cold start has - was refused every
time, while `onOpenUrl` (an event, not ACL-gated) kept the backgrounded case perfect. Root cause, the
logcat proof and the two-path table are in
[cross-client-testing](docs/wiki/cross-client-testing.md#root-cause-2026-08-07-the-deep-link-plugin-was-never-granted-its-permission);
the rule went to DURABLE RULES. **Two things survive it.** A fact worth reusing: `notifNav` held its
target across **five minutes** of an unanswered PIN modal, on hardware - the durable-store property,
and the final refutation of the "late subscriber" hypothesis. And **iOS is still owed**: it runs the
same capability file and the same hook, so the fix reaches it by construction, but no check has ever
run there (`check H`).

- \[ \] **WP-RELOAD-DL-1 (P3) - a WebView RELOAD replays the launch deep link. FIXED 2026-08-07, and
  the ON-DEVICE verification is what is owed.** Found in the observation log of the NOTIF-7 re-run,
  not in its verdict: the harness parked A1 on `/posts` and the app was back on `/chat` 4 s later,
  because `checkCurrentUrl` re-published a launch URL **fifteen minutes old** whose target had
  already been consumed. `getCurrent()` means "the last deep link this PROCESS was handed" and the
  Rust plugin holds it for the life of the process; the guard against replaying it was a module
  variable, which a reload wipes - erased by the very event it existed to survive. Reachable in
  production through `MlsFatalErrorBanner`'s reload (the likeliest on a phone), `appVersion.ts`,
  tab-leadership demotion and `Ctrl+Shift+S`. Fixed by `$lib/mobile/deepLinkClaims.ts`
  (`sessionStorage`, whose lifetime is exactly the plugin's), 7 tests, negative control run. Story in
  [cross-client-testing](docs/wiki/cross-client-testing.md#and-the-re-runs-own-log-found-a-second-defect-a-reload-replays-the-launch-deep-link).
  **Owed: it ships with the next APK and the next web deploy; re-park A1 after a deep-link launch and
  assert it stays parked.**

- \[ \] **WP-ECHO-1 (P2) - the SENDER loses its own message across a reload. ROOT CAUSE FOUND and
  FIXED 2026-08-07 (`214592e5`); what is owed is the VERIFICATION.** Found by reconciliation:
  `HUNT06`/`HUNT07` present on the RECEIVER, absent from the sender that sent them. The loss is
  inside `addMessageToChat`, not in any compose path: the `bulkIngestActive` early return buffers and
  returns BEFORE `saveMessage`, `bulkIngestActive` is raised on EVERY inbound drain (not only a long
  one), and the buffer is cleared without flushing by a second drain
  (`beginBulkMessageIngest` clears unconditionally) and by `resetMessageCatchupState`. The outbox
  cannot repair it: `persistSent` -> `findMessage` only scans `conversations`, which a buffered
  message never reached, so it returns without writing. That also explains the MSG-10 asymmetry -
  offline there is no inbound drain, so the echo took the live path and persisted. An own message is
  now never deferred, and both clear sites log what they discard. **Owed: deploy, then re-run
  `recon.mjs` over a batch of sends made DURING a drain** - and the phone, which shares the
  composable. Distinct from WP-LOSS-1 (which loses it at the receiver); do not merge them.

**WP-KBD-1 is SHIPPED AND VERIFIED ON DEVICE 2026-08-07** (a local Xiaomi/HyperOS build, measured
live over CDP both before and after). Reported originally 2026-08-06 (composer behind the soft
keyboard), reported again by the user 2026-08-07 as inconsistent spacing above the composer - same
shell, two related but distinct bugs. **First fix attempt was wrong and was reverted the same day**:
subtracting the shell's own top inset inside `computeSnapshot` "fixed" `.app-layout` in isolation but
double-subtracted the status-bar inset, since `.app-layout`'s own ancestor chain (`+layout.svelte`'s
`h-[var(--app-viewport-height,100dvh)]` wrapper, already structurally reduced by its own
`padding-top`) was *already* correctly shrunk - stacking a second, independent subtraction on top
left a gap the height of the status bar between the shell's real bottom and the keyboard, revealing
the page background through it (a visibly different color - this is what the user's screenshot
caught). **The real fix deletes `html.keyboard-open .app-layout { height: var(--app-viewport-height,
100dvh) }` outright**: `.app-layout` was never supposed to re-consume that variable independently of
its already-shrunk parent chain, and once it just inherits (plain `height: 100%`), the whole nested
chain (`flex-1`/`inset-0`/`height:100%` all the way down) shrinks in lockstep with zero double
counting. `computeSnapshot` is back to the original, simpler `viewportHeight: m.vvHeight`. Confirmed
live via `tools/cross-client-harness/cdp.mjs` (`adb forward` to the WebView's own devtools socket):
`.app-layout`'s rect now lands bottom-exact on the visual viewport's bottom, both before and after.
Second, independent bug found in the same investigation: the phone's nav bar had **no** reserved
gap at all when the keyboard was closed - `MainActivity.kt` never called `enableEdgeToEdge()`, so
whether `env(safe-area-inset-bottom)` was populated for the gesture bar depended on OS-enforced
defaults (Android 15+ only) rather than being guaranteed, and this device's WebView reported 0 for it
regardless. Fixed by calling `enableEdgeToEdge()` in `onCreate` (before `super.onCreate`, same as
`installSplashScreen()`) - it is the SAME assumption already baked into `env(safe-area-inset-*)`
pervasively across this app's CSS, just never made explicit natively. A third, smaller bug rode
along: the composer's own bottom padding floor was `0.75rem` closed vs an undocumented `0.5rem` open
(`app.css`, no rationale in the commit that introduced it, message was literally "fix a lot of
things") - unified to `0.75rem` in both states so the reserved space does not visibly shrink just
because the keyboard opened. Full narrative, every measured number (both live CDP dumps) and the
ancestor-chain trace that found the double-subtraction are in
[mobile > the soft keyboard and the app shell](docs/wiki/frontend/mobile.md#the-soft-keyboard-and-the-app-shell-wp-kbd-1-shipped-and-verified-2026-08-07) -
do not re-derive them.

- **WP-DL-1 (P1) is SHIPPED, and its ON-DEVICE verification of 2026-08-07 FOUND THE REAL CAUSE.** Reported by the user against the PDF on the feed's first
  post, and it was never about PDFs: `<a download>` is handled by the SHELL, and Tauri installs no
  download handler on either platform, so the click dispatched, succeeded, and produced nothing -
  no file, no error, no log line. Eleven call sites, all now on `$lib/utils/fileDownload.ts`
  (`saveObjectUrlAs` / `saveBlobAs` / `downloadDecryptedFile`), which writes through the native save
  dialog on Tauri and keeps the anchor on the web. The rule is in DURABLE RULES; the reasoning is in
  [mobile > rules that hold across both platforms](docs/wiki/frontend/mobile.md#rules-that-hold-across-both-platforms).
  **The device run of 2026-08-07 then found that the anchor was only HALF the story**, and the
  suspects listed here were all innocent: the ACL, the SAF dialog and `fs.writeFile` are fine. The
  real cause is `hooks.client.ts`'s `window.fetch` override rejecting `blob:` - the rule is now in
  DURABLE RULES and in [mobile](docs/wiki/frontend/mobile.md), the predicate is
  `utils/fetchRouting.ts` (pure, 12 tests). Captured on hardware: `[download] failed scheme blob not
  supported`, with a probe proving `window.fetch` is NOT native there while `XMLHttpRequest` reads
  the same blob URL fine. **Check M PASSES** - a multi-page PDF rasterises on Android.

  **STILL OWED on the next APK** (the fix is committed, the phone runs the build from BEFORE it):
  re-run the download and assert a file lands, which is also the first real test of
  `fs:allow-write-file` + the `content://` URI; and the backup export's Tauri branch, which CHANGED
  SHAPE (it used to ask for a DIRECTORY, which SAF does not offer, so its old path may never have
  worked).

- \[ \] **WP-VIEWER-1 (P2) - UNIFY THE IMAGE LIGHTBOX AND THE PDF READER.** Asked by the user
  2026-08-07: "c'est presque la meme interface, ca meriterait d'etre joli, pratique et homogene".
  Two full-screen modals with the same job and two different implementations of every part of it:
  `shared/MediaLightbox.svelte` (417 lines) and `shared/PdfViewerModal.svelte` (~380). **The
  gestures are the concrete debt**: the lightbox has a MATURE pinch/pan - `zoomAt` with a focal
  point, clamped translation, drag panning, wheel zoom, a percentage readout - while the PDF reader
  had none at all until 2026-08-07, when it got a deliberately CRUDE one (two-finger distance ratio,
  live CSS transform, settle to the nearest of four discrete steps). **That crude gesture is to be
  REPLACED by the extracted shared one, not kept** - it exists only because the user reported that
  pinching did nothing and the fix could not wait for this WP. The real difference to respect: a
  photo is one bitmap that may be scaled continuously, a PDF page is RE-RASTERISED per zoom level
  (sharp text is the whole reason pages are not upscaled), so the shared gesture must expose a
  continuous live scale AND a settle callback the PDF binds to its step list. Chrome to share
  besides: the header (title, page/percentage readout, zoom pair, download, close), the safe-area
  padding, the backdrop + focus trap + Escape, and the download button routing through
  `utils/fileDownload.ts`.

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
