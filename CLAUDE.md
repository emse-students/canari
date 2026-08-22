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
| What the app has that NOTHING watches | [docs/wiki/mechanism-audit.md](docs/wiki/mechanism-audit.md) |
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

Everything actionable is HERE, one line each; the detail lives where the link says and **is not
restated**. An item is done when its code, its tests, its doc and its commit are in, and it is then
deleted from BOTH this file and [backlog](docs/wiki/backlog.md). **Every defect story is in
`CHANGELOG.md`, every rule one left is in [durable-rules](docs/wiki/durable-rules.md), every verdict
is on [cross-client-testing](docs/wiki/cross-client-testing.md); none of the three is restated here.**

1. **THE COMM RUNNERS - ALL TWENTY-FIVE WRITTEN AND REGISTERED**, each run on prod as it was written
    (user, 2026-08-20: writing all then running once is verification by COMPILING). **TWO HAVE NEVER
    RUN THERE - 14 and 18**, each needing a capability the harness has yet to prove: real push, and a
    cold start through `adb`. A capability is unproven until a check using it produces a result it
    could not have produced by accident. Verdicts are on the board and are not restated here. **The
    phone shows a GENERIC notification body** (user, 2026-08-20, on a stale app): COMM-14's row, an
    observation and not a defect until the runner says so - and A1 now runs a current build, so it is
    owed a re-look.
2. **A1 RUNS `67d40e3a` as of 2026-08-21** - rebuilt and installed after the two Graine fixes of that
    day, replacing `02ae609b`. `npx tauri` does NOT resolve here (`could not determine executable to
    run`); build with `./node_modules/.bin/tauri.exe android build --debug` from `frontend/`, and
    install the **universal** APK, never `arm64/`. A fresh install means a new process, so
    `phone.ensure({ port: 9333 })` before `pin.mjs --device A1` - the old devtools forward is dead
    and `pin.mjs` alone reports `ECONNREFUSED`. **A phone `offline` in adb is a HUMAN action**: no
    `adb reconnect` or daemon restart clears it, the screen must be unlocked and the prompt accepted.
3. **THE CAMPAIGN ITSELF - RUNNING, by the user's decision of 2026-08-21** (*"C'est parti pour la
    campagne"*, in autonomy). The ladder, top to bottom, everything must end green, so every phase
    runs - including the six that had no runner, written as the ladder reaches them. The design, the
    cost and the decisions it turns on are on
    [cross-client-testing](docs/wiki/cross-client-testing.md) and
    [cross-client-campaign](docs/wiki/cross-client-campaign.md), the only copies. **Where the ladder
    stands: rungs 1 MSG and 2 TYPE green x1, 3 READ green CLEAN 5/5, 4 MUT green CLEAN 5/5. Next: 5
    SEARCH, 6 MENTION, then FWD, GRP, COMM, DEL, TAB, MULTI, LIFE, NOTIF, CALL, HEAL, PIN,
    CORRUPT.** The board carries every verdict; do not restate them here.
    **THE BOARD'S FORMAT IS NOW FIXED by the user (2026-08-22): a `PASS` cell is `PASS X/X` and a time
    if the time means anything, nothing else.** Prose only for a non-clean verdict or an unresolved
    item. The rule is written at the top of the board itself.

**OWED RIGHT NOW, and none of it is derivable from the code:**

- **`mut.mjs` MOVED TO `9828e60640bb` AFTER ITS x5 LANDED, so the board's MUT rows stand on the
  runner before it (`4a9814f845d7`).** The delta is three payload claims and their comments, no
  assertion and no navigation - so **one x1 on the new sha confirms it**, and until that x1 the two
  shas are the honest state rather than a technicality to wave through.
- **A VERIFICATION IS OWED ON PROD.** The new `[DISMISS] ... recorded=N` / `[UNDISMISS] ... lifted=N`
  format is proven only by `srvclassify-selftest.mjs`, never against production - MUT generates no
  dismissal traffic. **Run READ-10 once** (`--destructive`, self-cleaning, 5/5) and read the window.
  Until then the fix is verified by compiling, which this repo does not accept as verified.
- **MUT'S EVIDENCE STREAM CARRIED THREE STALE CLAIMS**, all hard-coded literals a `PASS` never reads:
  a closed security hole still reported as open (`architecturalGapFound: true`, ten days after
  `f924932b` closed it), MUT-18 explaining its verdict by that same absent guard, and a `filedAs`
  pointing at a `backlog.md` entry deleted when its fix shipped. All three corrected; the rule is
  [testing-methodology](docs/wiki/testing-methodology.md) 31. **The other thirty runners were then
  swept for the same shape and are clean**: two more in `search.mjs` (the 2000-row cap, the unpassed
  `isHighlighted` ring), both re-verified against source that had MOVED since they were written, both
  relocated out of the payload before the phase ran. Everything else matching the pattern is either
  computed or names the fixture the check set up, which is what a payload is for.
- **THE MECHANISM AUDIT IS DONE AND SCORED** on [mechanism-audit](docs/wiki/mechanism-audit.md) -
  five findings, two code changes, two verified negatives, one unchanged. Read it there.

