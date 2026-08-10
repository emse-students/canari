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
- Language: Code, comments, docs, and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline string literals, ALWAYS, even in a plain `.ts` util with no Svelte in sight, and even when a nearby call site you're extending (e.g. `showConfirm(...)`) has pre-existing raw-string calls elsewhere - that inconsistency is not license to add another one.
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

### NEXT SESSION - START HERE (pruned 2026-08-10)

Shipped work is DELETED from this file. Its story is in `CHANGELOG.md` under `[Unreleased]`, the rule
it taught is in DURABLE RULES below, and the narrative is on the wiki page each entry points to.
**Do not reconstruct it here.** What follows is only what is OPEN or OWED.

**THE ORDER THE USER SET (2026-08-10) governs the next sessions:** (1) finish the escalation chantier
- DONE, `3be41156` + `b138f35a`, pushed; (2) do everything in the roadmap below, **the P1s first**;
(3) then **re-run the cross-client campaign from the START (post-setup)** - the scripts exist now, so
it should be fast, and it exercises everything. Commit AND push are authorised so prod picks changes
up: **prod IS the test server** until a `dev.canari-emse.fr` exists.

**FOUR DECISIONS THE USER TOOK 2026-08-10 - do not re-ask, do not re-litigate:**

1. **The orphaned queue: DELETE the rows AND add a TTL.** A targeted `DELETE` scoped to the abandoned
   profile's `deviceId` (28 136 rows, 96 % of the whole prod queue, last active 2026-08-08), after a
   row count and a `pg_dump` check - then a maintenance job reaping frames addressed to devices with
   no key package. The WP-GHOST-1 predicate already proves that set is well-defined.
2. **WP-STORAGE-1's backup rewrite: BUILD IT AND PROVE A RESTORE, then show the user before any
   cutover.** The new scheme runs ALONGSIDE the tar; the tar is retired only after a restore has been
   demonstrated from the new repo. Not a free hand on prod backups.
3. **The 30-day media GC STAYS, but it must stop being silent.** Render an explicit "this image is no
   longer available" state instead of a gap. It is a lie today, not a limitation - section 6 of
   [storage-forecast](docs/wiki/infrastructure/storage-forecast.md).
4. **The phone is available this session** - the user offered to plug it in, so the Android P1s and
   LIFE-5 come before the rest of the browser roadmap.

