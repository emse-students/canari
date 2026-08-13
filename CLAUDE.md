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

**NO WORK PACKAGE IS OPEN.** WP-PUSHHERD-1 closed 2026-08-11, the last of them - fixed AND verified
running on the device (0 lock timeouts, 1 MLS thread, 0 kills, against 97/20+/1 before). **The iOS
half of it is compile-verified only** and joins the owed device list below.

**THE HISTORY-RECONCILIATION REWORK IS CODE-COMPLETE**, all of it, and
**[history-reconciliation](docs/wiki/protocols/history-reconciliation.md)** is both the spec and the
record: read it, do not re-derive the design here, do NOT re-open a decision in its Decisions table.
Its Open questions section is empty.

**IT IS DEPLOYED TO PROD AND PHASE MSG HAS NOW RUN ON IT** - 10 passed, 2 failed, 1 inconclusive.
Four of the first run's five "failures" were HARNESS faults, not app faults, and both fixes are in
`../canari-harness`: the preflight sent A1 off its `tauri.localhost` origin (breaking the Tauri
allowlist), and five checks inferred which conversation was open from a composer's mere presence
(`ensureConversation` now asserts the header). **The state of every check is
[cross-client-testing](docs/wiki/cross-client-testing.md) - read it, do not re-derive it here.**

**THE SERVER SHIPPED BEFORE THE STORES, against the stated order** - forced by Leon's `6f87a3e7`
having prod down. **Checked rather than assumed, and harmless:** no endpoint, DTO, proto field or
retention constant changed, so a 0.13.0 client still talks to this server; the one removed wire field
(`withDigest`) only makes an old responder send its whole store instead of a diff. **The real
mixed-fleet hazard is client↔client, which the deploy order never governed** - a 0.14 responder that
gets no probe answers NOTHING and a 0.13.0 requester sends no probe, so old requesters get silence
from updated peers. That is the clean break working as decided; both halves are written up in
[legacy-compatibility](docs/wiki/legacy-compatibility.md). What survives of the order: publish to the
stores → VERIFY the store serves it → only THEN raise `minClientVersion` past 0.14. Raising it first
traps users on an update screen whose button leads to the old version.

**The three P2s measured in the shipped exchange are FIXED and in prod** - `6387ad57`, which precedes
the deploy already verified on `23e23b08`. The probe no longer queues or pushes to offline members
(the server filters recipients on `body.durable`), `historyRangeStartFor` reads ONE row by key in
both backends, and `awaitProbe` prefers a probe that postdates the election. Their backlog entries
were deleted on 2026-08-13 after the fix was re-verified in the code; **do not reinstate them from an
older note.**

