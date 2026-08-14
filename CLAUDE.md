# **Canari \- Rules & Session State**

> **The hard-won rules are in [docs/wiki/durable-rules.md](docs/wiki/durable-rules.md)** - 600 lines
> of constraints, each written after something broke, indexed by area and linked to the page that
> carries the reasoning. **Open the section matching what you are about to touch, before you write
> anything.** This file keeps only what applies to EVERY task, plus the live session state.

## **AGENT DIRECTIVES**

- NO BLIND GREP: Never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: State assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: Touch ONLY requested code. Map changes 1:1 to the prompt.
- STATE PRUNING: When updating the roadmap, DELETE detailed descriptions of completed tasks. Keep the file small.
- CLAUDE.md HYGIENE: Actively trim this file - it is capped at ~250 lines on purpose. A rule that needs a paragraph belongs in `docs/wiki/durable-rules.md`; a story belongs in `CHANGELOG.md`; a measurement belongs on the topical wiki page. Delete shipped Work Packages outright.
- UPDATE STATE: Update SESSION STATE at the bottom of this file before finishing a Work Package.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> `git add . && git commit -m "[summary]"` -> Update SESSION STATE -> STOP (compact)
- DOCUMENTATION: Technical docs live in `docs/wiki/` (English, LLM-oriented, preferred search before code). User-facing guides in `docs/user-guide/` (French). UML diagrams in `docs/diagrams/`. Root-level docs: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- CHANGELOG: When adding features, fixing bugs, or making breaking changes, add an entry under `[Unreleased]` in `CHANGELOG.md` (Keep a Changelog format). Move to a version section on release.
- WIKI IS PREFERRED: Always search `docs/wiki/` before reading source code. Update the relevant wiki page alongside code changes - stale wiki is worse than no wiki. Cross-link freely between pages.
- SERVICE READMES: Each `apps/*/README.md` should stay synced with its wiki counterpart. If you expand the wiki page, reflect the summary in the README.
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` (Le Cercle, via ProxyJump canari). Postgres db is `auth_db`, user `canari` (NOT `postgres`, and not the `admin` of `.env.example`, which is local-only). **Use the PowerShell tool, never Bash** - Git Bash strips the backslashes out of the cloudflared ProxyCommand path and the exec fails. Quote SQL with a SINGLE-quoted outer string and doubled literals: `ssh canari 'docker exec … psql -U canari -d auth_db -x -c "SELECT … WHERE id = ''uuid''"'`.

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
- Language: Code, comments, docs, and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline string literals, ALWAYS, even in a plain `.ts` util with no Svelte in sight, and even when a nearby call site you are extending has pre-existing raw-string calls - that inconsistency is not license to add another one.
- Punctuation: Normalize to ASCII (`'`, `"`, `-`) everywhere; escape quotes in code (`\'`, `\"`). Preserve French accents (`é`, `à`) ONLY in localized strings/French comments.
- Tests: Changing logic requires changing the associated test. Stale assertions will fail CI.
- UI: Single source of truth is `src/app.css` (tokens, `--radius-*`). Use `.btn-glass` with modifiers. Dark-first glassmorphism. Avoid raw hex/px. `lucide-svelte` only (no aliases).
- Husky: Pre-commit runs oxlint + oxvelte + oxfmt + svelte-check. Fix errors; do not bypass.

## **KEY COMMANDS**

- Package manager: frontend uses bun (committed bun.lock, CI --frozen-lockfile); Makefile shells out to npm - both work. Prefer bun locally.
- Setup/Dev: make install, make run-services, cd frontend && bun run dev
- Tests: make test (All), make test-frontend, cargo test
- Frontend gates (before every commit): bun run check (0 errors), bun run lint, bun run format. Rust >= 1.97 (`rust-toolchain.toml`). cargo clippy for Rust crates. The pre-commit hook runs oxfmt+oxlint+oxvelte+check across the WHOLE frontend (~2-3 min) and re-stages - isolate unrelated dirty files before committing. make run-ci runs the full local pipeline.