**One observation from the user, NOT yet a WP** (2026-08-10): a conversation HEADER was rendered for
a conversation they were not actually inside ("l'UI etait trompeuse, on avait le header de la
conversation avec Claire mais nous n'etions pas dedans"). They were unsure. Check whether
`selectedContact` and the header can disagree before opening anything.

#### What the escalation chantier settled (2026-08-10, shipped - do not re-derive)

A rewound sender lost frames and the repair for it became a storm on prod: ~450 frames/min on W1,
~300-450 control messages per 30 s on W2, 324 `LOST frame` on the phone, nothing being repaired. Two
causes, both now deleted rather than tuned, both written up in
[chat > there is ONE repair](docs/wiki/frontend/modules/chat.md) and
[cross-client-testing > DONE 2026-08-10](docs/wiki/cross-client-testing.md):

1. **One question answered by nine clocks**, two of them retry ladders driving the same request, so
   traffic was their product - and the cheap rung (`decrypt_failed`) could repair nothing by
   construction. One repair now (the history diff), one request per state edge, idempotence from the
   durable marker, termination from the empty diff.
2. **The diff's fallback mode sliced by MONTH**, i.e. by a value the two devices do not agree on, so
   a clock skew across a boundary re-sent two whole months on every exchange forever and the diff
   could never empty. It slices the ID SPACE now (`historyRangeOf`), which is identical on both sides.

Both rules are in DURABLE RULES. **Everything below is a MEASUREMENT that is owed, not a fix.**

#### OWED, in order

**DONE 2026-08-10, do not re-run:** HEAL on the browser is `HEALED - 14/14` with `history diff
ran=true`, `narrow retransmission=false` and `ids mode, 554 id(s)`; the frame-rate half is green too
(14 console lines / 60 s per browser against ~450 frames/min). `wasmLogShim` is DELETED - eleven
arrivals through the thrown error, zero through the flag, and the route is unreachable by
construction after `same_epoch_ratchet.rs`. The full trace is in
[cross-client-testing > HEAL, settled](docs/wiki/cross-client-testing.md). What every future run of
this check still needs: `bundle-id.mjs` FIRST (it refused to measure twice, correctly); the responder
is elected by a random shuffle (`messaging.service.ts:1372-1382`), so record WHICH device answered;
the BREAK is a restored older snapshot of `CanariDBMls_<dev>` (`mlsdb.mjs`) and the teardown restores
the INVARIANT, never a snapshot (`ensureDeliverable`); the test DM may be deleted and recreated.

1. **Four HEAL checks are still owed**, section 7.1: epoch gap, unknown group, generation gap, and
   the pair nothing has ever exercised together (a recovery while a SECOND tab holds the leader role).
2. **The phone: one background/foreground cycle** (WP-RECONNECT, shipped) - watch it re-arm.
3. **The remaining P1s** in OPEN WORK PACKAGES below.
4. **Convergence measurements the user asked for explicitly** (2026-08-07): `recon.mjs` for the
   per-thread marker diff W1 vs W2; `SELECT recipientId, deviceId, count(*) FROM queued_message GROUP
   BY 1,2` on prod against what each client shows; `DeviceGroupMembership` against live key packages
   (the WP-GHOST-1 predicate - the platform should still hold ZERO memberships without one, VERIFIED
   2026-08-10).
5. **Then the campaign re-run.** The phase dashboard at the top of
   [cross-client-testing](docs/wiki/cross-client-testing.md) is the source of truth, not this file.
   **LIFE-5 needs the USER** (the unlock pattern after a reboot) - pause and ask, never work around it.

Small items still owed, each one check: the **backup export's Tauri branch** (WP-DL-1's last case -
it used to ask for a DIRECTORY, which SAF does not offer); Leon's **WP-SAFELINK-1 `LinkPreviewCard`
case** and his **WP-OIDC-TAB-1 mobile pass**.

#### The rig - RE-VERIFY each line, do not rebuild it

The harness is archived at `tools/cross-client-harness/` (its README covers the rig) and the working
copy plus the ~60 one-shot `probe-*` scripts are in the scratchpad. `heal-web.mjs`, `mlsdb.mjs`
(in-page IndexedDB snapshot/restore, bytes never leave the browser), `recon.mjs`, `storm.mjs`,
`pin.mjs`, `watch.mjs` all exist - reuse them.

- **W1 (9224) / W2 (9223) must be RELOADED onto the current bundle** before any repair check, and
  relaunched with occlusion detection off if restarted (flags in the campaign page). A relaunch keeps
  the login but re-locks the PIN - `pin.mjs`, and `--account jolan` for A1, not the default `claire`.
- **`connect()` in `cdp.mjs` is NOT ready-aware** - use `client(port)` from `chat.mjs`. (Cost two runs.)
- **A1 over adb TCP is what makes a session stable**: `adb tcpip 5555` + `adb connect <ip>:5555`;
  wifi IS available at this location. Both transports attached means **every `adb` call needs `-s`**.
  The WebView pid changes on every cold start - re-read `/proc/net/unix | grep webview_devtools` and
  re-do `adb -s <tcp> forward tcp:9222 localabstract:…`. USB serial `2A251JEGR05373` (Pixel 6a) is
  still the fastest for `install -r`, and this device's USB link drops on its own.
- **Use PowerShell for adb shell commands carrying an absolute device path** - Git Bash rewrites
  `/sdcard/x` to `/Files/Git/sdcard/x`. Same class as the prod-SSH rule.