**Two defects were found and FIXED on 2026-08-13 by measuring the "Synchronisation des messages…"
banner the user reported twice** - shipped as `23e23b08`, and **the deploy is verified rather than
merely green**: CD `success` on that sha, apex 200, and the served chunk carries both new markers.
Both are written up in [history-reconciliation](protocols/history-reconciliation.md) ("What a
connection pass costs, measured" + three new rows in Decisions), so do not re-derive them: (1) the
connection pass awaited its groups one at a time - **9 groups, ~480 ms each, 4.35 s**, and the cost
is the HTTP election, which takes no MLS lock; elections now run 6-at-a-time and the sends still
serialise. (2) The banner was raised from `pendingCount`, a count of CIPHERTEXTS, so it announced
nine probes as a message sync; it is now raised from the decrypted buffer at 5 real messages, via a
new `isCatchupOverlayVisible` - **`isMessageCatchupActive` keeps its old meaning and its three
concurrency guards, deliberately.** A third option, holding the socket through a short background,
was **REJECTED and must not be revived without device evidence**: the app would ACK over the
WebSocket while backgrounded, cancelling the 10 s deferred FCM fallback, and nothing establishes the
web `Notification` is delivered from a backgrounded Android WebView. **The 4.35 s figure is the first
thing to re-measure on A1** - it should now be one round trip.

Four things a future session must not undo, because the wiki explains them but the temptation is to
"simplify" them back:

- **`historyWindow.ts` is the only place either boundary is decided.** The floor is SHARED, monotone,
  merged as `max`, and **ships worth zero on purpose**. The window is LOCAL and fixed by platform
  (`isTauriRuntime()` alone: web 90 d, mobile and desktop 5 y), and `deviceWindowStart` rounds DOWN
  to the day - unrounded, two devices a second apart compare different ranges and the fast path can
  never fire.
- **`since` is STATED by the asker, never recomputed by the answerer; the digest is NOT clipped; the
  clip is on the ANSWER, never the COMPARISON; each leg states its OWN window.** All four, or a
  boundary message goes permanently missing on one side, or every device is capped at the shortest
  window in the conversation.
- **`toConversationMeta` and the in-memory seed in `loadExistingConversations` are MIRRORS and must
  be edited together.** The D2 fix was silently defeated by exactly this: `readWatermarks` was
  written and never read back, so read state was correct until the first restart. A field persisted
  but never read back is worse than one never stored - the write succeeds and nothing reports it.
- **`DELIVERY` in `frameDelivery.ts` is the ONLY classification** (`visible` / `mutation` /
  `transport`) and every send site names one; the server gate reads `body.durable`, not `!silent`.
  Each stream entry records its own `silent`, and `redeliverMissedDuringActivationWindow` filters on
  it or it rings the user for every reaction.

**A1 IS BACK on USB** (`adb devices` lists it, 2026-08-13). Two things are owed before it measures
anything: the **PIN unlock** (a reinstall restarts the process and "Rester connecte" was off, so the
app sits on the PIN screen with an EMPTY local store - which reads as a stuck sync and is not one),
and the **A1-vs-W1 reconciliation**, the one MULTI measurement the browsers cannot make.

**MSG-4's defect is ROOT-CAUSED AND FIXED, and has not been seen running** (`233c2e0b`, gates green:
svelte-check 0, 1368/1368). A group that could never heal, because `reconcileGroup` DROPPED the
repair whenever no probe sender was installed yet - while the frame that raised it was acked in the
same breath, deleting the only thing that could raise it again. **It was masked by the unconditional
sweep, so `23e23b08` is what turned it from hidden to permanent.** The whole failure and the rule it
teaches are in
[history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-group-that-could-not-heal) -
do not re-derive it.

**MEASURED ON THE DEVICE 2026-08-13, on the fixed build: `642f389a` DOES NOT heal by itself, and
that is NOT a second fault - it is the boundary of the fix.** A clean boot (force-stop, relaunch,
PIN, three devices online) raised exactly ONE reconcile line, `no sweep - away 0 d, inside what the
server keeps`, and no unreadable frame arrived. The fix HOLDS a repair that is raised; it cannot
manufacture a trigger for damage whose evidence was consumed before the fix existed - the frames
that would have raised this one were acked and deleted at the time.

