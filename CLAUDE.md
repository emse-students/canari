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

**SHIPPED AND CLOSED - do not re-open, do not reconstruct here.** WP-FALSELOSS-1 (a live frame
consumed its generation without moving the archive cursor;
[history-reconciliation](docs/wiki/protocols/history-reconciliation.md)) and the two A1 startup
defects (our routing rule hijacking Tauri's IPC bridge; a `vibrate(0)` cancelling nothing;
[mobile](docs/wiki/frontend/mobile.md)). Both verified by measurement, both written up.

**WP-PENDING-2 (the undrained queue) IS SHIPPED; ONE MEASUREMENT IS OWED.** A page bounded in ROWS is
the wrong unit for a transfer - 500 rows of media was 12 MB, the client aborted on its 10 s deadline,
ACKed nothing, and met the same 12 MB for weeks (976 rows / 36 MB on A1, rising hourly, never once
falling). Byte-bounded pages + client halving + a byte WARN, `8ad1cdb5`/`b82b241e`/`58a55ff8`,
verified firing on prod with A1 falling **976 -> 923 -> 884 -> 864**. It drained one page per
reconnection only because A1 ran the OLD bundle. **The APK carrying the halving client was installed
2026-08-14 - so the owed check is A1's queue depth now: it should fall to zero rather than by one
page.** Mechanism, follow-on faults and residual on
[chat-delivery](docs/wiki/services/chat-delivery.md) and [backlog](docs/wiki/backlog.md).