- Rebuild: `bun tauri android build --target aarch64 --debug` in `frontend/`, install
  `.../apk/universal/debug/app-universal-debug.apk` (NOT `arm64/`, stale). Package `fr.emse.canari`.
  **The version name no longer moves** - the discriminator is `lastUpdateTime`. Every build leaves a
  Gradle daemon (idle timeout now 10 min). `bun run test` fails with locale mismatches after an
  Android build - `bun run paraglide:compile`, re-run.
- **Never run an Android/iOS build next to anything else that builds the frontend** -
  `beforeBuildCommand` IS `bun run build`, and two builds writing `build/` ship an app that cannot
  boot. `scripts/check-bundle-consistency.mjs` now fails the build instead.

---

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement - never assume the local `main` is the deployed truth. His commits are usually style/UI
and land in files the campaign measures, so what is owed for each is a WEB and a MOBILE pass logged
next to our own checks. He follows the conventions, so a rebase is normally clean; the thing to verify
is his change RUNNING, which no test of his can establish.

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

The plan, the harness, every check and every defect it produced are in
**[cross-client-testing](docs/wiki/cross-client-testing.md)**, which OPENS with a "Where this campaign
stands" dashboard. **Read that dashboard rather than re-deriving the state here** - do not maintain a
second copy. State: Phase 0/MSG/FWD/TAB complete, LIFE done except LIFE-5 (needs the user), NOTIF
partly (2/3, 5, 6 left, plus the NOTIF-10 re-run), then HEAL/PIN/MULTI/CORRUPT - though the user has
asked for the whole thing to be RE-RUN from the start once the roadmap is clear.

What a compaction must not lose:

- Runs against **PRODUCTION**, two real accounts, credentials in the scratchpad
  `test-accounts.json`, **never in the repo** (gitignored in both copies; no password is ever a
  tool-call argument, which is why W1 moved off the chrome-devtools MCP).
- **EVERY test message goes in the two-test-account DM, and NOWHERE else** (user, 2026-08-10). A
  one-off probe run in a colleague's conversation because it was convenient fired a "dangerous link"
  warning into a real person's thread. `openConversation(w1, 'Claire')` / `(w2, 'Jolan')` is what
  every campaign script already does. For anything needing a CHANNEL, the venue is the
  `Campagne de test` community, never MiTV - a private channel is readable by every association
  admin (section 11 of the wiki page).
- **OBSERVATION IS PART OF EVERY CHECK, not a debugging step** (`watch.mjs`, wiki section 9). A
  verdict is `PASS` only if the assertions hold AND the run is clean; a line that turns out to be
  routine is ADDED to the benign list, never ignored in place. Two shipped bugs came out of a green
  check's noise.
- **RECONCILIATION is the only way this campaign's loss class can be SEEN** (`recon.mjs`): markers on
  W1 diffed against markers on W2 for one thread, re-run after any batch of sends. It found WP-LOSS-1
  and WP-ECHO-1, and no per-check verdict substitutes for it. Two corrections it needed and must keep:
  the list is VIRTUALISED (accumulate at every scroll position, one read returns a screenful), and
  the diff must be BOUNDED to the window both sides cover. **A diff between unequal windows looks
  authoritative and is noise.**
- **An offline RECEIVER cannot be faked in the browser** - `emulateNetworkConditions` fails new
  requests in 10 ms and W2 still rendered the message twice. MSG-9 belongs on the phone
  (`svc wifi disable` + `svc data disable`), which needs adb on **USB**.
- **`am force-stop` is NOT "the user killed the app"**: Android's STOPPED state cancels every FCM
  broadcast until a manual launch. Use a SWIPE from recents or `am kill` - and `am kill` does not
  reclaim a FOREGROUND process, so go HOME first and assert the death. The phone's whole web console
  is in logcat under `Tauri/Console`; capture continuously to a file, a busy device overruns the ring
  in minutes.
- **Re-logging the phone in IS automatable**: the Android login opens the SYSTEM browser, so forward
  CDP to `localabstract:chrome_devtools_remote` and run `login.mjs --match cas.emse.fr`. Never
  `realClick` the CAS fields - focus by element and assert `activeElement`.
