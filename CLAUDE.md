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
| The story of a defect that shipped | `CHANGELOG.md` |
| Campaign board: every check, its verdict, its build | [docs/wiki/cross-client-testing.md](docs/wiki/cross-client-testing.md) |
| Campaign design: the ladder, the scope, the preflight | [docs/wiki/cross-client-campaign.md](docs/wiki/cross-client-campaign.md) |
| Why a result may be believed | [docs/wiki/testing-methodology.md](docs/wiki/testing-methodology.md) |
| How to operate the test rig | [tools/cross-client-harness/README.md](tools/cross-client-harness/README.md) |
| What is owed on real hardware | [docs/wiki/device-verification.md](docs/wiki/device-verification.md) |
| Secrets, services, bootstrap steps | `infrastructure/MIGRATION.md` |
| A shim kept alive for old clients, and its removal date | [docs/wiki/legacy-compatibility.md](docs/wiki/legacy-compatibility.md) |

## **AGENT DIRECTIVES**

- NO BLIND GREP: never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: state assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: touch ONLY requested code. Map changes 1:1 to the prompt.
- WORK ON `main`. No feature branches, even if a brief says otherwise. Commit directly.
- NO FALLBACKS: never add a fallback path. Diagnose why the primary path failed and fix it there.
- FIX, NEVER DEFER: a warning or failure you meet is yours, whether or not you caused it. "Pre-existing" is not a disposition.
- FACE THE BLOCKAGE: fix the cause of a failing hook (`prettier --write`), never stash or bypass it.
- STATE PRUNING: when updating SESSION STATE, DELETE completed work outright. Its rule goes to `durable-rules`, its story to `CHANGELOG.md`, its mechanism to the wiki page that entry points at. **Do not reconstruct shipped work here.**
- CLAUDE.md HYGIENE: capped at ~250 lines on purpose, and it is an INDEX first. A rule needing a paragraph belongs in `durable-rules`; a story in `CHANGELOG.md`; a measurement on the topical wiki page. If this file grows, something belongs somewhere else.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> commit -> update SESSION STATE -> STOP.
- COMMIT **AND PUSH** IN THE BACKGROUND, ALWAYS - both are minutes long and neither is worth a blocked session. The pre-commit hook sweeps the WHOLE frontend (2-3 min) and re-stages it; a push to this remote routinely exceeds a 5-min foreground timeout. Isolate unrelated dirty files first. `rm -rf apps/*/dist` before `git push`.
- DOCUMENTATION: technical docs in `docs/wiki/` (English, LLM-oriented, **search it before reading source**). User guides in `docs/user-guide/` (French). UML in `docs/diagrams/`. Root: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- WIKI IS PREFERRED: update the relevant wiki page alongside code changes - stale wiki is worse than none. Keep `apps/*/README.md` synced with its wiki counterpart. Cross-link freely.
- CHANGELOG: features, fixes and breaking changes get an entry under `[Unreleased]` (Keep a Changelog format).
- DELEGATION: broad file-gathering goes to a search subagent; a big, risky or native Work Package goes to a background agent through a precise brief in `AGENTS.md`.
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` (via ProxyJump canari). Postgres db `auth_db`, user `canari`. **Use the PowerShell tool, never Bash** - Git Bash strips the backslashes out of the cloudflared ProxyCommand. Quote SQL single-outer, doubled-inner: `ssh canari 'docker exec … psql -U canari -d auth_db -x -c "SELECT … WHERE id = ''uuid''"'`.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (front) | Rust WASM openmls | NestJS + Rust Axum (back).
- Nginx: single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS (RFC 9420): all encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: `frontend/src/lib/wasm/` and `src/lib/proto/canari.{js,d.ts}` are GENERATED and NOT in git.
  `cd frontend && npm run generate` after a structural change; every pipeline builds them itself
  ([mls-wasm](docs/wiki/frontend/mls-wasm.md#why-it-is-not-committed)).
- Auth: access tokens in memory ONLY (never localStorage). Refresh token in an HttpOnly cookie. WS auth via `canari_ws_token`.
- Media: the client generates the CEK (AES-256-GCM) before upload. The backend sees opaque blobs.
- Infra truth: keep `infrastructure/MIGRATION.md` synced with new secrets, services or bootstrap steps; add a new service to `docs/wiki/infrastructure/` and the `README.md` diagram.

## **CODING STANDARDS**

- Logs: mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions and error branches.
- Docs: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, never restate types.
- Factorization: extract and export reusable logic. Zero duplication.
- Language: code, comments, docs and dev-facing strings MUST be English. User-visible strings use Paraglide (`messages/fr.json`, `en.json`) - no inline literals, ALWAYS, even in a plain `.ts` util, and even when a nearby call site already has raw strings.
- Punctuation: ASCII (`'`, `"`, `-`) everywhere; escape quotes in code. Keep French accents ONLY in localized strings and French comments.
- Tests: changing logic requires changing the associated test.
- UI: single source of truth is `src/app.css` (tokens, `--radius-*`). `.btn-glass` with modifiers. Dark-first glassmorphism. No raw hex/px. `lucide-svelte` only.

