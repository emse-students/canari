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
| Picking the campaign back up: the delta since the pause, and the restart order | [cross-client-campaign-resume.md](docs/wiki/cross-client-campaign-resume.md) |
| What a prompt handing ONE row to another session must carry | [cross-client-campaign.md](docs/wiki/cross-client-campaign.md#a-row-handed-to-another-session---the-delegation-contract) |
| Why a result may be believed | [docs/wiki/testing-methodology.md](docs/wiki/testing-methodology.md) |
| What the app has that NOTHING watches | [docs/wiki/mechanism-audit.md](docs/wiki/mechanism-audit.md) |
| How to operate the test rig | [tools/cross-client-harness/README.md](tools/cross-client-harness/README.md) |
| What Google Play sees that no gate here does | [tools/play-vitals/README.md](tools/play-vitals/README.md) |
| What is owed on real hardware | [docs/wiki/device-verification.md](docs/wiki/device-verification.md) |
| Secrets, services, bootstrap steps | `infrastructure/MIGRATION.md` |
| The second estate: isolation, the prod copy, the declared version gap | [dev-environment.md](docs/wiki/infrastructure/dev-environment.md) |
| Whether the BOXES take their security updates, and what reports it | [host-updates.md](docs/wiki/infrastructure/host-updates.md) |
| What the USER must do by hand, and the long-term dev/release workflow (French) | [workflow-developpement.md](docs/user-guide/workflow-developpement.md) |
| A shim kept alive for old clients, and its removal date | [docs/wiki/legacy-compatibility.md](docs/wiki/legacy-compatibility.md) |
| What a report is, and what a block does and does not close | [docs/wiki/moderation-and-blocking.md](docs/wiki/moderation-and-blocking.md) |
| The cross-repo convergence plan, repo by repo | [ecosystem-convergence.md](docs/wiki/ecosystem-convergence.md#11-the-cross-repo-convergence-plan-repo-by-repo) |
| The 2026-09-02 workflow migration: its decisions, its order, its state | [workflow-migration.md](docs/wiki/workflow-migration.md) |

## **AGENT DIRECTIVES**

- NO BLIND GREP: never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: state assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- SURGICAL EDITS: touch ONLY requested code. Map changes 1:1 to the prompt.
- **WORK GOES THROUGH A PULL REQUEST, on a branch off `main` - since 2026-09-03, and this replaces "commit directly".** `main` carries a ruleset (id `22152902`, active): no direct push, no force-push, no delete, and one required check, `CI passed`. The loop is `git switch -c`, commit, `gh pr create`, let CI answer, `gh pr merge --squash --delete-branch`. **No approval is required** - a queue nobody drains is worse than the merge it prevented (user, 2026-08-31) - so this costs a minute and buys two things a direct push never gave: a diff somebody can read, and a CI run on the MERGED combination rather than on the branch. **Admin bypass exists and is the EMERGENCY path only**: taking it means production is broken right now, and it is written down in `CHANGELOG.md` when taken.
- **NOTHING DEPLOYS ON A PUSH - deployment happens at the BUMP** (user, 2026-09-02: *"le deploiement de tout (production, android, ios...) se fait au bump. Pas au push sur main."*). A STABLE release `vX.Y.Z` deploys production and ships the stores; a PRE-RELEASE `vX.Y.Z-alpha.N` deploys `dev.canari-emse.fr` and feeds the store TESTER programmes; a merge to `main` deploys nothing at all and only runs CI. **So a merged fix is not a shipped fix**, and `frontend/package.json`'s version is what decides which kind a release is - a hyphen in it IS the definition of a pre-release, read that way by `cd.yml`'s `release-kind` job and by `scripts/bump-app-version.sh`. The whole model is on [workflow-migration](docs/wiki/workflow-migration.md) and [cicd](docs/wiki/cicd.md), the only copies.
- NO FALLBACKS: never add a fallback path. Diagnose why the primary path failed and fix it there.
- FIX, NEVER DEFER: a warning or failure you meet is yours, whether or not you caused it. "Pre-existing" is not a disposition.
- FACE THE BLOCKAGE: fix the cause of a failing hook (`bun run format`), never stash or bypass it.
- STATE PRUNING: when updating SESSION STATE, DELETE completed work outright. Its rule goes to `durable-rules`, its story to `CHANGELOG.md`, its mechanism to the wiki page that entry points at. **Do not reconstruct shipped work here.**
- CLAUDE.md HYGIENE: capped at ~250 lines on purpose, and it is an INDEX first. A rule needing a paragraph belongs in `durable-rules`; a story in `CHANGELOG.md`; a measurement on the topical wiki page. If this file grows, something belongs somewhere else.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> commit -> pull request -> merge -> update SESSION STATE -> STOP.
- COMMIT **AND PUSH** IN THE BACKGROUND, ALWAYS - both are minutes long and neither is worth a blocked session. The pre-commit hook sweeps the WHOLE frontend (2-3 min) and re-stages it; a push to this remote routinely exceeds a 5-min foreground timeout. Isolate unrelated dirty files first. `rm -rf apps/*/dist` before `git push`.
- DOCUMENTATION: technical docs in `docs/wiki/` (English, LLM-oriented, **search it before reading source**). User guides in `docs/user-guide/` (French). UML in `docs/diagrams/`. Root: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- WIKI IS PREFERRED: update the relevant wiki page alongside code changes - stale wiki is worse than none. Keep `apps/*/README.md` synced with its wiki counterpart. Cross-link freely.
- CHANGELOG: features, fixes and breaking changes get an entry under `[Unreleased]` (Keep a Changelog format).
- ONE-OFF ACTIONS GO TO THE USER (2026-08-25): *"Pour les choses qui ne se font qu'une fois, tu peux me demander de les faire hein."* Building a tool for a single click is that waste.
- DELEGATION: broad file-gathering goes to a search subagent; a big, risky or native Work Package goes to a background agent through a precise brief in `AGENTS.md`.
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` and `ssh miconnect` (the last two via ProxyJump canari). **Either tool works since 2026-09-02, and the old "PowerShell only" rule named the wrong culprit.** It was never Bash: MSYS `ssh` execs the cloudflared `ProxyCommand` through `/bin/bash`, which ate its backslashes. `~/.ssh/config` now spells that path with FORWARD SLASHES, which `bash` and `cmd` both exec - measured on both. A bash script may therefore reach prod directly, which matters because **PowerShell text-encodes stdout and corrupts a binary pipe** (a `pg_dump | gzip` through it is lost). Postgres, the fact that `auth_db` is the ONLY database and the SQL quoting are in [databases](docs/wiki/infrastructure/databases.md#reaching-it-from-a-workstation); `miconnect` is the Authentik box, and its access log is what settles an OIDC question ([authentik](docs/wiki/infrastructure/authentik.md#the-box-and-the-log-that-settles-an-oidc-question)).

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
(correctness), **P3** (hygiene). Nothing is parked since 2026-08-18: anything new goes into the queue
below, its substance into [backlog](docs/wiki/backlog.md), and BOTH copies are deleted the day it
ships. **What only the USER can do is ONE table** -
[backlog](docs/wiki/backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks), pointers
only; never re-enumerate it here.

### CANARI - THE WORKFLOW MIGRATION IS THE ACTIVE WORK (2026-09-02)

The user cancelled the two-branch model the same day it landed. **`main` is the only branch,
production deploys at the BUMP and never at a push, work goes through pull requests, development and
the whole test campaign move LOCAL, and `-alpha.N` pre-releases feed the store tester programmes.**
Everything about it - the verbatim mandate, the twelve decisions that must not be relitigated, the
measurements already taken, the single emergency path and the ordered checklist - is on
[workflow-migration](docs/wiki/workflow-migration.md), the ONLY copy. **Read it before touching any
workflow, hook, `.env` or campaign page**, and tick its boxes as the work lands.

**WP-0 THROUGH WP-4 ARE DONE (2026-09-03), AND THE FLOW NOW GOVERNS ITSELF.** A push to `main`
deploys nothing; production and the dev estate are reached only by publishing a release, stable or
`-alpha.N`; the whole local estate authenticates; `origin/dev` is deleted and the ruleset on `main`
is active. **Everything from here goes through a pull request**, this chantier included - the
exemption that let it commit directly existed only until it had built the thing that forbids it.

**WP-6 IS DONE TOO (2026-09-03)**: the whole wiki, both READMEs, `MIGRATION.md`, the three campaign
pages, `CHANGELOG.md` and the French user guide - which was rewritten whole rather than edited -
now describe deploy-at-bump instead of the push model. **The one correction to carry: "a campaign
run and a push to `main` are mutually exclusive" now names a RELEASE**, in all four places it
appears; it becomes deletable only when WP-5 moves the rig LOCAL.

**WP-5 IS DONE EXCEPT FOR WHAT ONLY THE USER CAN DO (2026-09-03).** The board is reset and
archived, the campaign pages and the rig wiring target LOCAL, and both standing rules are retired.
**Three things are left, and none of them is a repository change:**

- **The test ACCOUNTS.** Local authenticates against the PRODUCTION Authentik (decision 8, no local
  IdP), so "fresh test accounts" is a write to the identity provider. Everything downstream waits on
  it: the rig root's `names.mjs` is deliberately NOT created with placeholder display names, a name
  that looks real and matches nothing being the precise failure that file exists to prevent, and the
  Chrome profiles ARE enrolments of those accounts.
- **Publishing `0.15.0-alpha.1`** - a release only the USER performs, and the first real passage of
  the whole deploy-at-bump chain.
- **The iOS build number** - needs a macOS run to say whether `tauri ios build` clobbers
  `CFBundleVersion`. If it does, the second alpha of a version is refused by TestFlight.

### CANARI - THE QUEUE, IN ORDER

Everything actionable is HERE, one line each; the detail lives where the link says and **is not
restated**. **Every defect story is in `CHANGELOG.md`, every rule one left is in
[durable-rules](docs/wiki/durable-rules.md), every verdict is on
[cross-client-testing](docs/wiki/cross-client-testing.md).**

1. **THE CAMPAIGN DOES NOT RESUME, IT RESTARTS FROM ZERO** (2026-09-03, WP-5). It was paused
   2026-08-30 for want of a phone; since then the RIG was lost (this machine was reconstituted from
   a bundle collected without `-WithRig`, so both Chrome profiles, `results.ndjson` and the phone
   baseline are gone), the TARGET moved to the LOCAL estate, and nothing deploys at a push any
   more. **The board is reset to zero** and the old one archived at
   [cross-client-testing-archive](docs/wiki/cross-client-testing-archive.md) - read it when a
   re-run disagrees with itself, never as a gate, because a verdict whose run cannot be read is a
   claim with nothing behind it. **The mutual-exclusion rule is RETIRED**; what replaced it is a
   `bun run dev` reload, which does the same damage on a SAVE and has no run to watch. The six
   target rungs and what a `PASS-DIRTY` does and does not stop are
   [standing rules](docs/wiki/cross-client-campaign.md#standing-rules-for-every-check), decided with
   the user and not re-litigated; the restart order and what LOCAL costs a verdict are
   [cross-client-campaign-resume](docs/wiki/cross-client-campaign-resume.md), the only copy.
   **BLOCKED ON THE USER, and on one thing only: the test ACCOUNTS.** Local authenticates against
   the PRODUCTION Authentik by decision 8, so creating them is a write to the identity provider -
   the attempt of 2026-09-02 was refused for that reason and the refusal was right.

2. **A PLACEHOLDER HELD A MEMBER'S PLACE IN A REAL CONVERSATION - the user's lost messages and the
   ghost are ONE P1. THE SERVER ESTATE IS GONE**, cleaned by hand on the owner's go-ahead 2026-08-30
   ([chat-delivery](docs/wiki/services/chat-delivery.md#the-placeholder-that-took-a-conversations-first-seat-cleaned-by-hand-2026-08-30)).
   **WHAT STAYS OPEN IS NOT A DATABASE QUESTION** - whether a LEAF is left in the MLS tree, and
   whether the guards really fixed the activation - and only a MEMBER'S CLIENT can answer either:
   [backlog P1](docs/wiki/backlog.md#p1---the-placeholder-is-gone-from-prod-what-it-may-have-left-in-the-mls-tree-is-not-answered).

3. **THE DEPENDENCY CHAIN** (user, 2026-08-31: *"pour avoir un projet qui peut 'vivre tout seul'"*),
   started from ONE P1: every Stripe webhook rejected for four days. The ceiling, the sweep, the
   dispatch, the outage of 2026-09-01 and Dependabot's TWO switches are all on
   [cicd](docs/wiki/cicd.md#dependency-updates-and-the-auto-merge-that-ships-them), the only copy.
   **SIX THINGS OPEN, each in [backlog](docs/wiki/backlog.md) and nowhere else:** **[nine of the ten
   backend pull-request slots are held by updates that can never go green, and the group written to
   prevent exactly that has never opened a pull request](docs/wiki/backlog.md#p1---nine-of-the-ten-backend-pull-request-slots-are-held-by-updates-that-can-never-go-green-and-the-group-written-to-prevent-exactly-that-has-never-opened-a-pull-request-measured-2026-09-03)** -
   the four NestJS services share a limit of 10, nine are single-package NestJS 12 bumps each
   incoherent ALONE (45 suites die at import), the `nestjs` group landed after they were open and so
   has never produced a pull request, and closing them is the fix but its suppression semantics must
   be measured on ONE first, resolving no sooner than Monday 2026-09-07; **[two of the six
   cargo directories are invisible to Dependabot](docs/wiki/backlog.md#p1---two-of-the-six-cargo-directories-are-invisible-to-dependabot-and-one-of-them-is-the-app-that-ships-to-phones-measured-2026-09-02)** - the app that
   ships to phones among them, silent for 25 days, its silence now closed by a derived test and its
   fix a decision owed to the USER; the remaining rows
   of [the ceiling table](docs/wiki/backlog.md#p1---the-three-refusals-the-auto-merge-ceiling-makes-and-the-test-that-retires-each),
   each naming the test that retires it - closing one makes a whole CLASS of update merge by itself;
   [the one rebuild no `GITHUB_TOKEN` may perform](docs/wiki/backlog.md#p2---the-one-rebuild-the-auto-merge-cannot-perform-and-the-credential-that-would-let-it);
   [PG 15 -> 18, a MIGRATION parked deliberately](docs/wiki/backlog.md#p2---postgresql-is-held-at-15-because-18-needs-a-migration-nobody-has-performed-after-the-outage-of-2026-09-01)
   (user, *"on verra ca plus tard"*), whose test also releases `redis` and `garage`; and **[nothing
   tells anybody prod is down](docs/wiki/backlog.md#p2---nothing-tells-anybody-production-is-down-and-both-outages-of-2026-09-01-were-reported-by-the-user-owed-to-the-user-a-decision-then-one-click)** -
   both outages of 2026-09-01 were reported by the USER, a red CD run pages nobody, and the frontend
   answered 200 throughout, so a probe must hit `/api/version`, which needs the database. **THE CHAIN NOW REACHES THE HOSTS
   (2026-09-03)** - all four take their security updates unattended, nothing reboots, and a daily
   workflow run fails on any finding. Everything about it, including the 30-second `502` the
   security-only scope does NOT incur and the evidence for that, is
   [host-updates](docs/wiki/infrastructure/host-updates.md), the only copy. **Three smaller things
   stay open**, in [backlog](docs/wiki/backlog.md) and nowhere else: the report covers PRODUCTION
   only, the runner's key being authorised on none of the other three hosts; `mitv` has needed a
   reboot since 12 July for a KERNEL update, with 8 weeks of uptime; and a library security fix is
   installed rather than in EFFECT, nothing restarting the processes that map it. The three tunnel
   hosts are uniform and current as of 2026-09-02
   ([cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md#the-daemon-on-the-origin-and-the-token-it-carries)).

4. **NOTHING ON THE CAMPAIGN BOARD COULD HAVE CAUGHT IT, AND THE GAP IS STRUCTURAL** (2026-08-28):
   no row asks a question whose answer is a POPULATION rather than an event. **Four rows are written
   into rung 12 MULTI** (7-10), all needing only `W1 W2`; why each exists is on
   [the campaign page](docs/wiki/cross-client-campaign.md).

5. **BLOCKED ON HARDWARE - everything the phone owes** (user, 2026-08-30). The list, each row with
   what would arm it, is [the verification table](docs/wiki/backlog.md#owed-a-verification-and-nothing-else);
   procedures on [device-verification](docs/wiki/device-verification.md), state on the board, and the
   rig's own facts in [the harness README](tools/cross-client-harness/README.md). **The one thing to
   carry here: a precondition is NOT ambient** - the quick-reply window must be ARMED, and an unarmed
   run proves nothing at all.

6. **DEFERRED PAST THE LADDER - six UX and rendering items**, substance in
   [backlog](docs/wiki/backlog.md) and nowhere else, named here only so none is forgotten: the POSTS
   search that loads the whole base; the EMOJI picker that neither scrolls nor stays on screen;
   HEAL's partially-restored old client; **ONE BUNDLED EMOJI FONT everywhere** (Noto Color Emoji,
   decided 2026-08-23, owing ELEVEN rows to the SECOND campaign); the dead row a deleted group leaves
   every other member; a device row's trash and pencil not reading as the same kind of control. Four
   of the six want ONE pass over `app.css`. **Two DEV-LOG lines join them from 2026-09-03**, both in
   [backlog](docs/wiki/backlog.md) under Tooling: the root `load`'s `window.fetch` warning, whose
   prescribed fix buys nothing while `ssr = false`, and a WebSocket 1006 that cannot say whether it
   is the page unload or a real drop.

7. **CALLING IS HELD OFF SINCE 0.14.15 - `CALLS_ENABLED = false`** (user, 2026-09-01: not a
   priority, never properly tested). The SFU's six webrtc majors are unplaced and rung 15 CALL has no
   runner; what changed is that a release no longer carries the surface unplaced. FIVE switches move
   in ONE commit at revival (two are store declarations that cut both ways) - the table is on
   [calls](docs/wiki/frontend/modules/calls.md), the condition and the TURN measurement in
   [backlog](docs/wiki/backlog.md). **Prod HAS TURN configured and has never used it.**

8. **ONE NAMED STARTING POINT FOR EVERY PHASE, STEP AND STEP GROUP** (user, 2026-08-25: *"le meme
   point de depart, independamment de ce qui a pu se passer avant"*). The PHASE half is `run.mjs`'s
   preflight; the per-STEP half is pulled forward the moment a rung is blocked by an inherited state,
   as HEAL-REVOKE was. Contract and audit in [backlog](docs/wiki/backlog.md).

9. **A DEVICE ASKS FOR A WELCOME FOR EVER AND THE MEMBER ANSWERING RESETS THE ROW THAT WOULD HAVE
   HEALED IT - P1, AND THE NEXT THING TAKEN** (user, 2026-09-01). It asked every 60 s for 20 HOURS
   while the member answering `[KICK]`ed it back to `pending`, the one status that forbids the
   self-service external join: **a livelock, each side re-creating the other's precondition.** Proved
   on prod by flipping three rows - 2 of 3 healed by external commit in 90 s with no peer at all.
   Four defects, the evidence and the state LEFT on prod (`4f87267a` still `pending`, its base stale
   at 283/284) are in
   [backlog](docs/wiki/backlog.md#p1---a-device-asks-for-a-welcome-for-ever-and-the-member-that-answers-resets-the-row-that-would-have-let-it-heal-itself-measured-on-prod-2026-09-01),
   the only copy. Its sibling P2 - the hourly report NAMES a stranded device and still cannot say why
   its KeyPackage was skipped, `addMembersBulk` discarding the reason with the id - is
   [there too](docs/wiki/backlog.md#p2---a-device-was-given-a-roster-seat-and-never-a-welcome-and-why-its-keypackage-was-skipped-is-unmeasured-measured-on-prod-2026-09-01),
   and the two want reading together. The two defects the same account exposed FIRST are fixed, their
   stories in `CHANGELOG.md` and their mechanisms on
   [chat](docs/wiki/frontend/modules/chat.md#the-conversation-row-is-the-recovery-ladders-input-so-publishing-it-early-arms-the-ladder-2026-09-01)
   and [chat-delivery](docs/wiki/services/chat-delivery.md#a-roster-seat-is-not-a-key-and-only-a-welcome-tells-the-two-apart).

10. **TWELVE OF SIXTEEN MESSAGES WERE FETCHED AND DROPPED, AND `mls_commit_log` HAS A PERMANENT HOLE
    AT EPOCH 121** (prod DM `7da231f8`, measured 2026-09-02 from a user's impression that proved
    exact). **THE FOUR DEFECTS ARE FIXED 2026-09-02** - story in `CHANGELOG.md`, rules in
    [durable-rules](docs/wiki/durable-rules.md), mechanisms on
    [mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md) (SS1, SS5, SS9) and
    [mls-recovery-ladder](docs/wiki/protocols/mls-recovery-ladder.md) step 4. **NOTHING IS DEPLOYED:
    prod still runs the defects.** What stays open is in
    [backlog](docs/wiki/backlog.md#p1---twelve-of-sixteen-messages-were-fetched-and-dropped-and-the-commit-log-has-a-permanent-hole-at-epoch-121-measured-on-prod-2026-09-02),
    the only copy, and **it reads WITH item 9** (same account; the peer's second iPhone `pending`
    since 27/08 is that P1's signature): the twelve messages, recoverable only from the peer's
    iPhone; the hole at 121, permanent by construction; **the 13:10 failure arm, NOT established** -
    reproduce with `clearLogcat()` first and do NOT write a fix against a suspected arm; the green
    "SECURISE & SYNC" shield on a conversation missing twelve messages; and two siblings - nothing
    measures a re-key rate or reports a commit-log hole, and the phone prints 8 warning lines a
    minute plus a 10 s presence poll.

11. **`dev.canari-emse.fr` IS LIVE, AND SINCE 2026-09-03 IT IS THE PRE-RELEASE TARGET.** A
    `X.X.X-alpha.N` release deploys it and feeds the store tester programmes; a stable release
    deploys production; a push deploys neither. **The `dev` BRANCH and `promote-dev-to-main` are
    gone** - what the promotion provided (an automatic proof, on a copy of production's data, that
    a commit serves before production gets it) is now something a human arms by publishing an
    alpha, and that trade is written on
    [dev-environment](docs/wiki/infrastructure/dev-environment.md) so nobody "restores" it by
    accident. Everything else about the estate is on that page, the only copy: the four
    measurements that prove it, the SEED order a virgin estate needs (deploy -> refuse -> refresh
    -> deploy, the 80 `.sql` files being deltas over a schema TypeORM owns) and the three
    corrections that must not be undone (its sections 4, 5 and 8). The decisions are in
    [backlog](docs/wiki/backlog.md#devcanari-emsefr-becomes-a-real-second-environment---decided-2026-08-17).
    **TWO THINGS STAY OPEN.** A dev deploy still cannot tell a broken CHANGE from an unreachable
    REGISTRY ([backlog](docs/wiki/backlog.md#p2---a-dev-deploy-still-cannot-tell-a-broken-change-from-an-unreachable-registry-and-the-conflation-moved-rather-than-went-away-measured-2026-09-02-first-day-it-ran));
    what changed is only what it now costs - a pre-release that silently does not land, rather than
    a release that silently does not happen. **And prod's deploy job is still its inlined shell**,
    moving onto `infrastructure/deploy/deploy-environment.sh` only once dev has exercised it: one
    implementation, proven before it is imposed.

### CANARI - THE ECOSYSTEM CHANTIER (migration CLOSED in all five repos 2026-08-27)

The user's standing mandate, verbatim: *"Je veux de l'homogeneite et les meilleurs standards de
partout. Partout. oxlint/oxfmt ect partout, TS7 partout ou c'est possible..., Lucide derniere version
avec tous les composants stale corriges PARTOUT, bun a la place de npm PARTOUT etc."*

**Every decision, measurement, guardrail and per-repo state is on
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md), the ONLY copy - add to its tables rather
than re-deriving anything here, which is what made this section wrong twice** (section 8 is the
package manager, 9 is TS 7, 10 is bun 1.4 and the lockfile-v1 invariant, 11 is the repo-by-repo state
and the second sweep's eleven gaps). Its "NOT TO BE RELITIGATED" paragraphs exist so a later session
cannot "finish" the work by undoing a measurement.

**What is left is JUDGEMENT, not migration** - MiGallery's lint warnings, the `resolve()` question
three repos park differently, Tailwind class sorting on Portail-etu. **NestJS 12 is HALF DONE and
needs nothing done to it**, the hold being an ASSERTION on the resolved tree rather than an ignore,
so it ends unattended: [nestjs-framework](docs/wiki/services/nestjs-framework.md), the only copy.

**FIVE THINGS CANNOT BE PULLED FORWARD**, each carrying its blocking condition in
[backlog](docs/wiki/backlog.md), the only copy: the MLS + Graine explanation owed to the USER, not to
the code (prose and diagrams, no code, user 2026-08-20); the iOS avatar-cache question; WP-LYDIA-1,
waiting on credentials Lydia owes; one MLS client in a SharedWorker; and the SECOND campaign.

### CANARI - release, store submission, iOS

**The shipped version is `0.14.15`.** Whether Play has picked a build up is a MEASUREMENT
(`node tools/play-vitals/vitals.mjs`, and why every RATE is EMPTY rather than green is in
[its README](tools/play-vitals/README.md)) and what CI did is `gh run list`; never infer either from
a line here, which has been stale twice. **No HEAL-REVOKE verdict about a clean device may be taken
on a build older than 0.14.12** (.10 and .11 MEASURE the wipe defects rather than fixing them). **An
APK is not reached by a deploy** - `frontendDist: "../build"` means the Tauri app EMBEDS the
frontend, so `minClientVersion` and check S reason about a NAME unless a version identifies its
content ([harness README](tools/cross-client-harness/README.md)).

**2.1(a) IS PASSED, and the two guidelines that replaced it are both answered in 0.14.15**; where
the submission stands, per half, is on
[mobile](docs/wiki/frontend/mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on).
Only **check R** is left of the two mails of 2026-08-26, and **WP-RESTORE-1** (Zero-Tap Sign-In,
April 2027) is ACCEPTED, after the campaign.

**iOS: two things are PROVEN and must not be re-verified** - the session HOLDS on the iPhone, and a
full parity audit read everything else as symmetric. Four things are open in
[backlog](docs/wiki/backlog.md), one (a second iPhone acquiring no push token and reporting nothing)
**diagnosable with no phone at all**. **THREE OF THREE iOS DEFECTS WERE INVISIBLE TO EVERY GATE
HERE**, so those classes close by HARDWARE, one lettered check at a time - **never by a fix written
against a suspected lifecycle bug nobody has seen**, because nothing here could tell whether it
worked.

### CANARI - the test campaign

Four files, four jobs, all in WHERE THINGS LIVE above: board = state, campaign page = design,
methodology = how a result earns belief, README = operating manual. **Read them rather than
re-deriving anything here, and keep no second copy.**

**Four facts govern every session that touches the rig.** `node rows.mjs` SETTLES whether the board
matches the ledger - run it before believing a cell; it has caught the board wrong three times.
**THE RIG TARGETS THE LOCAL ESTATE SINCE 2026-09-03, AND TWO STANDING RULES DIED WITH THAT MOVE.**
"A campaign run and a push to `main` are mutually exclusive" is retired, not re-pointed: a push
deploys nothing now, and a local run is not on the path of any deploy, so there is no event left to
be exclusive with - the accident that voided three cells on 2026-08-27, two of them to
DOCUMENTATION commits, cannot recur. What replaces it is smaller and belongs to the workstation: a
`bun run dev` reload under a run does the same damage, which is what `bundle.mjs` measures, and it
is more frequent and less visible than a deploy ever was. **The board is also reset to zero** (the
LITHIUM ledger was lost with the rig), archived at
[cross-client-testing-archive](docs/wiki/cross-client-testing-archive.md). What still holds: a
killed run can destroy a measurement seconds from being recorded, and **losing a `chrome-w1` /
`chrome-w2` profile costs a DEVICE**. The preconditions are on
[the resume page](docs/wiki/cross-client-campaign-resume.md) and nowhere else. **THE USER ASKED FOR
THE LOGS TO BE READ ON EVERY PASS, the reconciliations especially** (2026-08-28) - a heal that works
is not a heal that was observed, and reading them has since found one P1 no row asks about and turned
a `FAIL` into another. And two instrument facts that are NOT per-row: the disposition for expected
noise is `ignoringExpectedLog` **per row**, never a wider classifier, and the device cap is
**re-measured around every run** rather than quoted.

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.

**AND ON DEPENDENCIES, 2026-08-31, WHICH DECIDES THE SHAPE OF EVERY GATE:** *"Je prefere blinder de
test et faire les choses automatiquement qu'avoir une review humaine qui n'arrive jamais"*, and
*"pour avoir un projet qui peut 'vivre tout seul'"*. **So a refusal in `dependabot-auto-merge.yml` is
NEVER a routing decision to a human queue - it is a statement that a gate is MISSING, and it must
NAME the test that would lift it.** A queue nobody drains is worse than the merge it prevented.