- **THIRTY-ONE harness faults have produced a false result, all fixed and all written up in the wiki
  page** (search "harness fault"). Do not re-derive them; these are the rules they add up to:
  - **A VERDICT MUST NEVER BE COMPUTED OVER A PROJECTION OF ITS OWN EVIDENCE** (#31). `heal-web.mjs`
    filtered the console through a display regex and then ran its matchers over the FILTERED text, so
    a line the matcher accepts but the filter drops was invisible - `escalated=false` on a run whose
    diff demonstrably ran. A capture filter is presentation; the verdict reads everything.
  - **When a check's BREAK is not invertible, the teardown restores a PROPERTY, never a snapshot**
    (#30). Rewinding a sender cannot be undone by restoring any state - the peer consumed generations
    off the fork while it was live, so no snapshot is both legitimate and ahead of it. Ask what the
    next run actually needs ("can W1 deliver?") and assert that, on every exit path.
  - **A matcher tests one SPELLING; the absence of an entire VOCABULARY is evidence about the app.**
    A stale matcher is the right first suspicion (#29's third bullet) and it is cheap to rule out -
    grep the log for every word the mechanism could have used, not for the one string the check does.
  - **A check that puts the app through a transition must restore every precondition that transition
    destroys** - a kill, a reboot, a radio cycle and an `install -r` all re-lock the PIN. A
    precondition found by one check belongs to every check sharing the transition.
  - **An action that cannot prove it took effect still yields a verdict, and that verdict is
    fiction.** Every action asserts its own post-condition.
  - **"Did the state change" is almost never the assertion; "did it change into the RIGHT state" is.**
    Validate a check as a NEGATIVE CONTROL against the unfixed build before its green means anything,
    and set its tolerance from those two measurements rather than from taste.
  - **Assume a green check is wrong until its evidence says otherwise - and a FAIL too.** Check the
    fixture and the selector before blaming the app.
  - **A locator is a guess unless it is disambiguated - and a DEVICE is a locator.** Name an element
    from the component SOURCE, never from what the markup ought to be, and scope a selector shared by
    two surfaces (`.chat-composer-footer .chat-composer-editor`, not the bare editor, which is also
    on `/posts`). A locator failure does not bias the verdict in a predictable direction.
  - **CDP's Network domain is BLIND to the app's own requests on mobile** - `hooks.client.ts` swaps
    `window.fetch` for the Tauri plugin's RUST client. Record from INSIDE the page, inject failures
    there too, and keep such navigation CLIENT-SIDE or the reload takes the patch with it.
  - **A virtualised count needs a FRESH MOUNT and the max over repeated polls**, and a baseline needs
    a polled budget rather than a fixed wait (#28/#29).
- **Restore Firefox as the device's default browser when the campaign ends**
  (`cmd role add-role-holder android.app.role.BROWSER org.mozilla.firefox`); it was switched to
  Chrome because Firefox exposes no CDP.

A check that FAILS earns a WP with its captured log; a check that passes earns a row in section 10
and nothing else.

**[device] The verification pass is NOT a Work Package.** Everything native is verified by COMPILING,
which proves nothing about running; the owed list is
**[device-verification](docs/wiki/device-verification.md)** - checks B-P with the verdict line of
each. Android passed the ladder on v0.11.7; **iOS has never run one check on hardware**. Owed on
both: H (deep link into the conversation), K (quick reply), L (revoked device re-enrolling), N
(offline unlock + promotion), O (the store/update destination), P (the iOS cookie jar). **Open a WP
only when a check FAILS**, and only with its captured log. Capture tool: `test_adb.py` at the repo
root. The four human checks left from the SEO work are the same shape -
[seo > what no test here can prove](docs/wiki/frontend/seo.md#what-no-test-here-can-prove).

**Release status:** v0.13.1 released 2026-08-07, prod answering `{"version":"0.13.1"}`.
**`minClientVersion` stays at 0.13.0 on purpose**: the store rollout has not reached devices, and
raising it first locks everyone out.

---

### CANARI - OPEN WORK PACKAGES

- \[ \] **WP-LOSS-1 (P1) - both halves SHIPPED; what is left is verification.** A reload rewound the
  sender's ratchet and the receiver silently dropped the next message. Root cause, the tables, the
  retired hypotheses and both halves of the fix are in
  [cross-client-testing > root cause](docs/wiki/cross-client-testing.md#root-cause-found-2026-08-06-a-reload-rewinds-the-senders-ratchet).
  Do not re-derive it, and do not re-open the load hypothesis or "forwarding is special": both are
  dead. The sender half is VERIFIED on prod (3/3 delivered where it lost 2/2) - do not re-verify it.
  **Owed:** a LOSS-branch verification (no reproduction has produced one since the sender fixes
  landed, which is itself the point); the **ANDROID** half - the phone's detection is VERIFIED
  (2026-08-10, 13 `LOST frame … (SecretReuseError)` lines where there were zero) but no phone run has
  exercised the repair end to end since. **One deliberate gap, not a defect:** nothing tells the
  receiver's USER that a message was lost.

- \[ \] **WP-PENDING-1 (P1) - fixed and deployed; the ONE verification owed is against a REAL
  backlog.** A single `AbortController(10_000)` wrapped a whole paginated pull, so a backlog bigger
  than 10 s of transfer aborted forever, ACKed nothing, and only grew. Now a deadline per PAGE, each
  page ingested and ACKed as it lands. **The server hypothesis is dead** - 8.909 ms on the composite
  `(recipientId, deviceId)` index. **The verification cannot be re-run on A1** (that phone's backlog
  was deleted to prove the cause), so it needs a device that falls behind again. The trap that cost
  three runs: the abort surfaces on Android as `TypeError: Failed to fetch` plus orphaned
  `Uncaught (in promise) The resource id NNNN is invalid` - indistinguishable from a network failure
  by text alone.

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

**Known and deliberately NOT a WP yet** (do not "fix" these by reflex):

- **A device only asks for history when something TELLS it to.** The four triggers are a decrypt
  failure, a fresh join with no local store, being elected as a responder and finding the peer holds
  more (`peer-holds-more`), and a reconnect re-soliciting an existing marker. So a device holding
  SOME of a conversation, missing older messages and never failing to decrypt carries no marker and
  never asks - it converges only once something else has elected it. Narrower than it was (one
  election now leaves a durable marker that the reconnect seam and the 15-minute sweep keep working),
  but not closed. Do not "fix" it with a periodic unconditional solicitation: that is a broadcast on
  a timer, which is the exact shape this area was just cleared of.
- **`history_request` is deliberately NOT made durable** the way `welcome_request` is (Redis + FCM):
  a stored request drained hours later has no digest (60 s rendezvous TTL), so the responder falls
  back to the full-store dump the diff exists to remove, for a device that may need nothing - and the
  requester must reconnect to read anything anyway, which re-solicits. The related half: a missing
  Welcome BLOCKS a group, missing history only degrades it.
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
  answer `Ok(None)` where the shared classifier could have decided. **This rule was written here and
  then broken for months by `mls-core` itself** (2026-08-10): a layer that cannot make a distinction
  must not make it, and the guard is `same_epoch_ratchet.rs`, not a comment. A test that asserts the
  swallow will happily protect the bug - this one did.
- **A device that has not noticed its own gap will vouch for its store.** `announceComplete` is the
  only claim that clears a proven marker, and the guard against making it wrongly (`actions.ts:1044`,
  "am I awaiting history myself?") is only as good as the claimant's own detection. A silent failure
  upstream does not merely lose data on that device - it promotes it to a trusted witness for
  everyone else's repair.
- **A responder is elected at RANDOM among all online devices except the requester's own**
  (`messaging.service.ts:1372-1382`), so any check on a repair must record WHICH device answered.
  Two runs of one check can exercise two different code paths on two different machines, and the
  greener verdict is the one that says less.
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
- **A REPAIR LADDER MUST BE ORDERED BY WHAT EACH RUNG CAN FIX, NEVER BY WHAT EACH COSTS - and a rung
  that can fix NOTHING is deleted, not demoted.** Cheap-first is only sound when the cheap rung has a
  real chance, and the way to check is to read its TRIGGER: `signalDecryptFailure` had one call site,
  the rewound-sender branch, so the peer it asked was by construction the peer that could not answer
  - it re-encrypts at the same rewound ratchet. Measured twice on prod: 1, then 5, 15 and 25 payloads,
  none delivered. Its only success mode was the sender burning past our high-water mark on its own,
  i.e. recovery by exhaustion. **So the whole ladder is gone (2026-08-10)**: `decrypt_failed`,
  `retransmitRecentSends`, `recentSends` and the `isRetransmission` flag are deleted, and the
  history diff - which reads the peer's DURABLE store and names messages by id - is the ONE repair.
  A repair addressed by TIME is a broadcast, because a window cannot name its target, and it can only
  be as durable as what it reads.
- **IDEMPOTENCE COMES FROM DURABLE STATE, TERMINATION FROM A PROOF - never from a clock.** One
  question ("what am I missing, and who has it") was answered by NINE independent durations across
  three files, two of them retry ladders driving the same request, so the traffic was their product.
  The rule that replaced them: one request per STATE EDGE, the durable `awaitingHistory` marker makes
  a second one a no-op, and each diff exchange strictly reduces the symmetric difference, so the
  empty diff - the only thing entitled to clear the marker - is reached by construction rather than
  by budget. A duration is legitimate only when it schedules NO traffic: `REQUEST_TIMEOUT_MS` exists
  solely to notice an attempt went unanswered, and `INITIAL_SOLICIT_DELAY_MS` is an epoch-ordering
  constraint, not a backoff. Ask of every timer what it would mean if it were wrong; if the answer is
  "more traffic", it is load-bearing and it should not be.
- **BUT THE DURABLE STATE IS IDEMPOTENCE ONLY FOR THE QUESTION IT WAS WRITTEN TO ANSWER, AND THE TWO
  QUESTIONS CAN DIFFER ONLY IN LIFETIME.** The rule above was applied one line too far: the guard
  became `if (isAwaitingHistory(...)) return` in front of the loss trigger. The marker answers "is
  this group short of history" (durable, cleared only by an empty diff); it was asked "have I already
  asked" (30 s). So on any group that had EVER been broken the marker was already standing when the
  next frame was lost, and the one trigger that fires on the loss itself never fired again - twelve
  `LOST frame` lines and ZERO solicitations on prod, the 15-minute sweep left pretending to be the
  mechanism. "Is an attempt outstanding" has exactly one witness, `isSolicitInFlight` (scheduled, or
  inside the response window). Same family as `updatedAt` and the epoch-verdict rule, with the twist
  that both answers were TRUE - only the questions differed. `setupMessageHandler.lostFrame.test.ts`.
- A cause is not a label: `pending-offline` meant both "the request never left" and "it left and
  nobody answered", and the string named the first, so a silent peer was reported as an empty room.
  Two causes under one label is a WRONG answer, not a vague one - it points the user at the wrong fix.

#### UI and i18n -> [frontend/architecture](docs/wiki/frontend/architecture.md), [auth](docs/wiki/frontend/modules/auth.md) (native prompts)

Tokens, the one-way-colour sweep, the portalled dropdown, Svelte's whitespace trim and the native
prompt fields are all on those pages. What must not be forgotten between them:

- A one-way colour is a dark-mode bug waiting to happen; use the `app.css` tokens - and the 31 the
  sweep left are DELIBERATE (switch thumbs, colour-picker handles, always-dark call/lightbox chrome,
  the white plate behind a QR). Do not "fix" them.
- Nothing types a string as user-visible, so no compiler enforces Paraglide - and no user-facing
  string names a sensor ("empreinte ou Face ID" is wrong on every device, half the time). Default
  to Paraglide for ANY new user-visible string without being asked, on the first draft, not as a
  follow-up fix - a `showConfirm(...)` message and its custom button label were shipped as raw
  French literals (WP-SAFELINK-1), copying the shape of that store's own ~21 other call sites,
  none of which are Paraglide either; that existing pattern is not a precedent to extend.
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
- A safety check with an unrelated failure mode from the fetch it would ride along with needs its
  OWN endpoint, not a field bolted onto the existing response: `getLinkSafety` is decoupled from
  `getLinkPreview` precisely so a page with a broken `<title>` (which makes the preview throw)
  cannot take the Safe Browsing verdict down with it (WP-SAFELINK-1). And a check with no cache
  guidance from the upstream API for the COMMON case (Google gives a `cacheDuration` only for a
  flagged match, never for "clean") still needs an explicit, own TTL - inventing a number rather
  than caching it forever or not at all.

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
- **Two frontend builds writing `build/` at once ship an app that cannot boot, and every gate is
  green.** SvelteKit's per-build `__sveltekit_<id>` names a global the HTML writes and the chunks
  read; mixed, `kit.start()` throws `Cannot read properties of undefined (reading 'data')` and a
  phone sits on the splash forever. `bun run build` now ends with
  `scripts/check-bundle-consistency.mjs`. Never run an Android/iOS build next to anything else that
  builds the frontend - `beforeBuildCommand` IS `bun run build`.
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
- A native thread has NO JAVA FRAMES on its stack, so `FindClass` from a JNI-attached Rust thread
  only reaches boot-classpath FRAMEWORK classes (`android.webkit.CookieManager`), never an
  app-bundled class - not `MainActivity`, not an AndroidX library class like
  `CustomTabsIntent`. Calling one of those reliably needs Tauri's own plugin-invocation path
  (`@TauriPlugin`/`Plugin(activity)`), which already runs with the right classloader context - not
  a raw `JNI_OnLoad`-cached `JavaVM` and a hand-rolled `attach_current_thread` (WP-OIDC-TAB-1).
- A plain system-browser launch (`openUrl`) is an ORPHANED activity on Android: it opens in a
  separate task the calling app has no relationship to, so nothing on either side can dismiss it
  once the flow that needed it is done. A Chrome Custom Tab launched via `CustomTabsIntent`
  shares the LAUNCHING APP'S OWN TASK, which is what lets the OS close it automatically the
  instant that task's activity resumes to the foreground (confirmed via
  `dumpsys activity activities`: the tab's `ActivityRecord` shared the app's task id before
  login, and was gone from the task's history entirely after the deep-link return) - the
  right fix for "a login tab is left behind" is never a dismiss call, it is putting the tab in
  the right task to begin with.
- **A PAUSE MUST HAVE A SYMMETRIC RESUME, and a circuit breaker must never cut the wire to its own
  reset.** `pauseConnection` stopped both watchdogs on every background; nothing re-armed them, so
  one background/foreground cycle left a phone with no timer able to notice a dead socket. Then the
  reconnect circuit latched open with only the login paths able to close it - while the watchdog,
  the one thing whose job was to notice, reached through `scheduleReconnectImpl`, which the latch
  turns off. Ask of every breaker WHO closes it, and check that party is not itself disabled by it.
  Corollary that made this invisible: an app can be fully alive on HTTP and dead on its socket, so
  "the network works" is never evidence the connection does.
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
  **A THIRD place is just as mandatory and easy to forget: the service's own `environment:` block
  in `infrastructure/docker-compose.prod.yml` (and `.dev.yml` for parity) must also name the var
  explicitly** (`FOO: ${FOO:-}`) - `.env` having the value proves nothing about whether Compose
  passes it into the container. `GOOGLE_SAFE_BROWSING_API_KEY` shipped correctly in `cd.yml` and
  `.env.example` and was still absent from `docker exec ... env` on prod (WP-SAFELINK-1) because
  this third step was skipped; the endpoint answered 200 with a wrong, silently-fail-open verdict
  the whole time, not an error - `docker exec <container> env | grep FOO` is the only way to catch it.
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
