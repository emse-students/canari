# **Canari - Rules & Session State**

> **The hard-won rules are in [docs/wiki/durable-rules.md](docs/wiki/durable-rules.md)** - constraints
> each written after something broke, indexed by area and linked to the page carrying the reasoning.
> **Open the section matching what you are about to touch, before you write anything.** This file
> keeps only what applies to EVERY task, plus the live session state.
>
> **THIS REPOSITORY IS THE ONLY REFERENCE, AND THIS FILE IS ITS INDEX.** Anyone holding the repo and
> the secrets must be able to pick the work up with nothing else.
>
> **An agent's local memory is SECONDARY AND DELETABLE.** It may hold machine-local wiring (an MCP
> server's absolute path, a shell shim) and secrets that must never enter a public repo - nothing
> else. If it ever holds a project fact, that is a bug in this file: move the fact here and delete
> the memory. Never let a decision, a measurement or an open item exist only in a chat history, a
> scratch directory or a memory file.

## **WHERE THINGS LIVE**

| Question | File |
| --- | --- |
| What is open, and what rule holds everywhere | this file |
| The constraint for the area I am about to touch | [docs/wiki/durable-rules.md](docs/wiki/durable-rules.md) |
| How something works, in depth | `docs/wiki/` - **search it before reading source** ([index](docs/wiki/index.md)) |
| The substance behind a queue item | [docs/wiki/backlog.md](docs/wiki/backlog.md) |
| A question the code cannot answer, parked deliberately | [docs/wiki/open-questions.md](docs/wiki/open-questions.md) |
| The story of a defect that shipped | `CHANGELOG.md` |
| Campaign board: every check, its verdict, its build | [docs/wiki/cross-client-testing.md](docs/wiki/cross-client-testing.md) |
| Campaign design: the ladder, the scope, the preflight | [docs/wiki/cross-client-campaign.md](docs/wiki/cross-client-campaign.md) |
| Why a result may be believed | [docs/wiki/testing-methodology.md](docs/wiki/testing-methodology.md) |
| What the app has that NOTHING watches | [docs/wiki/mechanism-audit.md](docs/wiki/mechanism-audit.md) |
| How to operate the test rig | [tools/cross-client-harness/README.md](tools/cross-client-harness/README.md) |
| What is owed on real hardware | [docs/wiki/device-verification.md](docs/wiki/device-verification.md) |
| Secrets, services, bootstrap steps | `infrastructure/MIGRATION.md` |
| A shim kept alive for old clients, and its removal date | [docs/wiki/legacy-compatibility.md](docs/wiki/legacy-compatibility.md) |
| What a report is, and what a block does and does not close | [docs/wiki/moderation-and-blocking.md](docs/wiki/moderation-and-blocking.md) |
| The cross-repo convergence plan, repo by repo | [ecosystem-convergence.md](docs/wiki/ecosystem-convergence.md#11-the-cross-repo-convergence-plan-repo-by-repo) |

## **AGENT DIRECTIVES**

- NO BLIND GREP: never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: state assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: touch ONLY requested code. Map changes 1:1 to the prompt.
- WORK ON `main`. No feature branches, even if a brief says otherwise. Commit directly.
- NO FALLBACKS: never add a fallback path. Diagnose why the primary path failed and fix it there.
- FIX, NEVER DEFER: a warning or failure you meet is yours, whether or not you caused it. "Pre-existing" is not a disposition.
- FACE THE BLOCKAGE: fix the cause of a failing hook (`bun run format`), never stash or bypass it.
- STATE PRUNING: when updating SESSION STATE, DELETE completed work outright. Its rule goes to `durable-rules`, its story to `CHANGELOG.md`, its mechanism to the wiki page that entry points at. **Do not reconstruct shipped work here.**
- CLAUDE.md HYGIENE: capped at ~250 lines on purpose, and it is an INDEX first. A rule needing a paragraph belongs in `durable-rules`; a story in `CHANGELOG.md`; a measurement on the topical wiki page. If this file grows, something belongs somewhere else.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> commit -> update SESSION STATE -> STOP.
- COMMIT **AND PUSH** IN THE BACKGROUND, ALWAYS - both are minutes long and neither is worth a blocked session. The pre-commit hook sweeps the WHOLE frontend (2-3 min) and re-stages it; a push to this remote routinely exceeds a 5-min foreground timeout. Isolate unrelated dirty files first. `rm -rf apps/*/dist` before `git push`.
- DOCUMENTATION: technical docs in `docs/wiki/` (English, LLM-oriented, **search it before reading source**). User guides in `docs/user-guide/` (French). UML in `docs/diagrams/`. Root: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- WIKI IS PREFERRED: update the relevant wiki page alongside code changes - stale wiki is worse than none. Keep `apps/*/README.md` synced with its wiki counterpart. Cross-link freely.
- CHANGELOG: features, fixes and breaking changes get an entry under `[Unreleased]` (Keep a Changelog format).
- ONE-OFF ACTIONS GO TO THE USER (2026-08-25): *"Pour les choses qui ne se font qu'une fois, tu peux me demander de les faire hein."* Building a tool for a single click is that waste.
- DELEGATION: broad file-gathering goes to a search subagent; a big, risky or native Work Package goes to a background agent through a precise brief in `AGENTS.md`.
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` (via ProxyJump canari). Postgres is the container `infrastructure-postgres-1`, and `auth_db` is the ONLY database - every service shares it, social-service included (its `DB_DATABASE` default `canari_social` does not exist on prod). User `canari`. **Use the PowerShell tool, never Bash** - Git Bash strips the backslashes out of the cloudflared ProxyCommand. Quote SQL single-outer, doubled-inner: `ssh canari 'docker exec … psql -U canari -d auth_db -x -c "SELECT … WHERE id = ''uuid''"'`.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (front) | Rust WASM openmls | NestJS + Rust Axum (back).
- Nginx: single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS (RFC 9420): all encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: `frontend/src/lib/wasm/` and `src/lib/proto/canari.{js,d.ts}` are GENERATED and NOT in git.
  `cd frontend && bun run generate` after a structural change; every pipeline builds them itself
  ([mls-wasm](docs/wiki/frontend/mls-wasm.md#why-it-is-not-committed)).
- Auth: access tokens in memory ONLY (never localStorage). Refresh token in an HttpOnly cookie **everywhere the engine keeps one** - on `tauri://localhost` (iOS, macOS, Linux) WKWebView drops it and the client carries it in `X-Canari-Refresh` instead, one fact deciding both sides ([sessions](docs/wiki/sessions.md#the-credential-a-client-carries-itself)). WS auth via `canari_ws_token`.
- Media: the client generates the CEK (AES-256-GCM) before upload. The backend sees opaque blobs.
- Infra truth: keep `infrastructure/MIGRATION.md` synced with new secrets, services or bootstrap steps; add a new service to `docs/wiki/infrastructure/` and the `README.md` diagram.

## **CODING STANDARDS**

- Logs: mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions and error branches.
- Docs: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, never restate types.
- Factorization: extract and export reusable logic. Zero duplication.
- Language: code, comments, docs and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline literals, ALWAYS, even in a plain `.ts` util, and even when a nearby call site already has raw strings.
- Punctuation: ASCII (`'`, `"`, `-`) everywhere; escape quotes in code. Keep French accents ONLY in localized strings and French comments.
- Tests: changing logic requires changing the associated test.
- UI: single source of truth is `src/app.css` (tokens, `--radius-*`). `.btn-glass` with modifiers. Dark-first glassmorphism. No raw hex/px. `@lucide/svelte` only (NOT `lucide-svelte`, the old package name - both resolve).

## **KEY COMMANDS**

- Package manager: bun everywhere - frontend and the four NestJS apps each commit a `bun.lock`, CI installs `--frozen-lockfile`, the Makefile calls bun. **`.bun-version` is the ONE place this repo names a bun version.** No `packageManager` field, no `engines.bun`, no npm.
- Setup/dev: `make install`, `make run-services`, `cd frontend && bun run dev`.
- Tests: `make test`, `make test-frontend`, `cargo test`.
- Frontend gates before every commit: `bun run check` (0 errors), `bun run lint`, `bun run format`. Rust >= 1.97. `cargo clippy` for Rust crates. `make run-ci` for the full local pipeline.
- **NOTHING IN THIS REPO IS FORMATTED BY PRETTIER.** Everything is `oxfmt` (`oxfmt.json`) + `oxlint`. A bare `npx prettier --write` finds NO config, silently applies its own defaults (double quotes, 80 cols) and rewrites whole files - it did, and shipped. Use the package's own `format` / `lint` script, always. `bun run lint` shells out to `sh` (the oxvelte shim), so run it through the Bash tool.

## **THE RULES THAT APPLY TO EVERY TASK**

Everything area-specific is in [durable-rules](docs/wiki/durable-rules.md). These are the ones no task
escapes.

- **A status code is an ANSWER, a transport failure is not.** Only a 401/403 may log a user out, and `navigator.onLine` never proves reachability (a captive portal reports `true`).
- **Never branch on an error MESSAGE.** A distinction carried in prose is a distinction exactly ONE call site will make - classify at the THROW, as a type. When auditing such a seam, enumerate its consumers, never just the ones that mention it.
- **IDEMPOTENCE COMES FROM DURABLE STATE, TERMINATION FROM A PROOF - never from a clock.** Ask of every timer what it would mean if it were wrong; if the answer is "more traffic", it is load-bearing and should not be. But durable state answers only THE QUESTION IT WAS WRITTEN FOR: "is this broken" and "have I already asked" differ only in lifetime, and using one for the other silences the trigger.
- **A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER.** A liveness clock must be written by the thing whose liveness it measures.
- **A PREDICATE THAT NAMED THE LAST INCIDENT IS NOT THE PREDICATE THAT NAMES THE NEXT ONE.** Re-measure it against the population it will actually run on - one `GROUP BY` settles it in seconds.
- **A CORRECT MECHANISM WITH NO REPORT IS FOUND BY HAND, A DAY LATE**, and the report must carry the evidence separating the causes it cannot itself distinguish.
- **A CLAIM THAT SOMETHING IS STALE MUST NAME THE MECHANISM THAT WOULD HONOUR IT AND SHOW THAT MECHANISM GONE.**
- **Every swallowed branch logs** - in a best-effort path that is all a loss leaves. A batch of jobs catches and logs PER JOB; isolation is a `try` per subscriber or it does not exist.
- **A DESTRUCTIVE CONTROL NEEDS AN ALLOWLIST OF WHAT IT MAY TOUCH, NOT A DENYLIST** - and a destructive repair must be gated on knowing the state is really broken.
- **WHEN SOMETHING KEEPS REFILLING, DELETING IT IS NOT THE FIX** - revoke whatever keeps naming it as a destination. And before deleting a container to reclaim what one member costs, enumerate the other members.
- **Default to Paraglide for ANY new user-visible string, on the first draft.** Nothing types a string as user-visible, so no compiler enforces it.
- **Never assert a wall clock in a test.** Two isolated browser contexts = two devices.
- **A green gate is not a working system.** Everything native is verified by COMPILING, which proves nothing about running; a green deploy proves the containers started, never that the site answers.
- **A FALLBACK IS A SIGNAL, NEVER A PATH.** Reaching one means the primary path failed and the fix belongs THERE. So it is logged at a level that ACCUSES, and its rate is measured against the population before its name is believed.
- **A RACE THAT HEALS CLEANLY IS STILL A DEFECT.** If the mechanism needs a heal in THEORY it is wrong, whatever it does in practice. Name what makes the two paths overlap and delete the overlap - a ledger that reconciles them afterwards is a witness, never a fix.
- **NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU.** Handing an operation to a layer certain to refuse it, in order to classify the refusal, is work the design owes: carry the discriminator to where the decision is made, from where it is already KNOWN.
- **NOISE IS NEVER ACCEPTABLE - web, mobile or server.** A line is either expected AND necessary, or it is the visible end of something upstream. Explain it or fix it, and never demote it - the cost is real, and a line its reader learns to skip is the one that hides the next defect.

---

## **SESSION STATE (Active Memory)**

**Five repos**, all on `main`:

| Repo | Where | Status |
| --- | --- | --- |
| **Canari** (this monorepo) | `emse-students/canari`, **PUBLIC** | active - see below |
| **Sky** | `../Sky` | COMPLETE, nothing open |
| **MiGallery** | `../MiGallery` | COMPLETE. Its search met the standing requirement on 2026-08-19 (`fuzzyScore`/`fuzzySearch`, `docs/wiki/search.md` there): word inversion, transposition-aware edit distance, and ranking on every list that truncates. |
| **Portail-etu** | `../refonte-portail-etu` | COMPLETE. **No SSH to that box** - the self-hosted CD runner is the only way in; `deploy.yml` has a `workflow_dispatch` (a dispatch can 500 while STILL creating the run - check `gh run list` before re-dispatching). PUBLIC, so every run log must redact and `grep -a` is mandatory. `pm2 flush`, never `rm`. `data-export/` holds PII, never commit. |
| **Le Cercle** | `../le-cercle`, `gitlab.emse.fr:aurel.dautry/le-cercle` | Aurel's repo, but the rewrite is MERGED and we hold push rights now. See below. |

Work is tracked as Work Packages by severity: **P1** (security, or a broken user-facing path), **P2**
(correctness), **P3** (hygiene). Delete a WP outright once it ships - from HERE and from
[backlog](docs/wiki/backlog.md) both. Since 2026-08-18 nothing is parked: anything new goes into the
queue below in its place, and its substance into `backlog`.

### CANARI - THE QUEUE, IN ORDER

Everything actionable is HERE, one line each; the detail lives where the link says and **is not
restated**. An item is done when its code, its tests, its doc and its commit are in, and it is then
deleted from BOTH this file and [backlog](docs/wiki/backlog.md). **Every defect story is in
`CHANGELOG.md`, every rule one left is in [durable-rules](docs/wiki/durable-rules.md), every verdict
is on [cross-client-testing](docs/wiki/cross-client-testing.md); none of the three is restated here.**

1. **THE CAMPAIGN ITSELF - RUNNING, by the user's decision of 2026-08-21** (*"C'est parti pour la
    campagne"*, in autonomy). The ladder, top to bottom, so every phase runs - including the six that
    had no runner, written as the ladder reaches them. **Every verdict, every cause and the format of
    a cell are on [cross-client-testing](docs/wiki/cross-client-testing.md); design, cost and the
    decisions the dirt turns on are on
    [cross-client-campaign](docs/wiki/cross-client-campaign.md). Neither is restated here.**

    **THE USER'S PRIORITY, 2026-08-27, verbatim: *"PASS ou PASS-DIRTY sur COMM, DEL, MULTI, LIFE,
    NOTIF, HEAL."*** Those six ARE the target; TAB, CALL, PIN and CORRUPT come after them, and
    nothing else is worth a token until those six are green.

    **Where the ladder stands: rungs 1-10 TAKEN plus 12 MULTI, and COMM and DEL are the first two
    rungs with NO `FAIL`.** COMM on `0c31be5d` is 18 `PASS` / 5 `PASS-DIRTY` / 2 `VACUOUS`, DEL is
    4 / 5 / 1, and **the phone ran every `+A1` row for the first time**. **COMM-8 PASSES**: the forked
    distribution group is fixed and measured. **Every non-pass left has a named cause, all on the
    board and not restated here** - DEL-7 and DEL-9 were HARNESS faults (now fixed), MULTI-5 is runner
    debt, and MULTI-3/4 are `SKIPPED` on a re-enrolment cost. **Three rows - COMM-12, COMM-22, DEL-9 -
    are `VACUOUS` with `failures: []`, voided by a CD deploy landing mid-run: a campaign run and a
    push to `main` are MUTUALLY EXCLUSIVE**, and `gate` refusing the attribution is the only reason
    nothing false was recorded. **What is owed next, in order:** those three re-runs in a quiet window;
    then re-runs of every DEL and MULTI cell, because both runners have CHANGED since (`del.mjs` is
    `2dd7a0f4a933`, `multi.mjs` `74bb17b8283f`, and `rows.mjs` names each row); then LIFE, NOTIF,
    HEAL. **HEAL IS NOW THE RUNG IN HAND, and after two nights it has exactly TWO cells: HEAL-NEW-0
    `PASS-DIRTY` and HEAL-NEW-1 `PASS`, both on `48b65d08`.** Run 3 (2026-08-28 03:30-03:58) took
    eight rows and recorded NOTHING - five HEAL-NEW exit 1, four HEAL-REVOKE exit 2 - and **both
    causes are the instrument, both are now fixed or named, and neither is a product defect.** (1)
    `sameAccountEnrolled` read `census()`, which reads `key_package` UNION memberships and therefore
    answers *is this device addressable*, never *does it exist*; there is **NO device-registry table
    on this schema**, `auth_sessions` is the only row a registration writes, and `isRegistered()` in
    `devices.mjs` now reads it. **12 of today's 22 session-without-KeyPackage web devices looked like
    a regression and are all `d82cd226` inside run 3's own 16-minute window** - the rig is a
    participant, so a population is not a finding until you ask who is in it. **AND THE QUESTION THAT
    PARAGRAPH LEFT IS NOW ANSWERED, BY THE SERVER: a wiped profile publishes in 1.9 s. The refusal was
    the per-user DEVICE CAP** - the rung's own sixteen rows each mint and abandon a device, so 15/15
    was reached by construction and `register-device` answered 400 before it logged anything. Both
    halves are FIXED and shipped (server code + client type + the rig asserting a free slot before it
    wipes); story in `CHANGELOG.md`, rules in
    [durable-rules](docs/wiki/durable-rules.md#mls-membership-and-routing), what remains in
    [backlog](docs/wiki/backlog.md). **`enrolled` is a product fact again, and no HEAL-NEW cell needs
    re-measuring for that reason.** (2) All four
    HEAL-REVOKE rows were refused by the preflight because **W2 was alive, on `/login`, and logged
    out** - `still unknown after 4 repair(s)` - a state no baseline in this rig restores, since
    `launch.mjs start` no-ops on a running browser and `unlock.mjs` only answers a PIN. Try
    `login.mjs --device W2`. **This is queue item 6 blocking rows, not merely owed.** Detail and
    every measurement are on the board and in
    [testing-methodology](docs/wiki/testing-methodology.md); neither is restated here.

    **AND A SECOND P1 CAME OUT OF THE SAME NIGHT, FIXED 2026-08-28: a revoked device wiped itself and
    then put its own state back 1.25 s later**, because the 5 s SYNC_WATCHDOG was never stopped and
    `ensureMls()` rebuilds a client whenever it finds none. `tearDownLiveSession` is now shared by
    logout and revocation, and `wipeDeviceToFactory` reads the stores back instead of claiming an
    empty device. **What is OWED is a row, because nothing on the board asks this question:** a
    HEAL-REVOKE cell that asserts the storage is EMPTY after a revocation, and the user's own
    question - does it still wipe when the device was OFFLINE at deletion time - which the design
    answers (`isDeviceRevoked` says `false` when unreachable, so the wipe lands at the first login
    WITH a network) and no run has ever shown. Story in `CHANGELOG.md`, mechanism on
    [auth](docs/wiki/frontend/modules/auth.md#erasing-a-revoked-device-and-the-125-s-that-undid-it).

    **Two things must NOT be read as settled:** DEL-10 passed where it FAILed on `2a4297cb` but
    nothing names what changed and the two runs measured different queues, so its P2 STAYS OPEN; and
    COMM-8 passes with `seedAfterTheGrant: repaired`, not `true`, so WP-REGRANT-2's proof is still
    owed - the seed arrived by the REPAIR path, and a fallback is a signal, never a path. COMM-23's
    403 to the OWNER of the group it had just minted is unexplained.

    **A1 IS ARMED AND HAS NOW EARNED ITS ROWS** - Pixel 6a, armed with `node phone.mjs 9333` (ONE
    positional port, NOT `--ensure`). It cleared the four COMM `+A1` rows that had stood on
    `6808a89c` since 2026-08-22, and carried DEL-7 to its first `PASS`. **A dead `adb devices` is not
    always the cable:** it was empty until the user re-plugged, and the `A1_WIFI` fallback needs a
    prior `adb tcpip 5555` it did not have. **And an unarmed phone can be INVISIBLE to a runner** -
    `devicesFor` dropped it silently for a whole rung; the preflight header names the devices, read it.

    **A `PASS-DIRTY` NO LONGER STOPS A RUNG BY ITSELF (user, 2026-08-25)**, and **a x5 sweep of the
    WHOLE ladder accepting nothing short of `PASS` comes AFTER the campaign reaches the bottom (user,
    2026-08-26)** - until then one pass per rung is the target. **What is left is a WRITING job as
    much as a running one:** only CALL, CORRUPT and PIN have NO runner at all.

    **PUSHING TO THIS REMOTE IS A HAZARD IN THREE WAYS, all hit on 2026-08-27.** (1) **A pipe masks
    the exit code** - `git push ... | sed > log; echo $?` reported success on a FAILED push: redirect,
    then read `$?`. (2) **A background wrapper reports ITS exit, not git's** - a rejected
    non-fast-forward push came back as exit 0 and was caught only by reading `PUSH_EXIT` out of the
    log. **Leon AND a parallel session both push `main`: fetch and rebase before every push.** (3)
    Four failures with `fatal: unable to access ...: Empty reply from server` (exit 128) while
    `git fetch` succeeded every time; the fifth, carrying
    `http.version=HTTP/1.1` **and** `http.postBuffer=524288000`, went through. **ONE SUCCESS DOES
    NOT SAY WHICH KNOB DID IT, or whether either did** - the failures were not reproduced against a
    control, so treat those two flags as a thing to TRY on the next `Empty reply`, never as the
    known fix. `http.sslbackend` is `schannel` and no proxy is set. A push takes minutes because the
    pre-push hook runs the frontend gates: **background, always.** And **CD's colour is not the
    deploy's verdict** - read the SERVED artefact.

    **A KILLED RUN CAN DESTROY A MEASUREMENT SECONDS FROM BEING RECORDED**, and **`node rows.mjs`
    SETTLES WHETHER THE BOARD STILL MATCHES THE LEDGER - run it before believing a cell**
    ([testing-methodology](docs/wiki/testing-methodology.md), the only copy). It has now caught the
    board wrong THREE times, the last on 2026-08-27 when nine COMM cells named verdicts the ledger
    contradicted - in BOTH directions, a `FAIL` the ledger had already cleared included. **The board
    now matches the ledger exactly: zero disagreements**, the only gaps being six SETUP rows taken by
    hand and NOTIF-4 / HEAL-W2, whose stale ledger verdicts their cells name in prose. The shared
    venue is `fbddc890` / `general` `064ac7d2`, rebuilt 2026-08-26 after a THIRD disappearance.

2. **A PLACEHOLDER HELD A MEMBER'S PLACE IN A REAL CONVERSATION - the user's lost messages, and
    the ghost, are ONE P1. CAUSE FOUND, GUARDS SHIPPED 2026-08-28, CLEANUP AND ONE PROOF OWED.**
    Measured on prod: for 134 minutes the peer had NO active device in the group, because a
    `userId='unknown'` / `deviceId='pending'` row was stored **`active` 0.84 s before the real
    members joined** while both of the peer's own devices sat `pending`. Twenty-one
    `No active membership`, every `MSG_FETCH count=0`, **no `COMMIT` for the group at all**; what
    ended it was the user REINSTALLING, which minted a new device id and took the group's only
    commit - nothing self-corrected. The cause is one client seam publishing `BaseMlsService`'s own
    non-identity sentinels, and **the existing ghost gate could not see it: a shape allowlist is not
    an identity allowlist**, and the placeholder held a KeyPackage so it read as addressable.
    Guarded at BOTH ends (named constants + typed `UnresolvedIdentityError` on the client,
    `sanitizeIdentityValue` on `REGISTER_DEVICE` and `invitations/status`), 12 tests. **Owed, in
    order: DEPLOY then clean the row and its 72 queued frames** (cleaning first lets a client
    re-create it and destroys the evidence); and **do NOT assert the guards fixed the activation** -
    an active member was polling and was answered `invitations=8` six times and committed none, and
    only a CLIENT log separates the causes. **Not iOS, not mobile: 9 of the 10 stranded memberships
    are `web-`.** Substance in [backlog](docs/wiki/backlog.md), rules in
    [durable-rules](docs/wiki/durable-rules.md), story in `CHANGELOG.md`; none restated here.

3. **NOTHING ON THE CAMPAIGN BOARD COULD HAVE CAUGHT IT, AND THE GAP IS STRUCTURAL** (checked
    2026-08-28 on the user's question). Of ~200 rows exactly ONE reads
    `dm_device_group_memberships` - COMM-8 - and it reads WHO is named, never WHAT STATUS they hold;
    every other row asserts the symptom, which this defect leaves intact. And no row asks a question
    whose answer is a POPULATION, so three memberships stranded for 25 days were invisible. **Four
    rows written into rung 12 MULTI** (7: assert the ROW and that none names a placeholder; 8: a
    device enrolled while the peer is offline reaches `active` **without a reinstall**; 9: delivery
    after activation, and nothing claiming success in between; 10: the whole-population invariant,
    run as a preflight). All four need only `W1 W2`. On
    [cross-client-testing](docs/wiki/cross-client-testing.md), the only copy.

4. **DEFERRED PAST THE LADDER - seven UX and rendering items, substance in
    [backlog](docs/wiki/backlog.md) and NOWHERE else**, named here only so none is forgotten: the
    POSTS search that loads the whole base; the EMOJI picker that neither scrolls nor stays on
    screen; HEAL's partially-restored old client; **ONE BUNDLED EMOJI FONT everywhere** (Noto Color
    Emoji, decided 2026-08-23, owing ELEVEN rows to the SECOND campaign); the dead row a deleted
    group leaves every other member; the trash and the pencil on a device row not reading as the same
    kind of control; and a MENTION rendering as its raw `@[uuid]` token (NOTIF-13 pins it). The
    emoji, the dead row and the device controls want ONE pass over `app.css`, not seven local
    patches.

5.  **THE SFU RUNS SIX webrtc MAJORS NOBODY HAS PLACED A CALL ON.** `apps/call-service` compiles,
    clippy is clean under `--all-features` and its ten tests pass - none of which runs the ICE stack.
    The CI hole that let two breaking Dependabot majors merge green is CLOSED (no crate in this repo
    is uncompiled now), and the one known behaviour change is handled: an empty TURN credential used
    to degrade quietly and now fails the whole ICE configuration. **What settles it is ONE relay-path
    call**, which is rung 15 CALL and has no runner. Substance in [backlog](docs/wiki/backlog.md),
    story in `CHANGELOG.md`; neither is restated here. **A release must not carry this unplaced.**
6.  **ONE NAMED STARTING POINT FOR EVERY PHASE, STEP AND STEP GROUP** - asked by the user 2026-08-25
    (*"le meme point de depart, independamment de ce qui a pu se passer avant"*). The PHASE-level half
    is `run.mjs`'s preflight; what is left is per-STEP granularity, pulled forward the moment a rung is
    blocked by an inherited state. Contract, audit and the seven-file PIN predicate it fixes are in
    [backlog](docs/wiki/backlog.md); diagnosis order is [testing-methodology](docs/wiki/testing-methodology.md) 39.

### CANARI - THE ECOSYSTEM CHANTIER (migration CLOSED in all five repos 2026-08-27; three JUDGEMENTS left)

The user's standing mandate, verbatim: *"Je veux de l'homogeneite et les meilleurs standards de
partout. Partout. oxlint/oxfmt ect partout, TS7 partout ou c'est possible..., Lucide derniere version
avec tous les composants stale corriges PARTOUT, bun a la place de npm PARTOUT etc."* Every
measurement and every per-repo state is on
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md), the only copy - section 8 the
package-manager half, section 9 the TypeScript 7 refusal, section 10 why Renovate is dropped.

**NOT TO BE RELITIGATED:** bun 1.4.0 is the runtime everywhere it can be AND lockfiles stay at v1,
which is not a conflict: bun >= 1.4 writes v2 for a lockfile it creates from NOTHING, while
`bun install` / `bun update` preserve the version they find, and **`bunx --bun bun@1.3.14 install`
regenerates at v1 with `configVersion: 1`** - 1.3.14 being the bun Dependabot itself bundles. bun
1.4.0 then accepts that file under `--frozen-lockfile` unchanged. All ten lockfiles in the ecosystem
are now v1 / configVersion 1. A regeneration RE-RESOLVES the tree, so it is paid deliberately with
every gate re-run, never as a side effect. The invariant is enforced by `Guard the bun lockfile
version` in `code-analysis.yml`, never by pinning a toolchain, because a pin never governed a
contributor's own bun; **TS 7 IS REFUSED ON CANARI** and `dependabot.yml` ignores its majors, or
`dependabot-auto-merge.yml` would land it unattended; **RENOVATE IS DROPPED**; Sky keeps Tailwind
and migrates to v4 without preflight; `bun:sqlite` replaces better-sqlite3; the `image_url` deletion
stands.

**CANARI'S HALF IS CLOSED, PROD INCLUDED** (four containers answering `["bun", "dist/main.js"]`,
site 200, verified 2026-08-27). **THE ONE MEASURED LIMIT ON "bun PARTOUT":** jest fails under the bun
runtime - `admin-storage.controller.mls.spec.ts` passes 8/8 under node and fails under bun - so CI
installs/lints/builds with bun and TESTS with node, and both call sites in `ci.yml` say so. **Do not
collapse that to one runtime without re-running that spec.** CD is GREEN again since `90d79b19`
(five red runs before it), `Check Dependencies Vulnerabilities` included, and exactly ONE Dependabot
alert is open: `libcrux-chacha20poly1305` (GHSA-hc3c-63hc-2r9f, HIGH) in `frontend/mls-wasm/Cargo.lock`,
already measured as UNREACHABLE - the crate is not compiled, the HPKE backend built is
`hpke-rs-rust-crypto`. It needs dismissing on GitHub, not fixing.

**THE MIGRATION HALF IS CLOSED IN ALL FIVE REPOS** (Canari, Sky, MiGallery, le-cercle,
Portail-etu): oxfmt/oxlint/oxvelte everywhere, bun everywhere it can be, TS 7 wherever it is not
refused. **Every commit, measurement and per-repo state is section 11 of
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md), the only copy - add to its table
rather than re-deriving it**, which is what made this paragraph wrong twice. **A SECOND SWEEP of
2026-08-27 found ELEVEN residual gaps and closed nine** (its own table in section 11, with every
measurement): one oxfmt and one oxlint version everywhere, one lint scope, one shim dialect, the
dead `frontend/.husky/`, the three-way bun declaration, Sky's `bun-version: latest`, the stale npm
/ ESLint / Prettier docs, and - after a first pass wrongly called it impossible - `configVersion: 0`
on the last six lockfiles. **The one that is NOT a closure: NestJS 11 -> 12 is parked as a P2**
([backlog](docs/wiki/backlog.md#tooling)) - a framework major across four deployed services is not
a bump. What is left beyond it is JUDGEMENT: MiGallery's lint warnings (section 11 names the two
that must not be swept); the `resolve()` question three repos park differently -
[backlog](docs/wiki/backlog.md#tooling); and Tailwind class sorting on Portail-etu, deliberately not
done in the same commit that swapped its toolchain.

**Guardrails, so nothing is "finished" by undoing a measurement:** MiGallery's RUNTIME stays node
(better-sqlite3 segfaults bun 1.4.0, and bun once OOM-killed that prod); Portail-etu's
`.bun-version` stays 1.3.8 (its host cannot start >= 1.3.9, and 1.4.0's lockfile v2 kills its
Dependabot); le-cercle's toolchain is **MERGED (!5)**, its ReDoS fix already on `main` by the user's
decision. **Its pipeline had failed three times while this file called it green**, and
reading it needed `glab`, now installed and authenticated against gitlab.emse.fr - **run
it from inside the repo, or `glab api` resolves the host as gitlab.com and answers 404.**
The cause was never the code: the production host was out of disk, fixed as **!6**, also
merged and verified on a real deploy. Two rules came out of it, both in
[durable-rules](docs/wiki/durable-rules.md#shared-gotchas): **a cache rewritten every run
cannot be bounded by a clock**, and **image sizes are not additive** - `RECLAIMABLE` is the
only column worth reading. **Measured, NOT assumed, on our own hosts: the mechanism does
NOT transfer** - Canari and mitv pull `:latest` from ghcr, so their old images go dangling
and a plain prune would reclaim them. What they share is that no prune runs at all: 57
dangling images + 64 dangling volumes on `canari`, 77 on `mitv`. Neither is near its edge
(73 G and 378 G free), so it is a P3 in [backlog](docs/wiki/backlog.md#infrastructure), not
an incident. Four rules came out of this chantier, all in
[durable-rules](docs/wiki/durable-rules.md): oxvelte pinned by sha, not branch; a guard restating
what the tool enforces goes stale; **dropping a `--config` flag does not remove the config**; and
**the executable bit is metadata Windows drops silently**, which cost Portail-etu a pipeline and was
armed on le-cercle too. **Read section 9 before touching TS 7 anywhere.**

**OWED TO THE USER, NOT TO THE CODE: the MLS + Graine explanation** - prose and diagrams, no code
(user, 2026-08-20). Post-campaign; scope and the two audiences declined are in [backlog](docs/wiki/backlog.md).

**THE FIVE THAT CANNOT BE PULLED FORWARD** - none waits on us, each carrying its blocking condition in
[backlog](docs/wiki/backlog.md), the only copy: the iOS avatar-cache question (needs an iPhone), the Lydia flip
WP-LYDIA-1 (needs credentials Lydia owes), one MLS client in a SharedWorker, `dev.canari-emse.fr` plus
the SECOND campaign (post-campaign), and - owed to the user - is a MiGallery application worth building?
The sixth is gone: the `libcrux-chacha20poly1305` panic never reached this product, because the crate
is not compiled - the HPKE backend actually built is `hpke-rs-rust-crypto`. `cargo audit` reads the
LOCKFILE, which lists optional dependencies nothing enables, so **the first question about any
advisory is whether `cargo tree -i` can reach the crate at all.**

### CANARI - what is open

**Google Play: both mails of 2026-08-26 are CLOSED but for check R**, everything shipped and live;
thresholds and the two sites that will never clear are on
[mobile](docs/wiki/frontend/mobile.md#plays-q3-2026-quality-requirements-measured-against-this-app),
the only copy. Two things stay open and neither is re-openable: the 28-day memory P90 does not exist
yet, so **read Android vitals from late September 2026**; and **WP-RESTORE-1** (Zero-Tap Sign-In,
required April 2027, WebAuthn on a server that has none) is ACCEPTED and scheduled AFTER the
campaign ([backlog](docs/wiki/backlog.md)).

**Release: v0.14.9 SHIPPED 2026-08-28 00:46 and ALL THREE BUILDS PASSED** (Android 12m34s, iOS
14m46s, AppImage) - read `gh run list` rather than this line, which has been stale twice. It carries
the iOS FCM fix and is the build [check S](docs/wiki/device-verification.md) needs. The earlier skew
that killed Android Release and AppImage Release (Tauri `plugin-log` JS 2.9.0 vs crate 2.8.0) is
fixed, and no CI job could see it because nothing here compiles the Tauri app: `Guard the Tauri
JS/Rust version parity` in `code-analysis.yml` now reads the two committed files. Story in
`CHANGELOG.md`, rule in [durable-rules](docs/wiki/durable-rules.md#release-and-ci).

**AN APK IS NOT REACHED BY A DEPLOY: `frontendDist: "../build"` means the Tauri app EMBEDS the
frontend**, so every web fix reaches W1/W2/W3 through CD and reaches A1 only in a new build. That is
why v0.14.10 is being cut for the revocation-wipe fix - a version has to identify its content, or
`minClientVersion` and check S are reasoning about a name. What IS owed is
one iOS proof: `minClientVersion` is raised BY HAND from `/admin/platform`, and while a release can
now REACH App Store Connect, TestFlight is the BETA channel - nothing yet shows a build reaching an
ordinary iOS user. Ship the client, verify it arrived, THEN raise
([legacy-compatibility](docs/wiki/legacy-compatibility.md)).

**iOS RAN ON REAL HARDWARE for the first time on 2026-08-27** (iPhone, iOS 18.7, against prod) and
found a defect no gate could: **signing in was impossible, because the four Nest CORS allowlists named
the ANDROID WebView origin only.** Fixed - one tested `cors-origins.ts` per service plus the gateway's
`ALLOW_ORIGIN` - and the story is in `CHANGELOG.md`, the mechanism on
[mobile](docs/wiki/frontend/mobile.md#the-ios-login-that-died-in-a-cors-allowlist), four rules in
[durable-rules](docs/wiki/durable-rules.md#mobile-and-native); none is restated here. **Everything the
native project owns WORKED** - deep link, `ASWebAuthenticationSession`, the `UIApplication.shared.open`
self-reinvocation, `/auth/callback` - so mobile.md's "iOS has never run a check on hardware" is gone.
**A FULL iOS/Android PARITY AUDIT ran before the re-release** and everything else it read is symmetric
(push payloads, WS auth, entitlements, AASA, NSE, App Group, keychain, `CFBundleURLTypes`, no
platform-gated tauri command). **Its one open question is now ANSWERED AND FIXED.** iOS could log in but not STAY
logged in: measured on the same server in the same minute, the iPhone presented `cookies=[]` on 120
consecutive refreshes while A1 came back from `am force-stop` on ONE `refresh 200`. WKWebView drops the
third-party refresh cookie and offers no opt-in, so on `tauri://localhost` the credential is now
carried in `X-Canari-Refresh` and kept in an awaited store write, both sides choosing the transport
from one fact and never by being refused; Android and the web are untouched by construction. Mechanism
on [sessions](docs/wiki/sessions.md#the-credential-a-client-carries-itself), story in `CHANGELOG.md`,
the cookie-read shim and its removal condition in
[legacy-compatibility](docs/wiki/legacy-compatibility.md) - none restated here. **THE HARDWARE PROOF
IS IN: 0.14.6 installed on the iPhone and the session holds** (user, 2026-08-28), and the server side
says the same - `OIDC callback: credential also returned in the body` on `tauri://localhost`. Still
owed on macOS/Linux desktop, whose engines nobody has measured - that unknown is exactly what the shim
covers. A dead session is also no longer re-proven 120 times: the 401 is a proof about a credential
and is now latched.

**iOS HAD NEVER REGISTERED ONE PUSH TOKEN - CAUSE FOUND AND FIXED 2026-08-28, HARDWARE PROOF OWED.**
`push_token` held `android | 49` and no `ios` row had ever existed, so no alert, no mention and no
CallKit ring had ever reached an iPhone. **Two defects, both fixed.** The SILENCE half is CLOSED and
PROVEN on hardware: a device that exhausts its retries POSTs `/api/mls/push/unavailable`, and check S
saw `[PUSH_UNAVAILABLE] ... platform=ios reason=no-token` at 01:23 - the first word this platform has
ever said. The ACQUISITION half then took a second cause, found by reading the ORDER rather than
shipping another build: **this app does not own its `UIApplicationDelegate`** (wry installs one inside
`start_app`), and Firebase's App Delegate Proxy - the declared APNs->FCM bridge - samples that
delegate exactly ONCE, at `[FIRApp configure]`, which runs from `main()` before the application
exists. It found nil and never retried, so the APNs token was dropped on every launch the platform
ever had. **The evidence had been in the file for months**: the neighbouring code already swizzles
wry's delegate by hand for remote notifications - work the proxy does when installed. Fixed by
`CanariInstallApnsTokenHook` on `DidFinishLaunching`, and the report now names WHICH branch failed
(`no-apns-token` / `fcm-token-fetch-failed` / `apns-registration-refused` / `app-delegate-absent`)
instead of the symptom. **Story in `CHANGELOG.md`, mechanism on
[mobile](docs/wiki/frontend/mobile.md#the-apns-token-had-nowhere-to-land-because-the-proxy-meant-to-catch-it-installed-nothing),
three rules in [durable-rules](docs/wiki/durable-rules.md#mobile-and-native), the P1 in
[backlog](docs/wiki/backlog.md), and what each outcome of the re-run MEANS in
[check S](docs/wiki/device-verification.md); none is restated here.** **RE-RUN CHECK S ON THE BUILD
CARRYING THIS** - everything native is verified by COMPILING, and none of the four reasons above is
the cause just fixed. One inference from the first run was RETRACTED (reconnection churn does not
reset the client's module state); it is written down in check S so it is not made again.

**THE iOS KEYBOARD IS FIXED THE WAY ANDROID'S WAS** (user, 2026-08-28: *"c'est assez handicapant"*):
WKWebView is never resized for the keyboard, so the shell was pinned to the visible height inside a
full-height document and a keyboard-tall empty band opened below it. `CanariApplyKeyboardLayout`
shrinks the WebView's frame - the layout viewport MOVES, no margin - and **no web change was needed**,
that branch of `computeSnapshot` having been written for a native resize iOS never did. **The BARS at
the top and bottom are NOT done** and are a P2 in [backlog](docs/wiki/backlog.md): they want ONE pass
over `app.css` with a device in hand, the same pass the emoji / dead-row / device-row items want.

**AND THREE OF THREE iOS DEFECTS SO FAR WERE INVISIBLE TO EVERY GATE HERE** - the CORS allowlist, the third-party refresh cookie, the FCM ordering. The user named the classes still to come before anyone looked (backgrounding, memory, a reconnection that does not happen); that expectation is recorded in [backlog](docs/wiki/backlog.md) and closes by HARDWARE, one lettered check at a time - **never by a fix written against a suspected iOS lifecycle bug nobody has seen**, because nothing here could tell whether it worked.

### CANARI - the test campaign

Four files, four jobs, all in WHERE THINGS LIVE above: board = state, campaign page = design,
methodology = how a result earns belief, README = operating manual. **Read them rather than re-deriving
state here, and keep no second copy.**

**The rig lives in the repo at `tools/cross-client-harness/`; its STATE lives outside at
`../canari-harness`** - `test-accounts.json`, the debug APK, A1's baseline, `results.ndjson`, and
`chrome-w1` / `chrome-w2`, which ARE the W1 and W2 devices. Losing a profile costs a re-enrolment and
SETUP-4's 2FA, the one step no tool here can answer. Outside the work tree a credential CANNOT be
committed and `git clean -xdf` cannot reach a profile.

**MUT-20 is unarmable until a campaign message reaches 90 days** (earliest 2026-11-09). **A DELETED
GROUP IS TWO ESTATES**: `cleanup.mjs` owns the server side, `dismiss.mjs` the copy each MEMBER's
client keeps; one allowlist for both, `debris.mjs` (detail on
[cross-client-campaign](docs/wiki/cross-client-campaign.md)).

**TAB-7 is the row to watch**: offline -> act -> online with no reload is exactly the trigger DEL-10
says nothing honours. A1's state is in the queue item above, not here.

**Prod IS the test server** and commit+push are authorised so it picks changes up.
`dev.canari-emse.fr` is a proxied CNAME to the same tunnel, NOT a second environment; it becomes one
AFTER the campaign (decided 2026-08-17, re-confirmed 2026-08-25 - pulling it forward would need its
own FCM project, which would unprove every push verdict already taken). Scope in
[backlog](docs/wiki/backlog.md).

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement, and `git pull` his work in. **It does not concern ours and owes no pass** (user,
2026-08-21).

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.