## **THE RULES THAT APPLY TO EVERY TASK**

Everything area-specific is in [durable-rules](docs/wiki/durable-rules.md). These are the ones no
task escapes.

- **A status code is an ANSWER, a transport failure is not.** Only a 401/403 may log a user out, and `navigator.onLine` never proves reachability (a captive portal reports `true`).
- **Never branch on an error MESSAGE.** A distinction carried in prose is a distinction exactly ONE call site will make - classify at the THROW, as a type. When auditing such a seam, enumerate its consumers, never just the ones that mention it: one surface handling a case is not "the case is handled".
- **IDEMPOTENCE COMES FROM DURABLE STATE, TERMINATION FROM A PROOF - never from a clock.** Ask of every timer what it would mean if it were wrong; if the answer is "more traffic", it is load-bearing and it should not be. But durable state is idempotence only for THE QUESTION IT WAS WRITTEN TO ANSWER: "is this broken" and "have I already asked" differ only in lifetime, and using one for the other silences the trigger.
- **A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER.** A liveness clock must be written by the thing whose liveness it measures (`updatedAt` kept nine dead devices alive for ever). Same shape: an epoch verdict answering a generation question.
- **A PREDICATE THAT NAMED THE LAST INCIDENT IS NOT THE PREDICATE THAT NAMES THE NEXT ONE.** Re-measure it against the population it will actually run on - one `GROUP BY` confirms or refutes it in seconds.
- **A CORRECT MECHANISM WITH NO REPORT IS FOUND BY HAND, A DAY LATE**, and the report must carry the evidence that separates the causes it cannot itself distinguish, or it sends the reader to the wrong fix.
- **A CLAIM THAT SOMETHING IS STALE MUST NAME THE MECHANISM THAT WOULD HONOUR IT AND SHOW THAT MECHANISM GONE.** One grep refutes most of them.
- **Every swallowed branch logs** - in a best-effort path that is all a loss leaves. A batch of jobs catches and logs PER JOB; isolation is a `try` per subscriber, or it does not exist, and a comment claiming independence is not independence.
- **A DESTRUCTIVE CONTROL NEEDS AN ALLOWLIST OF WHAT IT MAY TOUCH, NOT A DENYLIST OF WHAT IT MUST AVOID** - and a destructive repair must be gated on knowing the state is really broken, or a temporary condition becomes a permanent loss.
- **WHEN SOMETHING KEEPS REFILLING, DELETING IT IS NOT THE FIX** - revoke whatever keeps naming it as a destination. And before deleting a container to reclaim what one member costs, enumerate the other members: a nightly archive holds the only copy of the databases as well as the media.
- **Default to Paraglide for ANY new user-visible string, on the first draft.** Nothing types a string as user-visible, so no compiler enforces it. Re-run `bun run paraglide:compile` before `bun run test`.
- **Never assert a wall clock in a test.** Two isolated browser contexts = two devices.
- **A green gate is not a working system.** Everything native is verified by COMPILING, which proves nothing about running; a green deploy proves the containers started, never that the site answers.

---

## **SESSION STATE (Active Memory)**

State lives HERE (canonical). **Five repos**, all on `main` except where noted:

| Repo | Where | Status |
| --- | --- | --- |
| **Canari** (this monorepo) | `emse-students/canari`, **PUBLIC** | active - see below |
| **Sky** | `../Sky` | COMPLETE, nothing open |
| **MiGallery** | `../MiGallery` | COMPLETE, nothing open |
| **Portail-etu** | `../refonte-portail-etu` | COMPLETE, nothing open. **No SSH to that box** - the self-hosted CD runner is the only way in, and `deploy.yml` has a `workflow_dispatch` (a keeper; a dispatch can 500 while STILL creating the run, so check `gh run list` before re-dispatching). Repo is PUBLIC, so every run log must redact, and `grep -a` is mandatory (the pm2 log holds binary bytes). `pm2 flush`, never `rm`. `data-export/` holds PII, never commit. |
| **Le Cercle** | `../le-cercle`, `gitlab.emse.fr:aurel.dautry/le-cercle` | Aurel owns it - **never commit to its `main`**, work on a branch and hand him a merge request. See below. |

