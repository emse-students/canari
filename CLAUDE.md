# **Canari - Rules & Session State**

> **The hard-won rules are in [durable-rules](docs/wiki/durable-rules.md)**, indexed by area: **open
> the section matching what you are about to touch, before you write anything.** This file keeps only
> what applies to EVERY task, plus the live session state.
>
> **THIS REPOSITORY IS THE ONLY REFERENCE, AND THIS FILE IS ITS INDEX** - anyone holding the repo and
> the secrets must be able to pick the work up with nothing else. **An agent's local memory is
> SECONDARY AND DELETABLE**: machine-local wiring and secrets only. A project fact found there is a
> bug - move it into the repo and delete the memory. Never let a decision, a measurement or an open
> item exist only in a chat history, a scratch directory or a memory file.

## **WHERE THINGS LIVE**

| Question | File |
| --- | --- |
| What is open, and what rule holds everywhere | this file |
| **Why Canari exists and what it refuses: the charter, "Nos principes" (French, ordered, validated by the owner)** | [docs/principes.md](docs/principes.md) |
| **What is planned for which version** - every open entry, generated from its `target:` line | [docs/wiki/plan.md](docs/wiki/plan.md) |
| How the plan is ordered, the dated commitments, the log of every replanning | [docs/wiki/roadmap.md](docs/wiki/roadmap.md) |
| The constraint for the area I am about to touch | [docs/wiki/durable-rules.md](docs/wiki/durable-rules.md) |
| How something works, in depth | `docs/wiki/` - **search it before reading source** ([index](docs/wiki/index.md)) |
| The substance behind an entry of the plan | one file per entry in [backlog.d/](docs/wiki/backlog.d/README.md); the rules and what the user owes in [backlog.md](docs/wiki/backlog.md) |
| A question the code cannot answer, parked deliberately | [docs/wiki/open-questions.md](docs/wiki/open-questions.md) |
| The story of a defect that shipped | `CHANGELOG.md` |
| **The `1.4.1` campaign on dev: the MLS core matrix that blocks the stable, its order and its open questions** | [cross-client-campaign-1-4-1.md](docs/wiki/cross-client-campaign-1-4-1.md) |
| The pre-`1.4.1` campaign (board, design, restart: each carries a notice, superseded for `1.4.1` by the page above): every check and verdict, the ladder, the scope, the preflight, the standing rules for a run, [what a prompt handing ONE row to another session must carry](docs/wiki/cross-client-campaign.md#a-row-handed-to-another-session---the-delegation-contract), the delta since the pause | [board](docs/wiki/cross-client-testing.md), [design](docs/wiki/cross-client-campaign.md), [resume](docs/wiki/cross-client-campaign-resume.md) |
| Why a result may be believed | [docs/wiki/testing-methodology.md](docs/wiki/testing-methodology.md) |
| What the app has that NOTHING watches | [docs/wiki/mechanism-audit.md](docs/wiki/mechanism-audit.md) |
| How to operate the test rig | [tools/cross-client-harness/README.md](tools/cross-client-harness/README.md) |
| What Google Play sees that no gate here does | [tools/play-vitals/README.md](tools/play-vitals/README.md) |
| What is owed on real hardware | [docs/wiki/device-verification.md](docs/wiki/device-verification.md) |
| Where the App Store submission stands | [mobile](docs/wiki/frontend/mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on) |
| Secrets, services, bootstrap steps | `infrastructure/MIGRATION.md` |
| Private operations notes (access routes, hosts) | outside the repo, local only: `../../canari-private-docs`, relative to the repository (never commit) |
| Store texts and screenshots, refreshed without personal data | [docs/wiki/store-listings.md](docs/wiki/store-listings.md) |
| The second estate (`dev.canari-emse.fr`, the pre-release target): isolation, the prod copy, the declared version gap | [dev-environment.md](docs/wiki/infrastructure/dev-environment.md) |
| The move onto the Portail-etu host, then onto `emse.fr`: the phases, the decisions, the traps | [estate-migration.md](docs/wiki/infrastructure/estate-migration.md) |
| Whether the BOXES take their security updates, and what reports it | [host-updates.md](docs/wiki/infrastructure/host-updates.md) |
| What the USER must do by hand, and the long-term dev/release workflow (French) | [workflow-developpement.md](docs/user-guide/workflow-developpement.md) |
| A shim kept alive for old clients, and its removal date | [docs/wiki/legacy-compatibility.md](docs/wiki/legacy-compatibility.md) |
| What a report is, and what a block does and does not close | [docs/wiki/moderation-and-blocking.md](docs/wiki/moderation-and-blocking.md) |
| GDPR: the Art. 30 register (the privacy policy is its public face - change both), the MiGallery DPIA, breach and data-subject procedures, the DPO dossier | [register-of-processing](docs/wiki/compliance/register-of-processing.md) |
| The five repos and their ONE CI shape: the homogeneity mandate and every convergence decision, [the 2026-09-02 workflow migration](docs/wiki/workflow-migration.md), the shape asserted rather than described | [ecosystem-convergence.md](docs/wiki/ecosystem-convergence.md#11-the-cross-repo-convergence-plan-repo-by-repo), [ecosystem-shape](tools/ecosystem-shape/README.md) |

## **AGENT DIRECTIVES**

- **THIS REPOSITORY IS PUBLIC: no private address, host or account map, no unfixed weakness, no incident detail naming people or accounts, no real person or user id.** Those go to the private folder; docs that guard code keep the generic lesson. `.github/scripts/tests/docs-private-guard.test.mjs` fails `make test-ci-scripts` on a private IP, an ssh alias, a workstation path or a hypervisor guest id in a tracked markdown, env template, shell script or ts/mjs comment; infrastructure names come from an out-of-repo denylist (`DOCS_PRIVATE_DENYLIST_FILE`).
- NO BLIND GREP: never run generic grep or find across the project. Check SESSION STATE first, or ask for exact paths.
- ASK EARLY: state assumptions explicitly. If uncertain about architecture or a bug, ASK during planning. No guessing.
- **QUESTIONS TO THE USER GO FOUR AT A TIME** (user, 2026-10-22: *"Pose moi toujours tes questions 4 par 4"*): one `AskUserQuestion` call carries up to four questions, never one at a time, never a long numbered list in prose; each has a recommended option first, and a question already answered is never asked again.
- ONE-OFF ACTIONS GO TO THE USER (2026-08-25): *"Pour les choses qui ne se font qu'une fois, tu peux me demander de les faire hein."* Building a tool for a single click is that waste.
- SURGICAL EDITS: touch ONLY requested code. Map changes 1:1 to the prompt.
- FIX, NEVER DEFER: a warning or failure you meet is yours, whether or not you caused it - "pre-existing" is not a disposition. FACE THE BLOCKAGE: fix the cause of a failing hook (`bun run format`), never stash or bypass it.
- WORKFLOW CYCLE: Plan -> Ask if uncertain -> Execute (surgical) -> Test -> commit -> pull request -> merge -> update SESSION STATE -> STOP. **WORK GOES THROUGH A PULL REQUEST, AND IT MERGES ITSELF; NOTHING DEPLOYS ON A PUSH** - the commands are in THE DEVELOPMENT CYCLE below. Model on [workflow-migration](docs/wiki/workflow-migration.md) and [cicd](docs/wiki/cicd.md), the only copies. **Admin bypass is the EMERGENCY path only**: taking it means production is broken right now, and it is written into `CHANGELOG.md` when taken. **At every milestone** (merged PR, pre-release, stable, phone reading) update the touched `target:` lines and regenerate [plan](docs/wiki/plan.md), append to [roadmap](docs/wiki/roadmap.md)'s log (**a shipped version: re-read the plan whole**), and tell the lead to republish the private artifact.
- **RELEASE AUTHORITY** (user, 2026-10-11): the lead agent arms a pull request after an adversarial review and a green CI, and cuts pre-releases AND stables once the pre-release is read on a phone and nothing blocks, telling the user each time; **owner, 2026-11-10: the lead may also push store texts, screenshots and a new version (privacy URL included) to the App Store and Play consoles, and cut the 1.6.9 stable before the owner is back, on the same condition (read on both phones);** **feature switches (`calls_mode`, the CanaReels writer switch, any `*_COMPILED` or server mode) are the lead's to flip once their readings pass** (user, 2026-11-02: *"Tu peux tout activer en autonomie"*). **During the owner's long absence (granted 2026-11-02):** a migration, destructive ones included, merges after an adversarial review and a pass on dev (a HELD one: its approval line is merged by the owner OR by the lead under the 2026-11-03 delegation, [three conditions](docs/wiki/backlog.d/owner-decisions-of-2026-11-03-evening.md)); production down with no other fix may be RESTARTED or ROLLED BACK to the last good release (never a data deletion, never a host security setting), written into `CHANGELOG.md`; a new design question takes the recommended option when reversible (written to the wiki) and is parked in `open-questions.md` when not; progress is reported on one private tracking page. Any other direct production change or deletion still waits for the user's yes ([durable-rules](docs/wiki/durable-rules.md#release-and-ci---cicd); the 48-hour window of 2026-10-22 has ended). **NEVER INFER A STORE, A VERSION OR A CI STATE FROM A LINE HERE.** `gh release list` is the shipped version, `git log <latest stable>..origin/main` the unreleased work, Play a MEASUREMENT (`bun tools/play-vitals/vitals.mjs`), CI `gh run list`.
- **FOUR WORKFLOWS ARE VISIBLE IN THE ACTIONS LIST, AND THAT IS DELIBERATE** (user, 2026-09-04: *"le moins de workflows differents possibles, ca inonde la console github"*): `ci.yml`, `release.yml`, `arm-auto-merge.yml`, `scheduled.yml`; the rest are `workflow_call` libraries ([cicd](docs/wiki/cicd.md)). **A fifth visible workflow needs a reason beyond "another topic".**
- COMMIT **AND PUSH** IN THE BACKGROUND, ALWAYS - both are minutes long and neither is worth a blocked session. The pre-commit hook sweeps the WHOLE frontend (2-3 min) and re-stages it; a push to this remote routinely exceeds a 5-min foreground timeout. Isolate unrelated dirty files first. `rm -rf apps/*/dist` before `git push`.
- STATE PRUNING: when updating SESSION STATE, DELETE completed work outright. Its rule goes to `durable-rules`, its story to `CHANGELOG.md`, its mechanism to the wiki page that entry points at. **Do not reconstruct shipped work here.**
- CLAUDE.md HYGIENE: **INDEX FIRST** - the STATE PRUNING triplet applied to this whole file: if it grows, something in it belongs somewhere else. **The cap is ~250 lines** (back from ~350 on 2026-10-22, when the file was cleaned to an index; the raise of 2026-09-04 paid for THE DEVELOPMENT CYCLE, which the user asked to live here - *"tu consigneras le cycle de developpement dans le claude.md de Canari pour pouvoir l'utiliser en pratique"* - and those commands stay). `claude-md-cap.test.mjs` reads the number from this sentence. A cap the file itself breaks is worse than no cap.
- DOCUMENTATION: technical docs in `docs/wiki/` (English, LLM-oriented, **search it before reading source**), updated alongside the code - stale wiki is worse than none; keep `apps/*/README.md` synced with its wiki counterpart and cross-link freely. User guides in `docs/user-guide/` (French). Root: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`. Delete unused code immediately.
- CHANGELOG: one **SHORT** entry per change, as ITS OWN FILE in `changelog.d/` - never under `[Unreleased]`, which GitHub cannot merge in parallel ([README](changelog.d/README.md)). A sentence or two and a LINK (user, 2026-09-17); reasoning, measurements and what was refuted go on the wiki page it points at. **A NEW BACKLOG ENTRY IS THE SAME: its own file in `docs/wiki/backlog.d/`, AND IT IS PLANNED IN THE SAME PULL REQUEST** - a `target: <version>` line under its title and `bun tools/backlog-plan/plan.mjs` re-run (owner, 2026-11-13; `backlog-plan.test.mjs` fails otherwise; [README](docs/wiki/backlog.d/README.md)).
- DELEGATION: broad file-gathering goes to a search subagent; a big, risky or native Work Package goes to a background agent through a precise brief in `AGENTS.md`.
- **THE SHARED HOST IS THE SCHOOL IT DEPARTMENT'S: NO INSTALL, REMOVAL OR SECURITY SETTING WITHOUT THEIR WRITTEN AGREEMENT, ASKED BEFORE** (2026-10-09). Read-only commands are free. The installed set is in the private operations notes; the rule is in [durable-rules](docs/wiki/durable-rules.md).
- PROD ACCESS: production, dev and the identity provider run on one shared host reached over SSH. **The aliases, the box map, the shell wiring and the database and identity-provider access routes are in the private operations notes** and nowhere in this repository. Either Bash or PowerShell reaches it, but **PowerShell text-encodes stdout and corrupts a binary pipe** (a `pg_dump | gzip` through it is lost), so a binary pipe goes through Bash.

## **THE DEVELOPMENT CYCLE - THE COMMANDS, IN ORDER**

Two human gestures, everything between them mechanical - and the same in Sky, MiGallery and
Portail-etu since 2026-09-04, minus the bump and the two stores.

```
                    ONE                                        TWO
            open a pull request                        publish a release
                     |                                          |
   git switch -c fix/what-it-does                gh release create v0.16.2 \
   ...commit...                                       --generate-notes
   gh pr create                                             |
        |                                          release.yml, ONE run
        +--> CI ------------------+                         |
        |     tests + security    |                  6 gates (no bypass)
        |     -> `CI passed`      |                         |
        +--> arm-auto-merge ------+                    bump + push
              (IN PARALLEL)       |                         |
                                  v                +--------+--------+------+
                        GitHub squash-merges       |        |        |      |
                        + deletes the branch    deploy   android    ios   notes
                                  |             (build)   (Play)  (Store)
                                  v                +--------+--------+
                       push on main = CI ONLY               |
                       NOTHING DEPLOYS                production estate
                                                  (stable only, and only once
                                                   BOTH stores took the version)
```

**Before every commit**: `bun run check` (0 errors), `bun run lint`, `bun run format` in `frontend/` -
the hook runs them anyway and re-stages, so run them first rather than reading a commit you have not
seen. Then commit AND push in the background.

**GESTURE ONE, and the whole of it.** `git switch -c`, commit, `gh pr create` - then **nothing**.
No approval is required, the merge and the branch deletion are automatic, and `main` carries ruleset
`22152902`: no direct push, no force-push, one required check, `CI passed`. **A merged fix is not a
shipped fix.**

**GESTURE TWO, and what it owes.** A STABLE `vX.Y.Z` deploys production and ships both stores; a
PRE-RELEASE `vX.Y.Z-alpha.N` deploys `dev.canari-emse.fr` and the store TESTER programmes. **The
hyphen IS the definition**, read by `release_kind()` in `.github/scripts/lib/release-preconditions.sh`
(the ONE implementation) and by `scripts/bump-app-version.sh`'s store band. **A stable owes exactly
one thing written by a human**: `store/whats-new.txt`, first line `version: X.Y.Z` - one text reaching
the App Store, Play and the GitHub release body through ONE implementation, read from the PRE-RELEASE's tree - so check it before cutting the last alpha:

```sh
MARKETING_VERSION=0.16.2 bun tools/app-store/submit.mjs --check-notes
```

**A STABLE SHIPS THE LATEST `vX.Y.Z-alpha.N` OF ITS VERSION** (built on `release/vX.Y.Z` like every pre-release, tag moved to the shipped commit, so `main` may keep merging) **and is REFUSED without one that served dev**, so the ordinary
sequence is two releases:

```sh
gh release create v0.16.2-alpha.1 --prerelease --generate-notes   # -> dev + testers, moves the marker
# wait for it to be green; merging to main meanwhile is fine - the stable ships THIS pre-release
gh release create v0.16.2 --generate-notes                        # -> production + both stores
```

**The six gates, and there is no bypass input** (`.github/scripts/release-preflight.sh`): the
version parses; `main` contains the commit (merging after the cut is free: every bump pushes
`release/vX.Y.Z`, `land` carries it to `main`, [cicd](docs/wiki/cicd.md#a-pre-release-is-pinned-on-its-release-branch-decided-2026-10-30)) and a pre-release is the newest release (no tag has a higher store build); `CI passed` is green ON that
commit - **main's OWN CI takes 14-22 min (17-20 typical, measured 2026-10-18) after a merge, so a release cut in the minute after one is
REFUSED with `CI passed never ran on <sha>`; wait for `gh run list --branch main`, then `gh run
rerun`, which needs no new tag** (2026-09-07). **A RERUN RESCUES THAT GATE ONLY, AND ONLY WHILE NOTHING NEWER SHIPPED** - it re-reads the SAME tag, so once a later pre-release is out the rerun is REFUSED (it would move dev and the store build back) and the answer is a NEW tag at the current head; dev has served it
(stables); the notes name it; no held migration ships without its approval line merged by hand, by the owner or by the lead under the 2026-11-03 delegation ([held](docs/wiki/cicd.md#a-migration-the-owner-must-approve-is-held-2026-11-01)). *A skip flag is a fallback, and the fix belongs where the primary path
failed.* The emergency path is a human with admin rights, written into `CHANGELOG.md` when taken.

**Afterwards**: delete the local branch (`git branch -D`; squash merges are invisible to `--merged`,
and a kept one is what a later push RESURRECTS - pushed and UNSHIPPED), update SESSION STATE, STOP.

## **ARCHITECTURE & CONSTRAINTS**

- Stack: SvelteKit 5 + Tailwind 4 + Tauri 2 (front) | Rust WASM openmls | NestJS + Rust Axum (back).
- Nginx: single public entry point. Source of truth is `infrastructure/local/Dockerfile.frontend`.
- MLS (RFC 9420): all encryption in WASM. Server stores ciphertexts. NEVER modify keys manually.
- Build: `frontend/src/lib/wasm/` and `src/lib/proto/canari.{js,d.ts}` are GENERATED and NOT in git - `cd frontend && bun run generate` after a structural change; every pipeline builds them itself ([mls-wasm](docs/wiki/frontend/mls-wasm.md#why-it-is-not-committed)).
- Auth: access tokens in memory ONLY (never localStorage). Refresh token in an HttpOnly cookie **everywhere the engine keeps one** - on `tauri://localhost` (iOS, macOS, Linux) WKWebView drops it and the client carries it in `X-Canari-Refresh` instead, one fact deciding both sides ([sessions](docs/wiki/sessions.md#the-credential-a-client-carries-itself)). WS auth via `canari_ws_token`.
- Media: the client generates the CEK (AES-256-GCM) before upload. The backend sees opaque blobs.
- Infra truth: keep `infrastructure/MIGRATION.md` synced with new secrets, services or bootstrap steps; add a new service to `docs/wiki/infrastructure/` and the `README.md` diagram.

## **CODING STANDARDS**

- Logs: mandatory (`Log.d`, `appendLog`, `log::debug!`) at function entry, decisions and error branches.
- Docs: JSDoc/Rustdoc required for exports. Explain WHAT and WHY, never restate types.
- Factorization: extract and export reusable logic. Zero duplication.
- Language: code, comments, docs and dev-facing strings MUST be English. **User-visible strings use Paraglide (`messages/fr.json`, `en.json`) on the FIRST draft** - no inline literals, ALWAYS, even in a plain `.ts` util, and even when a nearby call site already has raw strings. Nothing types a string as user-visible, so no compiler enforces it.
- Punctuation: ASCII (`'`, `"`, `-`) everywhere; escape quotes in code. Keep French accents ONLY in localized strings and French comments.
- Tests: changing logic requires changing the associated test.
- UI: `src/app.css` holds the tokens, and **COLOUR, TYPE AND RADIUS ARE ALL SCALED SINCE #447** - seven `--text-*` steps replacing 36 sizes, and `--radius-*` replacing 14 corners with FOUR meanings (8px card / 12px larger card / 18px bubble / 999px pill). **Read the scale before reaching for a number**: `rounded-2xl` is 12px here, not Tailwind's 16px. The measured target, and the Messenger/Facebook numbers it copies, are in [design-reference](docs/wiki/frontend/design-reference.md), the only copy. No raw hex/px. `@lucide/svelte` only (NOT `lucide-svelte`, the old name - both resolve).

## **KEY COMMANDS**

- **BUN RUNS THE SCRIPTS TOO, NEVER `node`** (user, 2026-09-04: *"Jamais node, toujours bun"*). Every `.mjs` in `tools/` is invoked `bun x.mjs`, the Makefile's harness gate included; a script that spawns another uses `process.execPath` so it inherits the runtime rather than naming one. `archive/gate-selftest.mjs` parses the `test-harness` recipe and would match nothing if the two ever disagreed - it accepts both spellings and FAILS on an empty gate, which is how a silent mismatch surfaces.
- Package manager: bun everywhere - frontend and the four NestJS apps each commit a `bun.lock`, CI installs `--frozen-lockfile`, the Makefile calls bun. **`.bun-version` is the ONE place this repo names a bun version.** No `packageManager` field, no `engines.bun`, no npm.
- Setup/dev: `make install`, `make run-services`, `cd frontend && bun run dev`.
- Tests: `make test`, `make test-frontend`, `cargo test`, `make test-ci-scripts`; `make run-ci` for the full local pipeline. Rust >= 1.97, `cargo clippy` for Rust crates.
- **NOTHING IN THIS REPO IS FORMATTED BY PRETTIER.** Everything is `oxfmt` (`oxfmt.json`) + `oxlint`. A bare `npx prettier --write` finds NO config, silently applies its own defaults (double quotes, 80 cols) and rewrites whole files - it did, and shipped. Use the package's own `format` / `lint` script, always. `bun run lint` shells out to `sh` (the oxvelte shim), so run it through the Bash tool.

## **THE RULES THAT APPLY TO EVERY TASK**

Everything area-specific is in [durable-rules](docs/wiki/durable-rules.md). These are the ones no task
escapes.

- **THE CHARTER COMES FIRST** ([docs/principes.md](docs/principes.md), owner, 2026-11-10): every feature decision that touches a principle CITES it in its wiki decision, and a feature that breaks one is refused or reworked, never shipped with a note.
  The principles are ORDERED and the first wins in a conflict (1 your messages are yours, 2 the essential is never lost, 3 your attention is not for sale, then independence, community, kindness, simplicity, durability).
- **The user's standing directives, verbatim:** *"le probleme doit etre architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les tailles"*; *"pense factorisation, proprete, simplicite"*.
- **A REFUSAL IS NEVER A ROUTING DECISION TO A HUMAN QUEUE** (user, 2026-08-31: *"Je prefere blinder de test et faire les choses automatiquement qu'avoir une review humaine qui n'arrive jamais"*, *"pour avoir un projet qui peut 'vivre tout seul'"*) - it is a statement that a gate is MISSING, and it must NAME the test that would lift it. A queue nobody drains is worse than the merge it prevented.
- **A FALLBACK IS A SIGNAL, NEVER A PATH.** Never add one: reaching one means the primary path failed and the fix belongs THERE. So it is logged at a level that ACCUSES, and its rate is measured against the population before its name is believed.
- **A status code is an ANSWER, a transport failure is not.** Only a 401/403 may log a user out, and `navigator.onLine` never proves reachability (a captive portal reports `true`).
- **Never branch on an error MESSAGE.** A distinction carried in prose is a distinction exactly ONE call site will make - classify at the THROW, as a type. When auditing such a seam, enumerate its consumers, never just the ones that mention it.
- **IDEMPOTENCE COMES FROM DURABLE STATE, TERMINATION FROM A PROOF - never from a clock.** Ask of every timer what it would mean if it were wrong; if the answer is "more traffic", it is load-bearing and should not be. But durable state answers only THE QUESTION IT WAS WRITTEN FOR: "is this broken" and "have I already asked" differ only in lifetime, and using one for the other silences the trigger.
- **A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS WRITTEN TO ANSWER.** A liveness clock must be written by the thing whose liveness it measures. **A PREDICATE THAT NAMED THE LAST INCIDENT IS NOT THE PREDICATE THAT NAMES THE NEXT ONE.** Re-measure it against the population it will actually run on - one `GROUP BY` settles it in seconds.
- **A CORRECT MECHANISM WITH NO REPORT IS FOUND BY HAND, A DAY LATE**, and the report must carry the evidence separating the causes it cannot itself distinguish. **A CLAIM THAT SOMETHING IS STALE MUST NAME THE MECHANISM THAT WOULD HONOUR IT AND SHOW THAT MECHANISM GONE.**
- **Every swallowed branch logs** - in a best-effort path that is all a loss leaves. A batch of jobs catches and logs PER JOB; isolation is a `try` per subscriber or it does not exist.
- **A DESTRUCTIVE CONTROL NEEDS AN ALLOWLIST OF WHAT IT MAY TOUCH, NOT A DENYLIST** - and a destructive repair must be gated on knowing the state is really broken.
- **WHEN SOMETHING KEEPS REFILLING, DELETING IT IS NOT THE FIX** - revoke whatever keeps naming it as a destination. And before deleting a container to reclaim what one member costs, enumerate the other members.
- **Never assert a wall clock in a test.** Two isolated browser contexts = two devices.
- **A green gate is not a working system.** Everything native is verified by COMPILING, which proves nothing about running; a green deploy proves the containers started, never that the site answers.
- **A RACE THAT HEALS CLEANLY IS STILL A DEFECT.** If the mechanism needs a heal in THEORY it is wrong, whatever it does in practice. Name what makes the two paths overlap and delete the overlap - a ledger that reconciles them afterwards is a witness, never a fix.
- **NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU.** Handing an operation to a layer certain to refuse it, in order to classify the refusal, is work the design owes: carry the discriminator to where the decision is made, from where it is already KNOWN.
- **NOISE IS NEVER ACCEPTABLE - web, mobile or server.** A line is either expected AND necessary, or it is the visible end of something upstream. Explain it or fix it, and never demote it - the cost is real, and a line its reader learns to skip is the one that hides the next defect.

---

## **SESSION STATE (Active Memory)**

**Five repos** on `main`: **Canari** (`emse-students/canari`, **PUBLIC**) is the only active one; **Sky**, **MiGallery**,
**Portail-etu** (**PUBLIC**) and **Le Cercle** (`../Sky`, `../MiGallery`, `../refonte-portail-etu`, `../le-cercle`) are COMPLETE. **P1** security or a broken user-facing path,
**P2** correctness, **P3** hygiene. Nothing is parked (2026-08-18): a new item is a [backlog.d/](docs/wiki/backlog.d/README.md) file
naming its version, deleted the day it ships. **What only
the USER can do is ONE table** - [backlog](docs/wiki/backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks).

**CLOSED, DO NOT REOPEN** (user: record closed chantiers so nobody returns to them fifty times):
section navigation ([section-navigation](docs/wiki/frontend/section-navigation.md)), read-receipt
privacy ([read-receipt-privacy](docs/wiki/read-receipt-privacy.md); reopened by the owner 2026-11-11 for the idle window, rows 17-20), the first pass of community-open
slowness ([report](docs/wiki/frontend/community-open-slowness-mi9t-2026-10-13.md)), all 2026-10-14; the interface chantier, 2026-09-29 ([ecosystem-convergence](docs/wiki/ecosystem-convergence.md#where-the-chantier-stands-and-the-restart-order)).

### CANARI - THE PLAN IS THE QUEUE

**[plan](docs/wiki/plan.md) is the order** - every open entry under its version, P1 first then the oldest, generated
from the `target:` line of each [backlog.d/](docs/wiki/backlog.d/README.md) file (owner, 2026-11-13). Nothing is
listed here a second time. `1.7.0` (owner, 2026-11-13): group calls; "Envoyer a..." and CanaReels in chats,
flipped after the 13 readings; screen share in lives on desktop; the slow-link chantier steps that are ready; and
EVERY entry owed only a reading, taken on the `1.6.12` and `1.7.0` pre-releases ([checklist](docs/wiki/plan.md#readings-owed)).
After it, the owner's order of 2026-11-11: the slow-link chantier, then the oldest entries, no new feature unless asked
([note](docs/wiki/backlog.d/owner-decisions-of-2026-11-11.md)).