**THE AUDIT IS VERIFIED RUNNING ON ALL THREE CLIENTS (2026-08-13) AND THE FLEET IS CLEAN.** Boot 1
audits, boot 2 reports `every group already audited`, and `SecretReuseError` went 18→0 on W1, 20→0 on
W2, 2→0 on A1 - the noise that polluted MSG-4 and MSG-9 is gone. A1 asked **8/9** on its first pass
and the ninth alone on the second: the deferral fix had already asked it 12 s earlier, so coalescing
skipped it and it was correctly NOT recorded as audited. The table is in
[history-reconciliation](docs/wiki/protocols/history-reconciliation.md#measured-on-the-fleet-2026-08-13);
**`233c2e0b` is also proven on hardware there** (`no probe sender yet … deferred`, then `asked` one
second later). Residual noise is two failing avatar endpoints, nothing else.

**THAT GAP IS NOW CLOSED BY THE ONE-SHOT AUDIT** - `groupsOwingAudit` / `noteGroupsAudited` in
`historyReconcile.ts`, wired at the connection edge in `initializeConnection.ts`, written up in
[history-reconciliation](docs/wiki/protocols/history-reconciliation.md#and-the-fix-does-not-reach-backwards---hence-the-audit).
Every device compares each group ONCE against a peer, because pre-fix damage has no live witness of
its own. **Do not "simplify" its two properties, both of which are the previous failure wearing a
different hat:** it is discharged PER GROUP and only for groups an ask actually LEFT for
(`reconcileAllGroups` returns the asked ids, not a count - recording the pass's INPUT would discharge
groups that were merely deferred and lose them for good), and `HISTORY_AUDIT_GENERATION` is the only
way to re-run it, deliberately and fleet-wide. It is not a guarantee: a group whose peers are always
offline stays owed and is asked once per connection, alone.

**A cleanup was considered and REJECTED on evidence - do not revive it.** The trace established the
durable footprint of a terminal decrypt failure is ZERO (no tombstone, no placeholder, no field in
`StoredMessage`/`ConversationMeta` able to hold a gap, nothing rendered), so a destructive control
would have nothing to target. Delete-and-recreate is strictly worse than a comparison: it destroys
the messages still held and ends where the comparison would have ended anyway. The one thing still
owed: confirm `642f389a` was really short of messages, via `recon.mjs` against the NATIVE store (see
the harness trap below), not a hand probe.

**The fourth reconciliation trigger the user approved is NOT implemented yet** - *"sonder aussi
quand la reponse recue est plus courte que la fenetre demandee"*. The trace is done and is the whole
design input: a `history_bundle` carries `to`, `messages`, `readWatermarks` and `floor` and **states
nothing about the RESPONDER's own window**, so the asker cannot tell a complete answer from a
clipped one - `actions.ts` even logs `(identical stores)` in that case. Attachment point is
`bundleFrame` (`groupActions.ts:488`), which all three bundle senders funnel through and which
already restates a per-conversation state bag on every chunk; the asker's side is the
`history_bundle` branch of `systemMessageHandler.ts:697` (step 0, the only step that runs for an
empty bundle) plus the replay twin in `historySystemEvents.ts:302`. **The hard part is termination,
not detection:** a phone (5 y) asking a browser (90 d) gets a clipped answer BY CONSTRUCTION, every
time, so a naive re-ask is an unbounded loop and restores exactly the noise just removed. Any design
must terminate on a proof - every current member has answered - never on a clock.

**The order the user set governs what comes next:** re-run the cross-client campaign from the START
(post-setup) - the scripts exist, and it exercises everything. **Commit AND push are authorised so
prod picks changes up: prod IS the test server.** `dev.canari-emse.fr` EXISTS as a hostname - a
proxied CNAME to the same tunnel - but it is NOT a second environment: measured 2026-08-13 it serves
the same title and the same `/api/version` payload as the apex, so pointing the campaign at it would
measure production under another name. **The user will define what to do with it AFTER the campaign
("on y revient après avoir fini la campagne de test, je vais t'expliquer ce qu'on va faire") - do not
design a staging environment before that conversation.**

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement - never assume the local `main` is the deployed truth. His commits are usually style/UI
and land in files the campaign measures, so what is owed for each is a WEB and a MOBILE pass logged
next to our own checks. He follows the conventions, so a rebase is normally clean; the thing to
verify is his change RUNNING, which no test of his can establish.

**Release status:** v0.13.1, prod answering `{"version":"0.13.1"}`. **`minClientVersion` stays at
0.13.0 on purpose**: the store rollout has not reached devices, and raising it first locks everyone
out behind a button leading to the old version.

#### Known, and deliberately NOT a Work Package - do not "fix" these by reflex

- **Nothing tells the RECEIVER's user that a message was lost** (the residue of WP-LOSS-1). A deliberate gap, not a defect.
- **A device only asks for history when something TELLS it to** - but since the rework the commonest trigger is EVERY connection, unconditionally, over every local group. What is left of the gap: a device that never connects is never repaired, and one whose peers are never online at the same moment waits for the first that is. **Do not "fix" that with a periodic solicitation**: that is a broadcast on a timer, the exact shape this area was just cleared of, and the connection edge already asks as often as it honestly can.
- **`history_request` is deliberately NOT made durable** the way `welcome_request` is (Redis + FCM): a stored request drained hours later has no probe (60 s rendezvous TTL), so it is answered with nothing at all - and the requester must reconnect to read anything anyway, which asks again by itself. The related half: a missing Welcome BLOCKS a group, missing history only degrades it.
- **One MLS client in a SharedWorker**, shared by every tab (the successor to WP-MULTITAB-1). It would remove the class outright rather than gating each write path one at a time. Cost is why it is not the fix: the worker transport, startup, the PIN unlock and the Safari/mobile fallback where `SharedWorker` is absent all have to be redone. Evaluate relevance and cost before starting.
- **The `mongo` service in `docker-compose.prod.yml` is dead** - production holds no application database there (only `admin`, `config`, `local`) and nothing in the codebase carries a MongoDB connection string. A candidate for removal, not a fault; removing it is a prod service change and needs the user.
- **A new device or a reinstall still sees no media older than 30 days.** That is what makes the storage forecast survivable, and it may not be what the user intends - a POLICY question, not a rendering one ([storage-forecast](docs/wiki/infrastructure/storage-forecast.md), section 6). The clock is now honest: it is refreshed on a client cache HIT, not only on a server download.

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