Work is tracked as Work Packages ordered by severity: **P1** (security, or a user-facing path that is
broken), **P2** (correctness, nothing at risk), **P3** (hygiene). Delete a WP outright once it ships:
the rule it taught goes to [durable-rules](docs/wiki/durable-rules.md), the story to `CHANGELOG.md`,
the narrative to the wiki page the entry points at. **Do not reconstruct shipped work here.**
Everything wanted but NOT scheduled is [backlog](docs/wiki/backlog.md) - file it there, never here.

### CANARI - what is open

**SHIPPED, VERIFIED AND CLOSED - do not re-open, do not reconstruct any of them here.**
WP-FALSELOSS-1, the two A1 startup defects, WP-PENDING-2 (the undrained queue, measured to `0` rows
on A1 and no runaway device left on the fleet), WP-PREFIX-1 (six of seven internal cross-service
calls addressing a route that does not exist, every one of them `.catch(warn)`), WP-OUTBOX-1 and
WP-RECONNECT-2. Each one's rule is in [durable-rules](docs/wiki/durable-rules.md), its story in
`CHANGELOG.md`, its mechanism on the wiki page that entry points at.

**THE FALSE LOSS IS FIXED AT ITS CAUSE AND THE VERIFICATION IS NOW TAKEN (2026-08-14).** A state
replacement may not rewind this device's own send ratchet, and an EPOCH cannot see that it did: a
send moves a GENERATION inside one epoch. Native had only the epoch half; the outbound checkpoint sat
at 2 of the 18 call sites that reach a send. `sendMessage` is concrete in `BaseMlsService` and
carries all three outbound invariants, platforms supply only `encryptForSend`, and the `hidden`
handoff flushes BEFORE releasing the native foreground guard. **Verified: MSG x5 on `8a3edbdd` -
13 of 13 `passed` on every pass, no `SecretReuseError` and no `LOST frame` anywhere in the run.**
Mechanism on
[mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md) (section 8).

**TWO DURABILITY DEFECTS SHIPPED 2026-08-14, ONE VERIFIED AND ONE OWED.**
[mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md) section 8 is the record.

- **Durability was gating delivery** (`f391c199`, VERIFIED). `endBulkIngest` awaits every observer and
  the persister awaited the whole encrypted checkpoint, so an already-received frame waited for the
  disk before being decrypted: **8.0 s on a cold web client**, with a 50 ms API round trip inside the
  gap proving nothing else was blocked. The flush is started and not awaited. MSG-1-cold went from
  one `SLOW` at 8 045 ms to **259-297 ms, 5/5**.
- **The phone wrote `mls.bin` twice** (`6bfd805d`, VERIFIED ON HARDWARE 2026-08-15). `saveState` means
  different things per platform; the checkpoint path did `saveState` + `saveMlsStateEncrypted`, which
  on native writes the same file with the same bytes again, marshalled through IPC as a `number[]`.
  3.7 s per checkpoint, 1.7 s of real save and 2.0 s of duplicate. One seam now -
  `IMlsService.persistCheckpoint`. **Measured on A1 with the new APK: median 1 512 ms (1 454-1 597,
  n=5), web 58 ms** - the duplicate is gone and the remainder is under the 1.7 s predicted. `ckpt.mjs`
  reads it from the app's own log line; the whole difficulty was ATTRIBUTION, not timing.
