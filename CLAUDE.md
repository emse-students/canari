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
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` and `ssh miconnect` (the last two via ProxyJump canari). **Use the PowerShell tool, never Bash** - Git Bash strips the backslashes out of the cloudflared ProxyCommand. Postgres, the fact that `auth_db` is the ONLY database and the SQL quoting are in [databases](docs/wiki/infrastructure/databases.md#reaching-it-from-a-workstation); `miconnect` is the Authentik box, and its access log is what settles an OIDC question ([authentik](docs/wiki/infrastructure/authentik.md#the-box-and-the-log-that-settles-an-oidc-question)).

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

**Five repos**, all on `main`. **Canari** (this monorepo, `emse-students/canari`, **PUBLIC**) is the
only active one; **Sky** (`../Sky`), **MiGallery** (`../MiGallery`), **Portail-etu**
(`../refonte-portail-etu`, **PUBLIC**) and **Le Cercle** (`../le-cercle`) are COMPLETE. How each is
REACHED and what its box refuses - Portail-etu having no SSH at all - is on
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md#how-each-repository-is-reached-and-what-its-box-refuses).

Work is tracked as Work Packages by severity: **P1** (security, or a broken user-facing path), **P2**
(correctness), **P3** (hygiene). Delete a WP outright once it ships - from HERE and from
[backlog](docs/wiki/backlog.md) both. Since 2026-08-18 nothing is parked: anything new goes into the
queue below in its place, and its substance into `backlog`.

**THE CAMPAIGN IS PAUSED 2026-08-30 FOR WANT OF A PHONE** (user). What is takeable without hardware
is in the queue below; everything the device owes is queue item 5.

**RESUMING, in this order and nothing else first:** `git fetch` then **PUSH** (a push redeploys prod,
so it cannot happen during a run - background, redirect not pipe, read `PUSH_EXIT`, `rm -rf apps/*/dist`
first); `gh run list`, CD green and QUIET before any row; `node state.mjs`; then `node rows.mjs`. If
the phone was unplugged, the from-zero sequence is scripted end to end in
[the harness README](tools/cross-client-harness/README.md#operating-it).

**HEAL is the rung in hand, and every verdict is on the BOARD, every adjudication on the CAMPAIGN
PAGE.** Two instrument facts that are NOT per-row: the disposition for expected noise is
`ignoringExpectedLog` **per row**, never a wider classifier, and the device cap is **re-measured
around every run** rather than quoted. **THE USER ASKED FOR THE LOGS TO BE READ ON EVERY PASS, the
reconciliations especially** (2026-08-28) - a heal that works is not a heal that was observed, and
reading them has since found one P1 no row asks about and turned a `FAIL` into another.

### CANARI - THE QUEUE, IN ORDER

Everything actionable is HERE, one line each; the detail lives where the link says and **is not
restated**. An item is done when its code, its tests, its doc and its commit are in, and it is then
deleted from BOTH this file and [backlog](docs/wiki/backlog.md). **Every defect story is in
`CHANGELOG.md`, every rule one left is in [durable-rules](docs/wiki/durable-rules.md), every verdict
is on [cross-client-testing](docs/wiki/cross-client-testing.md).**

1. **THE CAMPAIGN - PAUSED for want of a phone.** Which six rungs are the target, what a
   `PASS-DIRTY` does and does not stop, and the ORDER everything is owed in once a device exists are
   [standing rules on the campaign page](docs/wiki/cross-client-campaign.md#standing-rules-for-every-check),
   decided with the user and not to be re-litigated here. **Where it stands is on the
   [board](docs/wiki/cross-client-testing.md), which `node rows.mjs` checks against the ledger - read
   it rather than any count written here, which has been stale twice, and read the three verdicts
   the board itself marks as NOT settled (DEL-10, COMM-8, COMM-23) before believing them.**

2. **A PLACEHOLDER HELD A MEMBER'S PLACE IN A REAL CONVERSATION - the user's lost messages and the
   ghost are ONE P1. THE SERVER ESTATE IS GONE** (cleaned by hand on the owner's go-ahead,
   2026-08-30; counts, the frames read before deletion and why the allowlist was safe are on
   [chat-delivery](docs/wiki/services/chat-delivery.md#the-placeholder-that-took-a-conversations-first-seat-cleaned-by-hand-2026-08-30)).
   **WHAT STAYS OPEN IS NOT A DATABASE QUESTION** - whether a LEAF is left in the MLS tree, and
   whether the guards really fixed the activation - and only a MEMBER'S CLIENT can answer either:
   [backlog P1](docs/wiki/backlog.md#p1---the-placeholder-is-gone-from-prod-what-it-may-have-left-in-the-mls-tree-is-not-answered).

3. **THE DEPENDENCY CHAIN** (user, 2026-08-31: *"pour avoir un projet qui peut 'vivre tout seul'"*),
   which started from ONE P1: every Stripe webhook rejected for four days. What SHIPPED is in
   `CHANGELOG.md`; how the ceiling, the two triggers, the staleness gate and the CD dispatch fit
   together - and the proof that the whole chain ran unattended on 2026-08-31 - are on
   [cicd](docs/wiki/cicd.md#dependency-updates-and-the-auto-merge-that-ships-them). **What is OPEN is
   the remaining rows of [the ceiling
   table](docs/wiki/backlog.md#p1---the-three-refusals-the-auto-merge-ceiling-makes-and-the-test-that-retires-each)**,
   each naming the test that retires it - closing one makes a whole CLASS of update merge by itself.
   **The four repositories now all carry the ceiling, the sweep and the dispatch** (2026-08-31);
   what is NOT proven is that the hourly sweep FIRES - `event=schedule` has returned zero runs
   anywhere, and one `gh api` call settles it ([backlog](docs/wiki/backlog.md)).

4. **NOTHING ON THE CAMPAIGN BOARD COULD HAVE CAUGHT IT, AND THE GAP IS STRUCTURAL** (2026-08-28):
   no row asks a question whose answer is a POPULATION rather than an event. **Four rows are written
   into rung 12 MULTI** (7-10), all needing only `W1 W2`, on the board; why each exists is on
   [the campaign page](docs/wiki/cross-client-campaign.md).

5. **BLOCKED ON HARDWARE - everything the phone owes.** No device is available (user, 2026-08-30).
   The list, each row with what would arm it, is [the verification table at the top of
   backlog](docs/wiki/backlog.md#owed-a-verification-and-nothing-else); procedures are on
   [device-verification](docs/wiki/device-verification.md), state on the board, and the rig's own
   facts in [the harness README](tools/cross-client-harness/README.md). **The one thing to carry
   here: a precondition is NOT ambient** - the quick-reply window must be ARMED, and an unarmed run
   proves nothing at all.

6. **DEFERRED PAST THE LADDER - six UX and rendering items**, substance in
   [backlog](docs/wiki/backlog.md) and nowhere else, named here only so none is forgotten: the POSTS
   search that loads the whole base; the EMOJI picker that neither scrolls nor stays on screen;
   HEAL's partially-restored old client; **ONE BUNDLED EMOJI FONT everywhere** (Noto Color Emoji,
   decided 2026-08-23, owing ELEVEN rows to the SECOND campaign); the dead row a deleted group leaves
   every other member; a device row's trash and pencil not reading as the same kind of control. The
   emoji, the dead row, the device controls and the iOS bars want ONE pass over `app.css`.

7. **THE SFU RUNS SIX webrtc MAJORS NOBODY HAS PLACED A CALL ON.** It compiles, clippy is clean and
   its ten tests pass - none of which runs the ICE stack. What settles it is ONE relay-path call,
   rung 15 CALL, which has no runner. **A release must not carry this unplaced.**

8. **ONE NAMED STARTING POINT FOR EVERY PHASE, STEP AND STEP GROUP** (user, 2026-08-25: *"le meme
   point de depart, independamment de ce qui a pu se passer avant"*). The PHASE half is `run.mjs`'s
   preflight; the per-STEP half is pulled forward the moment a rung is blocked by an inherited state,
   as HEAL-REVOKE was. Contract and audit in [backlog](docs/wiki/backlog.md).

### CANARI - THE ECOSYSTEM CHANTIER (migration CLOSED in all five repos 2026-08-27)

The user's standing mandate, verbatim: *"Je veux de l'homogeneite et les meilleurs standards de
partout. Partout. oxlint/oxfmt ect partout, TS7 partout ou c'est possible..., Lucide derniere version
avec tous les composants stale corriges PARTOUT, bun a la place de npm PARTOUT etc."*

**Every decision, measurement, guardrail and per-repo state is on
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md), the ONLY copy - add to its tables rather
than re-deriving anything here, which is what made this section wrong twice.** Section 8 is the
package manager, 9 is TS 7, 10 is bun 1.4 and the lockfile-v1 invariant, 11 is the repo-by-repo
state and the second sweep's eleven gaps. Its "NOT TO BE RELITIGATED" paragraphs exist so a later
session cannot "finish" the work by undoing a measurement.

**What is left is JUDGEMENT, not migration** - MiGallery's lint warnings, the `resolve()` question
three repos park differently, Tailwind class sorting on Portail-etu - plus one parked P2, **NestJS
11 -> 12** across four deployed services ([backlog](docs/wiki/backlog.md#tooling)). Exactly ONE
Dependabot alert is open. The first question about any advisory is whether `cargo tree -i` reaches
the crate at all, because `cargo audit` reads the LOCKFILE - which is how the last one was closed as
UNREACHABLE rather than fixed.

**SIX THINGS CANNOT BE PULLED FORWARD**, each carrying its blocking condition in
[backlog](docs/wiki/backlog.md), the only copy: the MLS + Graine explanation owed to the USER, not to
the code (prose and diagrams, no code, user 2026-08-20); the iOS avatar-cache question; WP-LYDIA-1,
waiting on credentials Lydia owes; one MLS client in a SharedWorker; `dev.canari-emse.fr` and the
SECOND campaign; and - owed to the user - is a MiGallery application worth building?

### CANARI - what is open

**Release: the shipped version is `0.14.14`.** Whether Play has picked a build up is a MEASUREMENT
(`node tools/play-vitals/vitals.mjs`) and what CI did is `gh run list`; never infer either from a
line here, which has been stale twice. **No HEAL-REVOKE verdict about a clean device may be taken on
a build older than 0.14.12** (.10 and .11 MEASURE the wipe defects rather than fixing them). **An APK
is not reached by a deploy** - `frontendDist: "../build"` means the Tauri app EMBEDS the frontend, so
`minClientVersion` and check S reason about a NAME unless a version identifies its content
([harness README](tools/cross-client-harness/README.md)).

**APP REVIEW REJECTED 0.14.4 ON 2026-08-30 ON TWO GUIDELINES; ONE IS ANSWERED** (the territory, by
the user, 2026-08-31). **What is left is 2.1(a)**, fixed in the tree and owing an iOS build plus ONE
iPhone login. What it waits on, and Play's own thresholds, are on
[mobile](docs/wiki/frontend/mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on);
how the vitals are read, why every RATE is EMPTY rather than green, and what an acknowledgement is
are in [the tool's README](tools/play-vitals/README.md). Only **check R** is left of the two mails of
2026-08-26, and **WP-RESTORE-1** (Zero-Tap Sign-In, April 2027) is ACCEPTED, after the campaign.

**iOS: two things are PROVEN and must not be re-verified** - the session HOLDS on the iPhone, and a
full parity audit read everything else as symmetric. Four things are open, all in
[backlog](docs/wiki/backlog.md): a second iPhone on the same build acquiring no push token and
reporting nothing (**diagnosing it needs no phone**); the top and bottom bars, which want queue item
6's `app.css` pass; `minClientVersion`, raised BY HAND and only after a build is shown reaching an
ORDINARY user, TestFlight being the beta channel; and macOS/Linux desktop cookie behaviour, never
measured, which is exactly what `X-Canari-Refresh` covers. **THREE OF THREE iOS DEFECTS WERE
INVISIBLE TO EVERY GATE HERE**, so the classes the user named close by HARDWARE, one lettered check
at a time - **never by a fix written against a suspected lifecycle bug nobody has seen**, because
nothing here could tell whether it worked.

### CANARI - the test campaign

Four files, four jobs, all in WHERE THINGS LIVE above: board = state, campaign page = design,
methodology = how a result earns belief, README = operating manual. **Read them rather than
re-deriving state here, and keep no second copy** - the rig at `tools/cross-client-harness/`, its
STATE outside the work tree at `../canari-harness` (where a credential cannot be committed and
`git clean -xdf` cannot reach a profile), `rows.mjs`, `debris.mjs`, MUT-20, TAB-7, and why prod IS
the test server while `dev.canari-emse.fr` is not a second environment all live on those four pages.

**Three facts govern every session that touches the rig.** `node rows.mjs` SETTLES whether the board
matches the ledger - run it before believing a cell; it has caught the board wrong three times. **A
campaign run and a push to `main` are MUTUALLY EXCLUSIVE**, a mid-run deploy having already voided
three cells, and a killed run can destroy a measurement seconds from being recorded. And **losing a
`chrome-w1` / `chrome-w2` profile costs a re-enrolment and SETUP-4's 2FA**, the one step no tool
here can answer.

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.

**AND ON DEPENDENCIES, 2026-08-31, WHICH DECIDES THE SHAPE OF EVERY GATE:** *"Je prefere blinder de
test et faire les choses automatiquement qu'avoir une review humaine qui n'arrive jamais"*, and
*"pour avoir un projet qui peut 'vivre tout seul'"*. **So a refusal in `dependabot-auto-merge.yml` is
NEVER a routing decision to a human queue - it is a statement that a gate is MISSING, and it must
NAME the test that would lift it.** A queue nobody drains is worse than the merge it prevented.