**The estate was swept and measured clean 2026-08-21 before the ladder started** - 22 debris salons through the product, all thirteen residue counts on prod zero afterwards. `cleanup.mjs` owns communities, salons AND throwaway groups now; the detail is on [cross-client-campaign](docs/wiki/cross-client-campaign.md).

**OWED TO THE USER, NOT TO THE CODE: the MLS + Graine explanation.** For THEM, prose and diagrams, no
code (user, 2026-08-20). Post-campaign; scope and the two audiences declined are on
[backlog](docs/wiki/backlog.md).

**THE SIX THAT CANNOT BE PULLED FORWARD** - none is waiting on us, and each carries its blocking
condition in [backlog](docs/wiki/backlog.md), the only copy: the `libcrux-chacha20poly1305` panic
(needs a stable `openmls_rust_crypto 0.6.0`), the iOS avatar-cache question (needs an iPhone), the
Lydia flip WP-LYDIA-1 (needs credentials Lydia owes), one MLS client in a SharedWorker, and
`dev.canari-emse.fr` plus the SECOND campaign (both post-campaign by the user's decision). **The
sixth is owed to the user, not to the code:** is a MiGallery application worth building?

### CANARI - what is open

**Release status:** v0.14.1 cut 2026-08-21 by the user, carrying their
`ITSAppUsesNonExemptEncryption=true` in the iOS `Info.plist` (App Store Connect compliance; the app
does MLS end-to-end encryption, so `true` is the honest declaration). **Two of its four pipelines
failed and were repaired in place** - the runs were re-run rather than a version burnt, because both
release workflows check out `ref: main` and `gh run rerun` keeps the `workflow_run` event context the
upload and TestFlight steps are gated on. Both defects are in `CHANGELOG.md`; the second one, a
`-D warnings` that escaped its step through `$GITHUB_ENV` and only bit on a WASM cache MISS, is why a
release pipeline could be green one week and red the next with no commit between.

`minClientVersion` still lives in `platform_config`, is still raised by hand from `/admin/platform`
so no deploy touches it - and **the App Store half was never verified, so a raise locks out any iOS
user it has not reached** ([legacy-compatibility](docs/wiki/legacy-compatibility.md) carries the
shipping order it violated). **v0.14.1 IS COMPLETE AS A GITHUB RELEASE** - AAB, APK, IPA and AppImage all attached. **TestFlight
is the one thing blocked, and it is blocked ON THE USER** (their decision, 2026-08-22: leave it).
App Store Connect refuses the upload: *"Invalid Export Compliance Code... the key value [] in the
app's Info.plist doesn't match... the app's export compliance documentation."* Apple holds compliance
docs carrying a code, so `ITSAppUsesNonExemptEncryption=true` alone is not enough - the plist also
needs `ITSEncryptionExportComplianceCode`, whose value exists ONLY in the user's App Store Connect
account. The alternative is deleting the key, which restores the per-build questionnaire. Not
decidable from this repository.

So **the App Store half of `minClientVersion` is still unverified and still locks out any iOS user a
release has not reached** - v0.14.1 did not close that gap and will not until TestFlight accepts it.

### CANARI - the test campaign

Four files, four jobs, no overlap, all four listed in WHERE THINGS LIVE above: the board is state,
the campaign page is design, the methodology page is how a result earns belief, the harness README is
the operating manual. **Read them rather than re-deriving state here, and keep no second copy.**

**The rig lives in the repo at `tools/cross-client-harness/`; its STATE lives outside at
`../canari-harness`** - `test-accounts.json`, the debug APK, A1's baseline, `results.ndjson`, and
`chrome-w1` / `chrome-w2`, which ARE the W1 and W2 devices. Losing a profile costs a re-enrolment and
SETUP-4's 2FA, the one step no tool here can answer. Outside the work tree a credential CANNOT be
committed and `git clean -xdf` cannot reach a profile.

**A1's APK predates the deployment on purpose** - `frontendDist` is `../build`, so the phone serves
what is inside its APK and a deploy never reaches it. That is a real mixed-fleet state, so every row
of a phase that arms the phone names `a1Build` beside `build`. **That is now true by construction and
was not before**: the preflight reads the phone once and hands the stamp down through
`CANARI_A1_BUILD`, because only four runners out of thirty had ever recorded it themselves - `msg2`,
`msg5`, `msg8` and `msg8b` all drive the phone and all landed rows without it, found while MSG was
running on 2026-08-21. A phase with no phone carries no stamp at all.

**MUT-20 is unarmable until a campaign message reaches 90 days** (earliest 2026-11-09).

**Prod IS the test server** and commit+push are authorised so it picks changes up.
`dev.canari-emse.fr` is a proxied CNAME to the same tunnel, NOT a second environment. **Decided
2026-08-17: it BECOMES a real second environment, after the campaign.** Scope it in
[backlog](docs/wiki/backlog.md).

**LEON PUSHES TO CANARI's `main` TOO.** `git fetch` at the START of a session and again before any
measurement, and `git pull` his work in. **It does not concern ours and owes no pass** (user,
2026-08-21).

**Standing architectural directives from the user, verbatim:** *"le probleme doit etre
architecturalement regle, pas mettre des pansements avec des timeouts ou autre, je veux que tout soit
deterministe, reproductible, explicable. Et doit marcher avec une conversation de toute les
tailles"*; *"pense factorisation, proprete, simplicite"*.