- **FIX B WAS REFUTED AS SPECIFIED AND THE HOLE IS NOW CLOSED BY A BURN INSTEAD.** Awaiting a
  checkpoint on the send path costs 1.7 s per message, so `checkpointAfterSend` keeps its
  non-awaiting default on both platforms. The invariant never required durability AT SEND TIME, only
  that a state restored behind one be recognised: `sendRatchetLedger` counts emitted frames in
  `localStorage`, `persistCheckpoint` pairs the count with the write (read before, commit after -
  which over-counts on purpose), and `reconcileSendRatchets` burns the difference at load via
  `MlsManager::skip_send_generations`. **The Rust half is proven**
  (`mls-core/tests/burn_spent_generations.rs`, 4 tests: the fault, the repair, and that over-shooting
  is free). **The client half was taken on both platforms 2026-08-14** and is written up on
  [mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md) - this file said OWED after
  the fact, which was stale, not open. **Re-taken on the new bundle 2026-08-15**: W1 burnt 1, next
  frame in 447 ms; A1 burnt 1, next frame in 3 589 ms; both peers clean. **`burn.mjs` no longer
  races** - a fixed delay cannot enter a window that is now ~58 ms wide on web, so the reload is
  gated on the ledger actually showing `emitted > persisted`. iOS gets it from the same un-gated
  `generate_handler!`.

**WP-RECONNECT-1 IS FIXED, DEPLOYED AND NOW VERIFIED ON A REAL CLIENT (2026-08-14 `9fd67590`,
verified 2026-08-15).** The reconnect circuit is DELETED: only a proof ends the retry loop now
(logged out, or a 401/403 on the refresh cookie), the ladder saturates at 30 s and climbs for ever.
Two further silences fixed with it: `attemptReconnect` rescheduled from inside its own
`isReconnecting` guard, so both failure paths were no-ops that logged `Retrying in Ns...` (the 60 s
watchdog was the real retry driver), and it nulled the pending timer without clearing it, so a forced
resume left two ladders climbing. **`ladder.mjs` held a 486 s outage on W2 and read `attempt 21`,
delays `1,2,4,8,16,30`, monotonic, back in 98 ms with no synthetic event** - 21 is impossible under
the old 20-latch, so the proof needs no interpretation. **The unpredicted half: 0 watchdog lines**,
because the watchdog returns before logging when a rung is already armed - the outside view of "the
ladder climbs itself". Mechanism, both captures and the completed test fixture are on
[auth](docs/wiki/frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it);
three rules in [durable-rules](docs/wiki/durable-rules.md). **The campaign masked it structurally** -
every check reloads, which is why the proof had to be MADE rather than found.

**The avatar 404s are attributed and are a SERVER fault, not a client one.** `[AvatarService] Error
fetching avatar` in `core-service`, 17 outbound HTTPS timeouts to Cloudflare IPs over one 5-minute
run: the endpoint proxies a remote avatar, the fetch times out, it answers 404. The UI falls back to
initials. Not a WP yet - a fix needs the user's call on whether that proxy should exist.

**WP-GARAGE-1 IS SHIPPED (2026-08-14) - MinIO -> Garage, verified on prod.** Every object
(200 / 45.370 MiB) copied via `rclone sync` and confirmed identical with `rclone check` (0 diffs)
before `media-service` was repointed; the `minio` service is removed from
`docker-compose.prod.yml`. Mechanism, the credential-length crash and its fix, and the exact
MinIO/Garage differences are on [docker](docs/wiki/infrastructure/docker.md) - do not re-derive
them here. **Owed: remove the orphaned `minio_data` volume after 2026-08-28** (14-day rollback
window, see that page).

**Two things are owed and neither is a Work Package yet:**

- **The fourth reconciliation trigger** the user approved - *"sonder aussi quand la reponse recue est
  plus courte que la fenetre demandee"*. NOT implemented; the trace and the design input are in
  [history-reconciliation](docs/wiki/protocols/history-reconciliation.md). **The hard part is
  TERMINATION, not detection**: a phone (5 y) asking a browser (90 d) gets a clipped answer by
  construction every time, so a naive re-ask is an unbounded loop. Terminate on a proof - every
  current member has answered - never on a clock.
- **The device verification ladder**, below.