## **KEY COMMANDS**

- Package manager: frontend uses bun (committed `bun.lock`, CI `--frozen-lockfile`); the Makefile shells out to npm. Prefer bun locally.
- Setup/dev: `make install`, `make run-services`, `cd frontend && bun run dev`.
- Tests: `make test`, `make test-frontend`, `cargo test`.
- Frontend gates before every commit: `bun run check` (0 errors), `bun run lint`, `bun run format`. Rust >= 1.97. `cargo clippy` for Rust crates. `make run-ci` for the full local pipeline.
- **NOTHING IN THIS REPO IS FORMATTED BY PRETTIER.** Everything is `oxfmt` (`oxfmt.json`) + `oxlint`. A bare `npx prettier --write` finds NO config, silently applies its own defaults (double quotes, 80 cols) and rewrites whole files - it did, and shipped. Use the package's own `format` / `lint` script, always. `bun run lint` needs bash (the oxvelte shim), so run it through the Bash tool.

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

The user's decision of 2026-08-16, restated 2026-08-18: **the backlog and this file are emptied
before the campaign restarts.** Everything actionable is HERE, in order, one line each; the detail
lives where the link says and **is not restated**. An item is done when its code, its tests, its doc
and its commit are in, and it is then deleted from BOTH files.

**The campaign started 2026-08-19 and has produced TWENTY-NINE defects, twenty-eight fixed and ONE
OPEN** - COMM-4's, in item 3 below. **Every story is in `CHANGELOG.md` and every rule one left is in
[durable-rules](docs/wiki/durable-rules.md); neither is restated here.** The twenty-sixth is COMM-20's, on its FIRST run: a
permission-grid cell IS a delta and was being sent as the role's whole list, so two administrators
toggling two DIFFERENT keys of one role erased each other's work and the loser's grid kept drawing a
state the server had never held. The twenty-fourth and twenty-fifth are both COMM-7's - a salon
reserved for administrators handed every member a composer, and the fix for it (`viewerCanWrite` in
the workspace listing) served only whoever loaded the community AFTERWARDS, so the same check failed
identically a second time until the change was ANNOUNCED, split by the answer. Seven came from ONE private salon driven on prod through create ->
public -> private -> a SECOND MEMBER, and not one was reachable from the repository. **A check that
fails is a claim to CHECK, never a check to soften** - the reflex was to relax the assertion to match
the server, and it was the assertion that was right. **That is the whole lesson of the week, and it
is now a rule: a lifecycle is a SEQUENCE, and a unit test arranges the state it asserts on.**
1-2 are numbers a run has to produce; 3 is the community phase, stale AND never run, where the
rework's remaining risk sits; 4 is the campaign.
**ONE DISTRIBUTION GROUP PER PRIVATE SALON SHIPPED 2026-08-20 and is PROVEN ON PROD** - a salon's
seed frame goes out on the salon's own group, a community member outside `allowedUsers` holds no
routing row on it, and turning the salon public tombstones that group and releases its scope
([graine](docs/wiki/protocols/channel-encryption.md) §13, the only copy). **WP-GRAINE-2 is CLOSED,
both halves proven on prod (2026-08-19)** - client: epoch 25->26 and the tree down to 2 leaves;
server: W2 rejoined and left, `evict memberships=1 routes=1`, routing rows 3->2, then the client
followed to epoch 28. Every figure and the two defects the run itself found are on
[cross-client-testing](docs/wiki/cross-client-testing.md) §9.
Preflight, MSG and SETUP-9 are done and MSG-5 converges on all three clients -
read [cross-client-testing](docs/wiki/cross-client-testing.md) rather than re-deriving them. **The
phone is back (2026-08-17)**; keep `adb devices` answering. **There is NO iPhone and no iOS client
in the field (user, 2026-08-19)**, so the iOS ladder cannot run and parity is kept BLIND
([device-verification](docs/wiki/device-verification.md)).

1. **EGRESS OVER TIME - ARMED 2026-08-19, and it produces no work.**
   [egress-probe](infrastructure/egress-probe/README.md) samples once a minute and `report.py`
   prints every conditional rate next to the base rate it must beat. **It says nothing until the
   window contains an incident**, so read it the next time a stall shows up in a service log; the
   question itself is on [backlog](docs/wiki/backlog.md) and is not to be re-derived.
