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
| What a prompt handing ONE row to another session must carry | [cross-client-campaign.md](docs/wiki/cross-client-campaign.md#a-row-handed-to-another-session---the-delegation-contract) |
| Why a result may be believed | [docs/wiki/testing-methodology.md](docs/wiki/testing-methodology.md) |
| What the app has that NOTHING watches | [docs/wiki/mechanism-audit.md](docs/wiki/mechanism-audit.md) |
| How to operate the test rig | [tools/cross-client-harness/README.md](tools/cross-client-harness/README.md) |
| What Google Play sees that no gate here does | [tools/play-vitals/README.md](tools/play-vitals/README.md) |
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
| **MiGallery** | `../MiGallery` | COMPLETE |
| **Portail-etu** | `../refonte-portail-etu` | COMPLETE. **No SSH to that box** - the self-hosted CD runner is the only way in; `deploy.yml` has a `workflow_dispatch` (a dispatch can 500 while STILL creating the run - check `gh run list` before re-dispatching). PUBLIC, so every run log must redact and `grep -a` is mandatory. `pm2 flush`, never `rm`. `data-export/` holds PII, never commit. |
| **Le Cercle** | `../le-cercle`, `gitlab.emse.fr:aurel.dautry/le-cercle` | Aurel's repo, but our rewrite is MERGED (!5, !6) and we hold push rights. Reading its pipeline needs `glab`, **run from INSIDE that tree**. |

Work is tracked as Work Packages by severity: **P1** (security, or a broken user-facing path), **P2**
(correctness), **P3** (hygiene). Delete a WP outright once it ships - from HERE and from
[backlog](docs/wiki/backlog.md) both. Since 2026-08-18 nothing is parked: anything new goes into the
queue below in its place, and its substance into `backlog`.

**RESUMING (paused 2026-08-28 by the user: *"Prepare toi a reprendre directement la campagne, je
crois qu'il n'y a plus rien avant"*). In this order, and nothing else first:**

1. `git fetch` then **PUSH** - local commits are unpushed and a push redeploys prod, so it cannot
   happen during a run. Background, redirect not pipe, read `PUSH_EXIT`, `rm -rf apps/*/dist` first.
2. `gh run list` - CD GREEN and QUIET before any row.
3. `node state.mjs` - all four clients were logged in and unlocked at the pause, A1 on a local debug
   **0.14.12**. If the phone was unplugged, the from-zero sequence is in
   [the harness README](tools/cross-client-harness/README.md#operating-it), scripted end to end.
4. **HEAL, the rung in hand. Every verdict is on the BOARD and every adjudication on the CAMPAIGN
   PAGE - read them, they are not restated here.** W1's SSO lives in the `chrome-w1` profile and
   `login.mjs --device W1` is enough; nothing on this rung needs a human again unless that profile
   is lost (its 2FA is the one step no tool here can answer, and it cost a block on 2026-08-30).

   **NOTE (2026-08-30): the rung in hand was interrupted by the phone's turn, which found a P1 -
   see item 5, which is where a resuming session starts.** What follows is HEAL's own state and is
   unchanged.

   **Owed, in order: RE-RUN 9 on a build carrying `da0ce2f2`.** It has run twice and FAILed twice,
   and both failures were worth having: the first on a trigger the product does not have (the row
   asked a RELOAD, the product defines a LOGIN plus the PIN its refusal names - settled by the user
   2026-08-30, the product is the reference, the row is re-aimed and now asserts THREE things where
   it asserted one); the second on `noStoreSurvivedTheWipe`, a P1 in the wipe fixed in `da0ce2f2`.
   Everything before the wipe passes on both runs, and that is the half that matters. **-7 IS TAKEN**,
   `PASS-DIRTY` on `edb8d7ab`, but only after a SECOND `FAIL` on that same build: the fix stops new
   corpses and cannot raise the old one, and the group its own P1 had destroyed was still alive,
   unservable by any device, giving the fresh reference a thirteenth amber row the returning device
   never built. **Sweep the world after fixing a defect that WRITES state, or the re-run measures the
   old defect** ([methodology](docs/wiki/testing-methodology.md), and the corpse's whole class is a
   P2 in [backlog](docs/wiki/backlog.md) with its population). Then **HEAL-NEW-1 and -3 owe re-runs for the INSTRUMENT, not the product**: both predate
   `gate()`, so neither passed the dirt and mid-run-redeploy gate every other `PASS` passed
   ([methodology](docs/wiki/testing-methodology.md#a-field-in-the-detail-is-not-a-gate-and-two-heal-runners-believed-it-was)).

   **Two live instrument facts.** BOTH heal runners now carry their noise list, and the disposition
   is `ignoringExpectedLog` PER ROW, never a wider classifier: `healnew.mjs` has
   `withoutTheMintsOwnNoise`, and `healrevoke.mjs` has FOUR lists, one per observer, forgiving the
   mint and never the wipe. And the device cap that voided five cells is not in play: `healrevoke.mjs`
   now READS the count on both sides of every row (4 then 3 on 2026-08-30), the panel showing only the DELETABLE
   rows - **re-measure it around every run rather than quoting this.**

   **THE USER ASKED FOR THE LOGS TO BE READ ON EVERY PASS, the reconciliations especially**
   (2026-08-28): a heal that works is not a heal that was observed. It found the `UserBlock` P1 no
   row asks about, it showed HEAL-NEW-3's sidebar going green while the reconciliation covered only
   7 of 11 groups, and on 2026-08-30 it is what turned a `FAIL` into the P1 fixed in `edb8d7ab`.

### CANARI - THE QUEUE, IN ORDER

Everything actionable is HERE, one line each; the detail lives where the link says and **is not
restated**. An item is done when its code, its tests, its doc and its commit are in, and it is then
deleted from BOTH this file and [backlog](docs/wiki/backlog.md). **Every defect story is in
`CHANGELOG.md`, every rule one left is in [durable-rules](docs/wiki/durable-rules.md), every verdict
is on [cross-client-testing](docs/wiki/cross-client-testing.md); none of the three is restated here.**

1. **THE CAMPAIGN ITSELF - RUNNING, by the user's decision of 2026-08-21** (*"C'est parti pour la
   campagne"*, in autonomy), top of the ladder down, writing the runners the six unrunnable phases
   never had. **THE USER'S PRIORITY, 2026-08-27, verbatim: *"PASS ou PASS-DIRTY sur COMM, DEL, MULTI,
   LIFE, NOTIF, HEAL."*** Those six ARE the target; TAB, CALL, PIN and CORRUPT come after them.

   **Where it stands: rungs 1-10 TAKEN plus 12 MULTI; HEAL is the rung in hand**, 10 of 33 cells taken
   (3 `PASS`, 7 `PASS-DIRTY`), BOTH order pairs adjudicated EQUAL, and the HEAL-REVOKE group closed
   on the web with **two P1s found and fixed** - a wipe that never fired on a vault login, and a wipe
   that fired and was BLOCKED by a second `getStorage()` connection (`da0ce2f2`). **What is owed, in
   order:** the phone's turn as item 5 sets it out, which is where HEAL-REVOKE-6 lives; then
   **HEAL-REVOKE-1, -2, -3 and -4, which have NO RUNNER and are what actually closes the open P1**;
   then the ungated re-runs of HEAL-NEW-1 and -3; then re-runs of every DEL and MULTI cell, because
   both runners have CHANGED since; then LIFE and NOTIF. **A `PASS-DIRTY` does not stop a rung by itself (user,
   2026-08-25); a x5 sweep of the whole ladder accepting nothing short of `PASS` comes AFTER the
   ladder is finished (user, 2026-08-26).** Only CALL, CORRUPT and PIN still have no runner at all.

   **Three things must NOT be read as settled:** DEL-10 passed where it FAILed but nothing names
   what changed and the two runs measured different queues, so its P2 STAYS OPEN; COMM-8 passes with
   `seedAfterTheGrant: repaired`, not `true`, so WP-REGRANT-2's proof is still owed - a fallback is
   a signal, never a path; and COMM-23's 403 to the OWNER of the group it had just minted is
   unexplained.

2. **A PLACEHOLDER HELD A MEMBER'S PLACE IN A REAL CONVERSATION - the user's lost messages, and the
   ghost, are ONE P1. CAUSE FOUND, GUARDS SHIPPED 2026-08-28, CLEANUP AND ONE PROOF OWED.** Owed, in
   this order: **DEPLOY, then clean the row and its 72 queued frames** (cleaning first lets a client
   re-create it and destroys the evidence); and **do NOT assert the guards fixed the activation** -
   an active member polled six times, was answered `invitations=8` and committed none, and only a
   CLIENT log separates the causes.

3. **NOTHING ON THE CAMPAIGN BOARD COULD HAVE CAUGHT IT, AND THE GAP IS STRUCTURAL** (checked
   2026-08-28): of ~200 rows exactly one reads `dm_device_group_memberships`, and none asks a
   question whose answer is a POPULATION. **Four rows are written into rung 12 MULTI** (7-10), all
   needing only `W1 W2`, on the board.

4. **A GROUP WAS FORGOTTEN 291 ms AFTER ITS CREATION BY A CONCURRENT SWEEP - P1, found by
   HEAL-REVOKE-7 and FIXED 2026-08-30, answering the open question the previous P1 left.** Yes, another sweep compares a live local read against an older server one: it
   is `initializeConnection`'s, tagged `[SYNC]`, and the window is inside `createNewGroup` itself -
   the LOCAL group exists between `createGroup` and `registerMember`, so the server LIST cannot name
   it yet. `decideAbsentLocalGroupFate` then forgets it under "conversation row held with no
   membership left" **without ever reading a membership**. Fixed at the WRITE, not at the readers:
   the membership is now registered before the local group exists, in both creation paths, so the
   window is gone rather than narrowed. Story in `CHANGELOG.md`, mechanism on
   [chat](docs/wiki/frontend/modules/chat.md), rule (its FOURTH site) in
   [durable-rules](docs/wiki/durable-rules.md). **Two things must not be re-derived:** the obvious
   `isStillUserMember` fix would NOT have worked, and the reducer still concludes a non-membership
   it never reads - both in [backlog](docs/wiki/backlog.md). **A DEPLOY IS OWED before any further
   HEAL verdict about a newly created group.**

5. **THE PHONE'S TURN, VALIDATED BY THE USER 2026-08-30. START HERE: A P1 IS FIXED, BUILT,
   INSTALLED ON A1 AND NEVER RUN.** The quick reply was refused `HTTP 403` whenever the app was
   merely BACKGROUNDED - the push secret's two stores were read in the wrong order, and a KILLED app
   healed it before the test could see it, which is why the 2026-08-30 measurement passed. Cause,
   fix and the three defects it dragged out are in `CHANGELOG.md`, on
   [mobile](docs/wiki/frontend/mobile.md), in [durable-rules](docs/wiki/durable-rules.md) and in
   [backlog](docs/wiki/backlog.md); **none of it is restated here.**

   **THE ONE THING OWED IS THE RE-MEASUREMENT, AND ITS PRECONDITION IS NOT AMBIENT** - a run made
   without arming it proves nothing, because a resume migrates the secret and closes the window.
   The five steps, the assert that says the window is open, and the three verdict lines are in
   [check K](docs/wiki/device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found).
   Board rows NOTIF-6 (killed), NOTIF-6c (backgrounded, the FAIL) and NOTIF-6d (the failed-send UI)
   carry the state. **The iOS twin is corrected identically and is UNPROVEN on hardware** - it joins
   check S in what a device owes.

   Then, in order: check K **step 5** (the self avatar) and **K2** (airplane mode - a path proven to
   SEND is not a path proven to QUEUE); then **HEAL-NEW-5b**, the killed-responder row no cell asked
   about before; then **HEAL-REVOKE-6** and the six other `+A1` HEAL rows.

   **Rig facts worth not re-learning:** the adb daemon died twice mid-session and the preflight blamed
   the PHONE - `adb kill-server && adb start-server`, which also kills any background `logcat`.
   `node run.mjs --preflight A1` is the whole from-zero sequence after an `install -r`. A Kotlin-only
   change does NOT need the Tauri build: `gradlew :app:assembleUniversalDebug` in `gen/android`, 58 s.
   And `phone.notifications()` returns a bogus trailing pseudo-record (the tail of `dumpsys` after the
   last `NotificationRecord(` matches PKG), which inflates every count it returns - unfixed.

6. **DEFERRED PAST THE LADDER - seven UX and rendering items**, substance in
   [backlog](docs/wiki/backlog.md) and nowhere else, named here only so none is forgotten: the POSTS
   search that loads the whole base; the EMOJI picker that neither scrolls nor stays on screen;
   HEAL's partially-restored old client; **ONE BUNDLED EMOJI FONT everywhere** (Noto Color Emoji,
   decided 2026-08-23, owing ELEVEN rows to the SECOND campaign); the dead row a deleted group leaves
   every other member; the trash and the pencil on a device row not reading as the same kind of
   control; and a MENTION rendering as its raw `@[uuid]` token (NOTIF-13 pins it). The emoji, the
   dead row, the device controls and the iOS bars want ONE pass over `app.css`, not seven local
   patches.

7. **THE SFU RUNS SIX webrtc MAJORS NOBODY HAS PLACED A CALL ON.** It compiles, clippy is clean and
   its ten tests pass - none of which runs the ICE stack. What settles it is ONE relay-path call,
   which is rung 15 CALL and has no runner. **A release must not carry this unplaced.**

8. **ONE NAMED STARTING POINT FOR EVERY PHASE, STEP AND STEP GROUP** - asked by the user 2026-08-25
   (*"le meme point de depart, independamment de ce qui a pu se passer avant"*). The PHASE-level half
   is `run.mjs`'s preflight; the per-STEP half is pulled forward the moment a rung is blocked by an
   inherited state, as HEAL-REVOKE was. Contract and audit in [backlog](docs/wiki/backlog.md).

### CANARI - THE ECOSYSTEM CHANTIER (migration CLOSED in all five repos 2026-08-27)

The user's standing mandate, verbatim: *"Je veux de l'homogeneite et les meilleurs standards de
partout. Partout. oxlint/oxfmt ect partout, TS7 partout ou c'est possible..., Lucide derniere version
avec tous les composants stale corriges PARTOUT, bun a la place de npm PARTOUT etc."*

**Every decision, measurement, guardrail and per-repo state is on
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md), the ONLY copy - add to its tables rather
than re-deriving anything here, which is what made this section wrong twice.** Read section 8 for the
package manager, 9 before touching TS 7 anywhere, 10 for bun 1.4 and the lockfile-v1 invariant, 11
for the repo-by-repo state and the second sweep's eleven gaps. Its "NOT TO BE RELITIGATED" and
guardrail paragraphs exist so a later session cannot "finish" the work by undoing a measurement.

**What is left is JUDGEMENT, not migration:** MiGallery's lint warnings (section 11 names the two
that must not be swept), the `resolve()` question three repos park differently, and Tailwind class
sorting on Portail-etu. Plus one parked P2: **NestJS 11 -> 12**, a framework major across four
deployed services ([backlog](docs/wiki/backlog.md#tooling)). Exactly ONE Dependabot alert is open -
`libcrux-chacha20poly1305`, measured UNREACHABLE (the crate is not compiled; the HPKE backend built
is `hpke-rs-rust-crypto`). It needs **dismissing** on GitHub, not fixing - and the first question
about any advisory is whether `cargo tree -i` can reach the crate at all, because `cargo audit` reads
the LOCKFILE.

**OWED TO THE USER, NOT TO THE CODE: the MLS + Graine explanation** - prose and diagrams, no code
(user, 2026-08-20). Post-campaign; scope and the two audiences declined are in
[backlog](docs/wiki/backlog.md).

**THE FIVE THAT CANNOT BE PULLED FORWARD** - none waits on us, each carrying its blocking condition in
[backlog](docs/wiki/backlog.md), the only copy: the iOS avatar-cache question (needs an iPhone), the
Lydia flip WP-LYDIA-1 (needs credentials Lydia owes), one MLS client in a SharedWorker,
`dev.canari-emse.fr` plus the SECOND campaign (post-campaign), and - owed to the user - is a
MiGallery application worth building?

### CANARI - what is open

**Release: the version in the three files is `0.14.12`, bumped and UNTAGGED, and a release carrying
it is OWED - now URGENTLY, and the reason is a P1 in the field.** Google Play production serves
**14011**, and `0cf9c3dd` (the `coordinatorlayout` fix, without which EVERY biometric unlock dies in
the layout inflater) landed at 14:30 on 2026-08-28, AFTER the 0.14.11 bump. Play has reported the
crash from a real user's Galaxy S23 Ultra. **14012 is the first build that does not have it**, and
`node tools/play-vitals/vitals.mjs` is what reads the field. v0.14.11 shipped 2026-08-28 09:53 with its Android build green; .10 and .11 both
MEASURE the wipe defects rather than fixing them, so **no HEAL-REVOKE verdict about a clean device may
be taken on a build older than 0.14.12.** A1 already runs a local debug 0.14.12; W1/W2/W3 get the web
half through CD on the next push. **An APK is not reached by a deploy** - `frontendDist: "../build"`
means the Tauri app EMBEDS the frontend, so a version has to identify its content or
`minClientVersion` and check S are reasoning about a name. Read `gh run list` rather than this
paragraph, which has been stale twice. **How A1 is upgraded, and why the CI artefact cannot do it, is
in [the harness README](tools/cross-client-harness/README.md).**

**Google Play: both mails of 2026-08-26 are CLOSED but for check R**, everything shipped and live;
thresholds and the two sites that will never clear are on
[mobile](docs/wiki/frontend/mobile.md#plays-q3-2026-quality-requirements-measured-against-this-app),
the only copy. **Android vitals are now READ FROM HERE**, by a read-only service account, with
`node tools/play-vitals/vitals.mjs` ([README](tools/play-vitals/README.md)) - crash clusters, their
stacks, Play's own anomalies, nine metric sets and what each track serves. Both Feb-2027 memory
measures turned out readable at P50-P99; every RATE is still empty, which is Play withholding a
distribution for want of installs and NOT a green zero, so **re-read from late September 2026**.
Archiving a cluster is a console click and no IAM role changes that - the Reporting API has no write
method at all, so an acknowledgement goes in `tools/play-vitals/known-issues.json`, which names the
fixing commit and REPORTS a recurrence above it rather than muting. And **WP-RESTORE-1** (Zero-Tap Sign-In,
required April 2027, WebAuthn on a server that has none) is ACCEPTED and scheduled AFTER the campaign
([backlog](docs/wiki/backlog.md)).

**iOS - three defects found on hardware, all fixed, one proof still owed.** Stories in `CHANGELOG.md`,
mechanisms on [mobile](docs/wiki/frontend/mobile.md) and
[sessions](docs/wiki/sessions.md#the-credential-a-client-carries-itself), rules in
[durable-rules](docs/wiki/durable-rules.md#mobile-and-native---frontendmobilefrontendmobilemd). **None restated here.** Two things are
PROVEN and must not be re-verified: the session HOLDS on the iPhone, and a full iOS/Android parity
audit read everything else as symmetric. What remains open:

- **RE-RUN [check S](docs/wiki/device-verification.md) ON A BUILD CARRYING THE APNs FIX.** The SILENCE
  half is closed and proven on hardware; the ACQUISITION half is fixed and UNPROVEN, because
  everything native here is verified by COMPILING. What each outcome MEANS is written in check S,
  along with one inference from the first run that was RETRACTED.
- **The iOS bars** at top and bottom are a P2 in [backlog](docs/wiki/backlog.md) - the keyboard itself
  is fixed with no web change. They want the same `app.css` pass as queue item 4, with a device in hand.
- **`minClientVersion` is raised BY HAND** from `/admin/platform`, and only after a build is shown
  reaching an ORDINARY iOS user: a release can reach App Store Connect, but TestFlight is the BETA
  channel ([legacy-compatibility](docs/wiki/legacy-compatibility.md)).
- Nobody has measured macOS/Linux desktop cookie behaviour - exactly the unknown `X-Canari-Refresh`
  covers.

**AND THREE OF THREE iOS DEFECTS WERE INVISIBLE TO EVERY GATE HERE.** The user named the classes still
to come before anyone looked (backgrounding, memory, a reconnection that does not happen); that
expectation is in [backlog](docs/wiki/backlog.md) and closes by HARDWARE, one lettered check at a
time - **never by a fix written against a suspected iOS lifecycle bug nobody has seen**, because
nothing here could tell whether it worked.

### CANARI - the test campaign

Four files, four jobs, all in WHERE THINGS LIVE above: board = state, campaign page = design,
methodology = how a result earns belief, README = operating manual. **Read them rather than
re-deriving state here, and keep no second copy.**

**The rig lives in the repo at `tools/cross-client-harness/`; its STATE lives outside at
`../canari-harness`** - `test-accounts.json`, the debug APK, A1's baseline, `results.ndjson`, and
`chrome-w1` / `chrome-w2`, which ARE the W1 and W2 devices. Losing a profile costs a re-enrolment and
SETUP-4's 2FA, the one step no tool here can answer. Outside the work tree a credential CANNOT be
committed and `git clean -xdf` cannot reach a profile.

**`node rows.mjs` SETTLES WHETHER THE BOARD STILL MATCHES THE LEDGER - run it before believing a
cell.** It has caught the board wrong three times; the board now matches exactly, the only gaps being
six SETUP rows taken by hand and NOTIF-4 / HEAL-W2, whose stale ledger verdicts their cells name in
prose. **A killed run can destroy a measurement seconds from being recorded**, and **a campaign run
and a push to `main` are MUTUALLY EXCLUSIVE** - a mid-run deploy has already voided three cells.

**MUT-20 is unarmable until a campaign message reaches 90 days** (earliest 2026-11-09). **A DELETED
GROUP IS TWO ESTATES**: `cleanup.mjs` owns the server side, `dismiss.mjs` the copy each MEMBER's
client keeps; one allowlist for both, `debris.mjs`. The shared venue is `fbddc890` / `general`.
**TAB-7 is the row to watch**: offline -> act -> online with no reload is exactly the trigger DEL-10
says nothing honours.

**Prod IS the test server** and commit+push are authorised so it picks changes up.
`dev.canari-emse.fr` is a proxied CNAME to the same tunnel, NOT a second environment; it becomes one
AFTER the campaign (decided 2026-08-17, re-confirmed 2026-08-25 - pulling it forward would need its
own FCM project, which would unprove every push verdict already taken).

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement, and `git pull` his work in. **It does not concern ours and owes no pass** (user,
2026-08-21).

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.