**THE HISTORY-RECONCILIATION REWORK IS DONE, DEPLOYED, AND VERIFIED RUNNING ON ALL THREE CLIENTS.**
[history-reconciliation](docs/wiki/protocols/history-reconciliation.md) is both the spec and the
record - **read it, do not re-derive it here, and do not re-open a decision in its Decisions table**
(its Open questions section is empty). Its four load-bearing invariants now live in
[durable-rules](docs/wiki/durable-rules.md); the fleet measurement, the audit, and the group that
could not heal are all written up on that page. Residual noise on the fleet: two failing
`/api/users/<id>/avatar` endpoints. **That page's `-> 0` measured a one-time silencing, NOT the end
of the noise** - it regenerated from live traffic, which is WP-FALSELOSS-1 above.

**A destructive cleanup for pre-existing damage was considered and REJECTED on evidence - do not
revive it.** A terminal decrypt failure persists NOTHING, so it would have had nothing to target, and
delete-and-recreate is strictly worse than a comparison. The one-shot audit is the answer.

**Release status:** v0.13.1, prod answering `{"version":"0.13.1"}`. **`minClientVersion` stays at
0.13.0 on purpose** - the store rollout has not reached devices, and raising it first locks everyone
out behind a button leading to the old version. What survives of the shipping order: publish to the
stores -> VERIFY the store serves it -> only THEN raise `minClientVersion`. The mixed-fleet reasoning
is in [legacy-compatibility](docs/wiki/legacy-compatibility.md).

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement - never assume the local `main` is the deployed truth. His commits are usually style/UI
and land in files the campaign measures, so each owes a WEB and a MOBILE pass logged next to our own
checks. The thing to verify is his change RUNNING, which no test of his can establish.

**Prod IS the test server** and commit+push are authorised so it picks changes up. `dev.canari-emse.fr`
is a proxied CNAME to the same tunnel, NOT a second environment - measured 2026-08-13, same title and
same `/api/version` as the apex. **The user will define what to do with it AFTER the campaign - do
not design a staging environment before that conversation.**

#### Known, and deliberately NOT a Work Package - do not "fix" these by reflex

- **Nothing tells the RECEIVER's user that a message was lost** (the residue of WP-LOSS-1). A deliberate gap, not a defect.
- **A device only asks for history when something TELLS it to.** The triggers are an unreadable frame, a replay that gave up, a connection whose absence outran server retention, a peer returning, and the one-shot audit. What is left of the gap: a device that never connects is never repaired, and one whose peers are never online at the same moment waits for the first that is. **Do not "fix" that with a periodic solicitation** - that is a broadcast on a timer, the exact shape this area was cleared of, and the connection edge already asks as often as it honestly can.
- **`history_request` is deliberately NOT made durable** the way `welcome_request` is (Redis + FCM): a stored request drained hours later has no probe (60 s rendezvous TTL), so it is answered with nothing at all - and the requester must reconnect to read anything anyway, which asks again by itself. The related half: a missing Welcome BLOCKS a group, missing history only degrades it.
- **One MLS client in a SharedWorker**, shared by every tab (the successor to WP-MULTITAB-1). It would remove the class outright rather than gating each write path one at a time. Cost is why it is not the fix: the worker transport, startup, the PIN unlock and the Safari/mobile fallback where `SharedWorker` is absent all have to be redone. Evaluate relevance and cost before starting.
- **The `mongo` service in `docker-compose.prod.yml` is dead** - production holds no application database there (only `admin`, `config`, `local`) and nothing in the codebase carries a MongoDB connection string. A candidate for removal, not a fault; removing it is a prod service change and needs the user.
- **A new device or a reinstall still sees no media older than 30 days.** That is what makes the storage forecast survivable, and it may not be what the user intends - a POLICY question, not a rendering one ([storage-forecast](docs/wiki/infrastructure/storage-forecast.md), section 6). The clock is now honest: it is refreshed on a client cache HIT, not only on a server download.