2. **THE DENOMINATOR ON THE PROFILE-FETCH FAILURES - the counter shipped 2026-08-19, the number
    comes from a run.** Every accusation in `displayName.ts` now ends `(failed/attempted, X%)`.
    There is no client telemetry, so the rate is read from a run log on each platform. **The
    `FAILURE_BACKOFF_MS` decision is what the number is FOR** ([backlog](docs/wiki/backlog.md)).
3. **THE COMM RUNNERS - SIXTEEN of the twenty-five written, and every one of them RUN ON PROD as it
    was written** (the user's decision, 2026-08-20: writing all twenty then running once is
    verification by COMPILING, which is what produced five of this week's defects). Written: 1, 2, 3,
    4, 5, 6, 7, 8, 9/10, 11, 12, 13, 16, 19, 23/24, sharing `comm.mjs`. **Remaining: 14, 15, 17/18,
    20, 21, 22, 25**, and three of them need a capability the harness does not have - real push
    (COMM-14), the phone through `adb` (COMM-17/18), a second device for one account (COMM-25). Each
    capability is itself unproven until a check using it produces a result it could not have produced
    by accident. Why the rows were rewritten is on
    [cross-client-campaign](docs/wiki/cross-client-campaign.md#rows-that-named-a-mechanism-the-product-does-not-have);
    every verdict the instrument has produced is on
    [cross-client-testing](docs/wiki/cross-client-testing.md) §9, the only copy. **Board rows stay
    `pending` on purpose** - a runner that PASSes while still proving itself is not a campaign verdict.
    **Owed before the campaign, and each is a run, not a decision:**
    - **COMM-4's defect, the only one still OPEN.** The invitee is shown NO card and the inviter is
      shown TWO. Localised as far as a log could take it: the invitee's device dispatches and handles
      the event, and the duplicate-conversation reading is dead (`rows: {onTheInviter: 1,
      onTheInvitee: 1}`); the inviter's second card carries a random id, so one producer bypasses
      `channelInviteMessageId`. The invitee's card took the BULK-INGEST path and `batchAddMessages`
      logged nothing on success - **the one inbound path with no success line**, now audible on both
      outcomes and classified in `watch.mjs`. Re-run COMM-4 on the deployed lines before touching the
      code: the next log says which of the three readings of that zero is true.
    - **COMM-20 re-run, a FIFTH time.** Four runs, three defects, each only visible once the one before
      it was fixed: the browser sent the role's whole list; the server then read-modify-wrote the row
      in memory; then the announcement that would have corrected the loser's grid turned out to be
      dropped by BOTH socket clients along with every other `workspace.*` event. The fourth run has
      `outcome: "both edits applied"` and ONE grid still stale - the writer was applying its own HTTP
      response as state, racing the announcement, so whichever response landed second won. The
      announcement is now the only writer. **The fifth run is what closes it, and nothing else has.**
    - **COMM-5 re-run - its recorded `PASS` is STALE**, earned before `capabilityIsLive` was added to
      its expectations, and its own row says `liveWithoutReload: false`. That `false` was the
      dropped-`workspace.*` defect sitting unread under a green verdict for fifteen hours; rule 18b in
      [testing-methodology](docs/wiki/testing-methodology.md) is what makes the next one computable,
      and every row now carries `check` + `checkSha`.
    - **COMM-7 re-run** on the deployed fix (it FAILED, the defect is fixed, a clean PASS is owed).
    - **COMM-12 re-run** (`PASS-DIRTY`) and **COMM-9/10 re-run** (`VACUOUS` since the per-salon
      groups landed). **COMM-1 has never recorded a verdict at all** - the runner exists, no run of it
      has ever completed.
    - **The phone shows a GENERIC notification body** (user, 2026-08-20, on an app that is not up to
      date). That is COMM-14's row; it is an observation, not a defect, until that runner says so.
    - **`cleanup.mjs` before the campaign** - `d6292672 | C6 COMM6-mt1gh7hx4it` is waiting, plus
      anything a crashed runner has left since. Every venue is `C<n> COMM<n>-<mark>`, deleted THROUGH
      the product so its Graine group goes with it; `--dry` to look first.
    **A verdict now names the build it ran on**, from `60c33b92` onward: nothing the web client prints
    names its build, so `results.mjs` reads `/_app/version.json` off the deployment and resolves the
    stamp to the newest commit on `origin/main` at or before it. It THROWS rather than degrade - a
    check that cannot date its build produces a verdict nobody can attribute.
4. **THEN, and only then:** recreate the venue clean, rebuild the Android APK once, run the
    campaign. **Everything must end green, so every phase runs.** What it costs, the ladder's order
    and the two decisions it turns on are on
    [cross-client-testing](docs/wiki/cross-client-testing.md), the only copy of any of it.

**OWED TO THE USER, NOT TO THE CODE: the MLS + Graine explanation.** Its audience was the blocking
question and the user settled it 2026-08-20 - **for THEM**, prose and diagrams, no code. Post-campaign;
scope, contents and the two audiences declined are on [backlog](docs/wiki/backlog.md).

**THE SIX THAT CANNOT BE PULLED FORWARD** - none is waiting on us, and each carries its blocking
condition in [backlog](docs/wiki/backlog.md), which is the only copy: the
`libcrux-chacha20poly1305` panic (needs a stable `openmls_rust_crypto 0.6.0`), the iOS avatar-cache
question (needs an iPhone), the Lydia flip WP-LYDIA-1 (needs credentials Lydia owes), one MLS client
in a SharedWorker, and `dev.canari-emse.fr` plus the SECOND campaign (both post-campaign by the
user's decision). **The sixth is owed to the user, not to the code:** is a MiGallery application
worth building? The Canari formula transfers, so the cost is knowable - what an app adds over a
gallery a browser already renders well is the part only the user can answer.

### CANARI - what is open

**Release status:** v0.14.0 cut 2026-08-17; prod VERIFIED answering
`{"version":"0.14.0","minClientVersion":"0.14.0"}`. `minClientVersion` lives in `platform_config`
and was raised by hand from `/admin/platform`, so no deploy touches it - and **the App Store half
was never verified, so that raise locks out any iOS user it has not reached**
([legacy-compatibility](docs/wiki/legacy-compatibility.md) carries the shipping order it violated).

### CANARI - the test campaign

Three files, three jobs, no overlap: **[cross-client-testing](docs/wiki/cross-client-testing.md)** is
the board (state only - every check, its verdict, the commit it ran on);
**[cross-client-campaign](docs/wiki/cross-client-campaign.md)** is the design (the ladder, the scope,
the standing rules, the preflight, the negative rows, the debris cleanup);
**[testing-methodology](docs/wiki/testing-methodology.md)** is how a result earns belief (twenty-two
rules distilled from harness faults); **[`tools/cross-client-harness/README.md`](tools/cross-client-harness/README.md)**
is the operating manual. **Read them rather than re-deriving the state here, and keep no second
copy.**

**The rig lives in the repo at `tools/cross-client-harness/`; its STATE lives outside at
`../canari-harness`** - `test-accounts.json`, the debug APK, A1's baseline, `results.ndjson`, and
`chrome-w1` / `chrome-w2`, which ARE the W1 and W2 devices. Losing a profile costs a re-enrolment and
SETUP-4's 2FA, the one step no tool here can answer. Outside the work tree a credential CANNOT be
committed and `git clean -xdf` cannot reach a profile.

**THE CAMPAIGN IS PAUSED ON PURPOSE UNTIL EVERY WORK PACKAGE IS CLOSED** - the user's decision of
2026-08-16: *"On peut faire tous les WP en attente avant de relancer la campagne de test. Je veux une
campagne clean, et s'il est necessaire de realiser l'integralite des WP de claude.md, du backlog et
tout le reste pour ca, faisons le."* A MUT x5 was stopped mid-run at 45/105 for this reason: every
fix below redeploys prod, and a run straddling a deploy has to be re-attributed. **Nothing measured
before the last WP lands is a campaign result.** The one thing the stopped run left worth keeping:
MUT-20 is unarmable until a campaign message reaches 90 days (earliest 2026-11-09).

**Owed once the WPs are closed:** `recon.mjs` on both pairs (`--rightUrl tauri.localhost` for the
phone), then MUT, TYPE, READ and FWD several clean passes on the final build, then the phases that
have never run. **A1's APK predates the current bundle** - `frontendDist` is `../build`, so the phone
serves what is inside its APK and a deploy never reaches it. That is a real mixed-fleet state, not an
oversight; say which branch each A1 row read.

**Prod IS the test server** and commit+push are authorised so it picks changes up.
`dev.canari-emse.fr` is a proxied CNAME to the same tunnel, NOT a second environment. **Decided
2026-08-17: it BECOMES a real second environment, after the campaign** - the user wants the trials
off prod. Scope it in [backlog](docs/wiki/backlog.md); do not start it before the queue is empty.

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement. His commits are usually style/UI and land in files the campaign measures, so each owes a
WEB and a MOBILE pass logged next to our own checks
([cross-client-campaign](docs/wiki/cross-client-campaign.md)).

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.