**WP-FALSELOSS-2 IS OPEN (2026-08-13) - the false loss is not gone, it moved to the HEAD of the
stream.** WP-FALSELOSS-1 above stays fixed and verified; its `0` was measured over the path it was
written for and says nothing about this one. A receiver refuses a RECENT frame on the test DM
(`642f389a`, epoch 6) with `SecretReuseError` -> `[MLS] LOST frame` -> a reconciliation, which then
answers `same state as <peer> - nothing to do`: **nothing was actually lost, the app proves that
itself.** The generations complained about TRACK THE HEAD (296, 340, 379, 438, 439 across successive
runs, climbing with traffic), so it is not a pre-fix relic behind the cursor. Both directions are hit
(W1 and W2 refused generation 183 in the same second, for a frame from A1), and multi-tab is REFUTED
by measurement - one app target per profile. Cost: a wasted round trip, and **one run in four lost
the MSG-6 message outright** (`arrived: false`). **Do not fix it by suppressing the trigger** - firing
on an unreadable frame is correct. Full evidence in
[cross-client-testing](docs/wiki/cross-client-testing.md#wp-falseloss-2---the-false-loss-is-not-gone-it-moved-to-the-head-of-the-stream).

**Found only because the observation gate was closed.** `SecretReuseError` and `LOST frame` were
`notable`, and `notable` did not break `clean`, so MSG-6 recorded `PASS` with `receiverClean: true`
TWICE with those lines inside its own record. `watch.mjs` now has a `severe` bucket that breaks
`clean` (excluding `CannotDecryptOwnMessage`, which is RFC 9420 working).

**WP-PREFIX-1 IS SHIPPED AND VERIFIED ON PROD (2026-08-14, `fed86037`) - do not re-open it.** Every
Nest service mounts `setGlobalPrefix('api')` and the internal base URLs are configured without it, so
**six of seven internal cross-service calls addressed a route that does not exist**: channel push
never delivered on any device ever, `userHasMlsDevices` reduced to a constant `true` (a guard, not a
degraded one - none at all), and account deletion leaving MLS keys, devices, messages, posts, follows
and memberships in place. All six are `.catch(warn)`, which is why it survived: a failure mode
designed for a transient fault met a permanent one. Fixed at the seam (`internal/service-urls.ts` per
service), not at the call sites. **Found by `srvlog.mjs`, invisible to every client**, and verified
the same way - `[CHANNEL_PUSH] … recipients=1` with zero 404, plus the positive proof the path ran.
Full enumeration on
[cross-client-testing](docs/wiki/cross-client-testing.md#wp-prefix-1---six-of-seven-internal-calls-addressed-a-route-that-does-not-exist-fixed-fed86037);
three rules in [durable-rules](docs/wiki/durable-rules.md).

**WP-RECONNECT-2 IS OPEN AND DELIBERATELY UNDIAGNOSED.** A 98 s hole between a socket close and the
first retry, from MSG-10's capture. **The first write-up claimed the close arrived late; that claim
was withdrawn** - it rested on the ORDER of lines in a classifier bucket, because `[WS] Disconnected`
is a `console.warn` and carries no clock while everything around it does, and the same record
supports the opposite diagnosis depending on where that line is placed. Three mechanisms can own the
interval (late close / a rung already armed / an attempt already running, the last spanning
`fetchPendingMessages` and its ~90 s halving ladder); a fourth, the 8 s heartbeat, is refuted from
the code. **Nothing was reconciled or guarded** - what was fixed is why it could not be read: the two
silent branches now name the owner, the resume logs BOTH `isWsConnected` and `isWsOpen()` when it
declines, and `watch.mjs` dates every line and every socket event from CDP's own clocks (the
`Network.webSocketClosed` that `ignoringOfflineCut` used to DELETE as "the cut" is the one event that
dates the close independently of the app). `recon2.mjs` is the capture, soft cut on purpose -
`cutHard` supplies the very close whose timing is the question. **Do not fix by shortening a timer.**

**WP-RECONNECT-1 IS FIXED AND DEPLOYED (2026-08-14, `9fd67590`); ITS VERIFICATION IS STILL OWED.** The
reconnect circuit is DELETED: only a proof ends the retry loop now (logged out, or a 401/403 on the
refresh cookie), the ladder saturates at 30 s and climbs for ever. Two further silences fixed with
it: `attemptReconnect` rescheduled from inside its own `isReconnecting` guard, so both failure paths
were no-ops that logged `Retrying in Ns...` (the 60 s watchdog was the real retry driver), and it
nulled the pending timer without clearing it, so a forced resume left two ladders climbing. Captured
before the fix with `circuit.mjs` (kept in the harness): two prod tabs, 7 h old, `online:true`,
`visibility:visible`, watchdog ticking every 60 s, **0 retries / 0 sockets in 135 s** - then a
synthetic `visibilitychange` on the ALREADY-VISIBLE W1 reconnected it in <20 s while W2 stayed dead
as a control. Gates green (`check` 0/0, 5/5 unit). Mechanism, evidence and the completed test fixture
are on [auth](docs/wiki/frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it);
three rules in [durable-rules](docs/wiki/durable-rules.md). **The campaign masked it structurally** -
every check reloads. **Still owed: `circuit.mjs` on a tab that lived through an outage ON THE NEW
BUNDLE.** The fix is PROSPECTIVE, so a tab running the old one proves nothing - and a tab that was
reloaded to GET the new one has not lived through an outage, which is why this cannot be a standalone
run and is folded into MSG-9/10's cut instead.

**The avatar 404s are attributed and are a SERVER fault, not a client one.** `[AvatarService] Error
fetching avatar` in `core-service`, 17 outbound HTTPS timeouts to Cloudflare IPs over one 5-minute
run: the endpoint proxies a remote avatar, the fetch times out, it answers 404. The UI falls back to
initials. Not a WP yet - a fix needs the user's call on whether that proxy should exist.

**WP-GARAGE-1 IS HALF SHIPPED (2026-08-14) - MinIO -> Garage, dev cut over, prod is additive-only
so far.** MinIO is unmaintained upstream. `storage.service.ts` is UNCHANGED - Garage implements
every S3 op the `minio` npm client calls, so this is entirely an infra swap, every `MINIO_*` env
var kept its name on purpose. Dev/local/CI compose files are fully cut over (MinIO service
removed); `docker-compose.prod.yml` only ADDS a `garage` service alongside the still-untouched
`minio`/`media-service` - prod media-service still reads from MinIO. **Owed, and it is the user's
own action, not mine:** run the bootstrap + `rclone sync` commands (bucket/key self-provision via
`--single-node --default-bucket`, same `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` values - no credential
rotation needed) against prod, confirm object counts/bytes match, THEN the cutover commit (repoint
`MINIO_ENDPOINT`/`MINIO_PORT` at `garage`) ships. `minio_data` stays stopped-not-deleted for 14
days after that as a rollback net. Two new GitHub secrets already created: `GARAGE_RPC_SECRET`,
`GARAGE_ADMIN_TOKEN`. Verified locally: idempotent restart (no duplicate-key error), full
put/get/list/delete round trip against Garage via the real `minio` client. Mechanism and the exact
MinIO/Garage differences (health check has no HTTP equivalent - the image ships no shell/curl, so
it's `/garage status` over RPC instead; two volumes not one; no root user) are on
[docker](docs/wiki/infrastructure/docker.md).

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

**THE MSG PHASE IS RUN AND EVERY DELIVERY ASSERTION HOLDS (2026-08-13 21:07Z, `58a55ff8` + the 21:33
APK): 10 PASS, 2 dirty, 1 with noise, no failure, no inconclusive.** One copy everywhere, nothing
lost, duplicated or out of order. The three unclean rows carry WP-FALSELOSS-2 between them and
nothing else. Three of the run's answers had been the INSTRUMENT reporting about itself, and all
three fixes are shared primitives:

- **A browser CAN be offline at the gateway, and MSG-9 had never once managed it.** Measured: W2 cut,
  `fetch` severed in 13 ms, presence key refreshed WITHOUT A GAP FOR 60 s. CDP offline emulation
  leaves an established WebSocket alone, so `cut()` cannot ever produce a receiver-side
  disconnection. `net.mjs` now has `armCut` + `cutHard` (capture the socket at construction, offline
  FIRST so the reconnect fails, then close it).
- **MSG-1b's window is now a FACT** - fire on the observed in-flight `GET /api/mls/history/<group>`,
  assert it had not settled - and deterministic, because the primer waits for the history route to go
  QUIET (the list bootstrap was swallowing it). 3/3 identical runs.
- **`ssh` resolved to Git's binary under Bash**, which mangles the cloudflared `ProxyCommand`, so the
  gateway probe answered differently depending on which shell launched the run. All prod access now
  goes through `ssh.mjs`, which picks Windows OpenSSH explicitly.

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
- **RECONCILIATION is the only way this campaign's loss class can be SEEN** (`recon.mjs`). No per-check verdict substitutes for it.
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