**MSG AND TYPE ARE BOTH RUN FIVE TIMES ON `8a3edbdd` AND BOTH ARE CLEAN 5/5** - MSG 13 of 13 on
every pass (2026-08-14 20:03-20:21Z), TYPE 5 of 5 on every pass (21:33-21:40Z), every server window
clean in both. Durations and per-pass detail are on the dashboard; **do not copy the tables here.**
The instrument faults behind them are rules 15 and 16 of
[testing-methodology](docs/wiki/testing-methodology.md) and must not be re-derived: a check that
never established its precondition (TYPE-4 cut the peer with a setting already measured inert), a
phase file that computed five verdicts while reading no console, and a click that could not say what
had RECEIVED it. `srvlog.mjs` now partitions its window by SUBJECT - prod is shared, and 27
"unexplained" lines were one real third-party user's phone climbing its recovery ladder.

**WP-BANNER-1 IS SHIPPED AND VERIFIED RUNNING (`e62c21f1`, 2026-08-15).** Six banners agreed on
nothing; the whole contract is on
[frontend/architecture](docs/wiki/frontend/architecture.md#status-banners) - read it, do not
reconstruct it here. It changed `MainChatPage`, `Sidebar`, `ChatArea` and `+layout`, **the exact
surface MSG and TYPE measure**, so both were re-run on the new bundle: **MSG 13/13, TYPE 5/5, server
clean on both.** The positive check is taken in all three windows - `synboot.mjs` at STARTUP (W1 and
W2), `synopen.mjs` during a channel open, `synwatch.mjs` at idle: **zero appearances, `mainTop`
constant at 57 px**, against ON at 480 ms / OFF at 2 286 ms and 29 px of shift before the fix, which
is what delivered a click aimed at a channel row to the button below it.

**A1 IS NOT ON THIS FIX AND CANNOT BE WITHOUT A REBUILD** - `frontendDist` is `../build`, so the
phone serves the bundle inside its APK and a deploy never reaches it. Its APK (built 21:20, installed
21:30 on 2026-08-14) carries `6bfd805d` and `8a3edbdd` but predates `e62c21f1`. MSG's A1 half above
therefore ran on the older UI; that is a real mixed-fleet state, not an oversight, and the banner
change cannot regress delivery. **That staleness then paid for itself: A1 is the POSITIVE CONTROL
for `synboot.mjs`** - the same probe caught the banner there (4 601 ms, 26 px, held 4 s), so the
zeros on web are a real absence rather than a rotted selector. It also showed `mainTop` unmoved at
107 px on mobile, which places the 29 px displacement in the DESKTOP layout only. **Owed only if the
UI surface is to be verified on the phone: one APK build, then the A1-touching MSG checks again -
and doing so SPENDS the control.**

**The server observer meets the same bar as the two clients and is tested like them.** Its whole
window is classified: `srvlog.mjs --shapes` collapses `unexplained` and `notable` to distinct
sentences, `srvclassify-selftest.mjs` pins every rule against a line whose bucket is known, and
`expectedErrors` names errors that are real and not defects. **A rule that named the last incident
does not name the next one**: three of the last four additions were near-misses on an existing rule,
not new categories. Every instrument fault behind the current design is written up in
[testing-methodology](docs/wiki/testing-methodology.md) - do not re-derive them here.

Two things the classified window raised, both filed and neither a defect on this evidence:
`FALLBACK_MEMBERS_CACHE` on **every send observed** ([backlog](docs/wiki/backlog.md), P2) and
`call-service` writing **0 lines in 24 h**, so the CALL phase will have no server observer at all.

### CANARI - the test campaign

The campaign's state - every check, its category and its state - is the dashboard at
**[cross-client-testing](docs/wiki/cross-client-testing.md)**. **Read it rather than re-deriving the
state here, and do not maintain a second copy.** The rig is
[`tools/cross-client-harness/README.md`](tools/cross-client-harness/README.md) (ports, launch flags,
adb, the build traps, the file inventory).

**THE WORKING RIG LIVES AT `../canari-harness` (`C:\Users\jolan\Documents\Programmation\canari-harness`)**,
moved there 2026-08-11 and NOT in a scratchpad: a scratchpad is scoped to one session, so the next
session gets an empty one and the instrument would be unreachable. It holds 251 `.mjs` (the library,
the checks, ~150 one-shot probes), `test-accounts.json`, the debug APK, A1's baseline, and
**`chrome-w1` / `chrome-w2` - the two logged-in Chrome profiles, which ARE the W1 and W2 devices**:
losing them costs a re-enrolment and SETUP-4's 2FA, the one step no tool here can answer. Reuse it,
do not rebuild it. How a result earns belief is
[testing-methodology](docs/wiki/testing-methodology.md), which carries thirty-one harness faults
distilled into ten rules plus the environment traps that read as application bugs. **Read it before
writing a check or believing one.**

Standing constraints, which are not findings and must survive any compaction:

- Runs against **PRODUCTION**, two real accounts, credentials in `../canari-harness/test-accounts.json`, **never in the repo - which is PUBLIC**. No PIN, login, display name, device id, group id or device serial goes in a committed file; the harness copy is anonymised to `owner` / `peer` and the docs must stay that way. **No password is ever a tool-call argument.**
- **EVERY test message goes in the two-test-account DM, and NOWHERE else.** For anything needing a CHANNEL, the venue is the `Campagne de test` community, never MiTV - a private channel is readable by every association admin.
- **OBSERVATION IS PART OF EVERY CHECK, not a debugging step.** A verdict is `PASS` only if the assertions hold AND the run is clean. Several shipped bugs came out of a green check's noise.
- **RECONCILIATION is the only way this campaign's loss class can be SEEN** (`recon.mjs`). No per-check verdict substitutes for it. **It now covers the PHONE too** (2026-08-15): the native store is read in place over `plugin:sql|select` from CDP, because `adb pull` would put a real account's conversations on this machine and there is no on-device `sqlite3`. Last run: **RECONCILED, W1/W2 and W1/A1, id by id, 0 divergence on all nine shared conversations** including the 4 282-message DM.
- A check that FAILS earns a WP with its captured log; a check that passes earns a row on the dashboard and nothing else.
- **Clean up after the campaign.** It creates groups, devices and backlogs on the production database that later runs then measure and cannot tell from real traffic - see the cleanup section of the dashboard.
- On THIS machine: `pin.mjs --account` takes the KEY AS SPELT IN `test-accounts.json`, which is a first name, not the `owner`/`peer` alias the docs use - so the alias cannot be written here and the key cannot either. Read the keys with `node -e` over the file; never pass a PIN or password as an argument. **Never run an Android/iOS build next to anything else that builds the frontend** - `beforeBuildCommand` IS `bun run build`, and two builds writing `build/` ship an app that cannot boot (`scripts/check-bundle-consistency.mjs` now fails the build instead). Every Android build leaves a Gradle daemon (idle timeout 10 min).
- **A Kotlin-only change does NOT need the Tauri build**: `gradlew :app:assembleUniversalDebug` in `gen/android` packages the assets already on disk, which skips `bun run build` and the trap above entirely. `:app:testDebugUnitTest` is ambiguous - the variants are `testUniversalDebugUnitTest` / `testArmDebugUnitTest`, and stale reports from the OTHER variant will happily answer a question about this one.
- **A1's devtools socket is `webview_devtools_remote_<pid>`, so it CHANGES on every restart.** A forward left over from an earlier session stays listed and points at nothing, or at another app's `chrome_devtools_remote` - the phone then reads as "not debuggable" while it is in the foreground. `a1forward.mjs` derives it from the running pid and fails loudly when the target list is empty.

**[device] The verification pass is NOT a Work Package.** Everything native is verified by COMPILING,
which proves nothing about running; the owed list is
[device-verification](docs/wiki/device-verification.md) - checks B-P with the verdict line of each.
Android passed the ladder on v0.11.7; **iOS has never run one check on hardware**. Owed on both: H
(deep link into the conversation), K (quick reply), L (revoked device re-enrolling), N (offline
unlock + promotion), O (the store/update destination), P (the iOS cookie jar). **Open a WP only when
a check FAILS**, and only with its captured log. Capture tool: `test_adb.py` at the repo root. The
four human checks left from the SEO work are the same shape -
[seo](docs/wiki/frontend/seo.md#what-no-test-here-can-prove).

### LE CERCLE - MR !4 PUSHED, AWAITING AUREL

**MR !4** - `chore/project-conventions`, 13 commits, rebased onto `main` and pushed 2026-08-05 -
https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/4
**Description still to PASTE by hand: `../MR-CERCLE-2.md`** - which also carries what !4 contains and
every decision behind it, so do not re-litigate any of them from here. Git refuses a push option
containing newlines, so `merge_request.description` is unusable, while `merge_request.create` +
`.target_branch` + `.title` over SSH DO work (that is how !4 was opened, no `glab`, no token).

**VEILLE - on demand, never scheduled.** He keeps working on `main`; run this loop when asked:
`git fetch`, `git log --oneline origin/main --not chore/project-conventions`, then
`git rebase --onto origin/main <merge-base>` (never a commit on `main`). Two files conflict every
time: `.env.example` (HIS placeholder convention wins) and `.prettierignore` (keep his
`/db/sql/seed.sql` line, or prettier reformats the fixture dump). Re-apply our conventions to HIS new
code per `../le-cercle/AGENTS.md` - the canonical checklist, do not duplicate it here - expecting
`prettier --check` failures on what he merged, with formatting-only fixes in their own commit. Resync
the wiki (`authentication.md`, `ledger.md`, `data-model.md`, `deployment.md`, `frontend.md` rot
fastest: the rebase is mechanical, what the wiki asserts about his code is not). Gates,
`push --force-with-lease`, then paste the MR description by hand.

**No Work Package is open on the Cercle.** What is left is his to decide (the ledger's unwritable
`undo`/`cashout`, `JWT_OLD_SECRET`, the placeholder `AUTH_SECRET`) and it is written up, with the
fingerprints that establish it, in [PROD-TEST-CERCLE](docs/PROD-TEST-CERCLE.md) - to RAISE, never to
patch. Three prod tests there need a human and are not WPs: V1 (a real MiConnect round trip), V2 (the
access gate), V4 (the alcohol gate at a till). The link itself is LIVE and proven both directions;
every probe and its answer is in that file, do not re-derive it.

**Architecture decisions taken 2026-07-28 (do not re-litigate):** ledger + cached column; the Cercle
keeps `memberships` as a display-only mirror while Canari owns tier assignment; cercleux get site
access without a cotisation but may NOT consume; cash top-ups allowed with an audit trail; Canari
credits but never displays the balance. **His membership model, overriding any older note:** no
cotisant snapshot, no TTL - `syncCanaryMembership` writes `users.id_membership` at login and on the
5-minute session-JWT refresh.

**Ours, not the repo's** (its own traps are in `../le-cercle/AGENTS.md`, the prod facts and every
probe already run in [PROD-TEST-CERCLE](docs/PROD-TEST-CERCLE.md) **here**):
`CANARI_INTEGRATION_ENABLED` sits in the deployed `.env` and is referenced NOWHERE since the rewrite
- dead, not a switch. Never test the Canari link against the DEV server: `$env/dynamic/private` there
came from a stale process and read the OLD `.env`, silently disabling it - build, then
`bun ./build/index.js` with the env explicit on the command line. `TaskStop` does NOT free the port;
kill by port with `Get-NetTCPConnection ... | Stop-Process`. Prod is `ssh cercle` (10.0.0.6,
ProxyJump canari); our audit branch is archived
(`archive/audit/security-and-canari-integration`) and must never be redeployed.
