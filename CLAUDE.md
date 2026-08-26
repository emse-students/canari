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
- PROD ACCESS: `ssh canari`, `ssh mitv`, `ssh cercle` (via ProxyJump canari). Postgres is the container `infrastructure-postgres-1`, and `auth_db` is the ONLY database - every service shares it, social-service included (its `DB_DATABASE` default `canari_social` does not exist on prod). User `canari`. **Use the PowerShell tool, never Bash** - Git Bash strips the backslashes out of the cloudflared ProxyCommand. Quote SQL single-outer, doubled-inner: `ssh canari 'docker exec … psql -U canari -d auth_db -x -c "SELECT … WHERE id = ''uuid''"'`.

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

1. **THE CAMPAIGN ITSELF - RUNNING, by the user's decision of 2026-08-21** (*"C'est parti pour la
    campagne"*, in autonomy). The ladder, top to bottom, so every phase runs - including the six that
    had no runner, written as the ladder reaches them. Design, cost and the decisions it turns on are
    on [cross-client-testing](docs/wiki/cross-client-testing.md) and
    [cross-client-campaign](docs/wiki/cross-client-campaign.md), the only copies. **Where the ladder
    stands: rungs 1-8 TAKEN.** GRP closed 2026-08-26 on `feecfaf5` over four passes - GRP-4 green
    after `e027679a`, GRP-8 `PASS-DIRTY` deterministically (its P2 is in
    [backlog](docs/wiki/backlog.md)). **9 COMM IS NOT SWEPT: the board over-claimed it, corrected
    2026-08-26 against the ledger** - 12 PASS, 10 `PASS-DIRTY`, 3 `FAIL` (COMM-8, COMM-18, COMM-22),
    and ELEVEN of those thirteen carry ONE signature, an external join into a salon's distribution
    group that never lands. **That cause is FIXED** (the base now travels inside the commit
    submission and is written with the epoch advance in one transaction - story in `CHANGELOG.md`,
    the half still open in [backlog](docs/wiki/backlog.md)), so **the whole rung is ONE re-run** -
    which also owes the proof WP-REGRANT-2 wants and needs the phone for COMM-18. **10 DEL IS SWEPT:
    8 PASS, DEL-1 `PASS-DIRTY`, DEL-10 a `FAIL` on its own fix** - the durable row is kept and
    nothing replays it, and which of the two triggers is missing needs a runner that captures W1's
    console (P2 in [backlog](docs/wiki/backlog.md)). **NEXT IS THE COMM RE-RUN, then 11 TAB**, then
    MULTI, LIFE, NOTIF, CALL, HEAL, PIN, CORRUPT. The board carries every verdict and the format of a
    cell; do not restate either here. **A `PASS-DIRTY` NO LONGER STOPS A RUNG BY ITSELF (user,
    2026-08-25)**, and **a x5 sweep of the WHOLE ladder accepting nothing short of `PASS` comes AFTER
    the campaign reaches the bottom (user, 2026-08-26)** - until then one pass per rung is the target.
    What the class of the dirt decides is on
    [cross-client-campaign](docs/wiki/cross-client-campaign.md), the only copy.
    **What is left is a WRITING job as much as a running one:** only CALL, CORRUPT and PIN have NO
    runner at all - TAB, MULTI, LIFE, NOTIF and HEAL are covered. The bill per phase is there too.

    **A KILLED RUN CAN DESTROY A MEASUREMENT SECONDS FROM BEING RECORDED**, and **`node rows.mjs`
    SETTLES WHETHER THE BOARD STILL MATCHES THE LEDGER - run it before believing a cell**
    ([testing-methodology](docs/wiki/testing-methodology.md), the only copy). The shared venue is
    `fbddc890` / `general` `064ac7d2`, rebuilt 2026-08-26 after a THIRD disappearance, cause unrecorded.

2. **DEFERRED PAST THE LADDER - seven UX and rendering items, substance in
    [backlog](docs/wiki/backlog.md) and NOWHERE else**, in the order they were raised: the POSTS search
    escapes the feed's filters and loads the whole base; the EMOJI picker neither scrolls nor stays on
    screen, from one hard-coded height guess; a reconnected old client restored only SOME conversations
    while a locally-pending deletion blocked the new one with that peer (HEAL's, rung 16); **ONE
    BUNDLED EMOJI FONT everywhere** - Noto Color Emoji, decided 2026-08-23, owing ELEVEN rows to the
    SECOND campaign; a deleted group leaves every OTHER member a dead row for ever, clearable one at a
    time; the trash and the pencil on a device row do not read as the same kind of control (*"il
    faudrait homogeneiser"*, 2026-08-25); a MENTION renders as its raw `@[uuid]` token (2026-08-22,
    P2, NOTIF-13 pins it). The emoji, the dead row and the device controls want ONE pass over
    `app.css`, not seven local patches.

3.  **`purge-devices.mjs` WOULD DELETE THE PHONE - a destructive control keyed on a string the
    product never renders.** **Do not run it until it takes an `--only` allowlist**; repair and
    evidence in [backlog](docs/wiki/backlog.md).
4.  **ONE NAMED STARTING POINT FOR EVERY PHASE, STEP AND STEP GROUP** - asked by the user 2026-08-25
    (*"le meme point de depart, independamment de ce qui a pu se passer avant"*). The PHASE-level half
    is `run.mjs`'s preflight; what is left is per-STEP granularity, pulled forward the moment a rung is
    blocked by an inherited state. Contract, audit and the seven-file PIN predicate it fixes are in
    [backlog](docs/wiki/backlog.md); diagnosis order is [testing-methodology](docs/wiki/testing-methodology.md) 39.

### CANARI - THE ECOSYSTEM CHANTIER (paused 2026-08-27, resumable from here)

The user's standing mandate, verbatim: *"Je veux de l'homogeneite et les meilleurs standards de
partout. Partout. oxlint/oxfmt ect partout, TS7 partout ou c'est possible..., Lucide derniere version
avec tous les composants stale corriges PARTOUT, bun a la place de npm PARTOUT etc."* Its
measurements and per-repo state live in
[ecosystem-convergence](docs/wiki/ecosystem-convergence.md) - **section 8 is the package-manager
half and is the only copy**; nothing here restates it.

**Decisions already taken and NOT to be relitigated:** bun is the runtime everywhere it can be;
**RENOVATE IS DROPPED** (2026-08-27) - Dependabot's bun ecosystem works and the only thing that
breaks it is a lockfile version we control, so no GitHub App install is owed by the user; Sky keeps
Tailwind and migrates to v4 without preflight; `bun:sqlite` replaces better-sqlite3; the `image_url`
deletion stands.

**DONE:** Portail-etu pinned and its outage closed (deploy green, site 200). Canari: one
`.bun-version` feeding eight workflow sites; the 18 deprecated lucide names; the four NestJS
services migrated to bun end to end - images BUILT AND STARTED locally, all four reaching
`NestFactory`.

**THE ONE MEASURED LIMIT ON "bun PARTOUT":** jest fails under the bun runtime -
`admin-storage.controller.mls.spec.ts` passes 8/8 under node and fails under bun. CI therefore
installs/lints/builds with bun and TESTS with node, and both call sites in `ci.yml` say so. **Do not
collapse that to one runtime without re-running that spec.**

**OPEN, in order:**

1. **`libs/shared-ts` has NO consumer.** Nothing in any `src/` imports `@canari/shared-ts`; its only
   mention is a jest `moduleNameMapper` in chat-delivery pointing at the library's SOURCE. Yet
   `ci.yml` builds it before every backend test as "a build dependency for all TS backends", it sits
   in the cd path filters of `cd.yml` and `cd-dev.yml`, in `dependabot.yml` and in the Makefile, and
   its only recent commits are version bumps. **Measure once more, then delete it and the machinery,
   or write down what it is for.** `ci.yml:87` also names a `libs/event-contracts` - check whether
   that exists at all.
2. **`Dockerfile.frontend-ssr` is the last `node:22` in the repo** (every other image is 24), and its
   comments are French in a repo whose rule is English. Moving it to bun is NOT a tag swap: it runs
   an `adapter-node` build, and the bun path is `svelte-adapter-bun` (what Portail uses), which
   changes the SSR entry and how nginx proxies it. Decide deliberately; the node:24 bump is safe on
   its own.
3. **The rest of the mandate, untouched:** TS 7 where possible (Dependabot has already proposed
   `typescript 6.0.3 -> 7.0.2` on `/frontend` and `/libs/shared-ts`); `npm run` -> `bun run` inside
   `frontend/package.json`'s own scripts; CodeQL + secret scanning on every repo; oxlint/oxfmt/oxvelte
   on le-cercle and MiGallery.
4. **Sky, MiGallery, le-cercle have not been touched this session** and each still owes a
   `.bun-version`. Sky is in a NON-BUILDABLE intermediate state from an earlier session: `bun
   install` pending, 36 `lucide-svelte` -> `@lucide/svelte` plus ~4 deprecated names, Dockerfile in
   bun, `ci-bun.yml`, pm2 out of `deploy.yml`, `dependabot.yml`, five docs pages, gates, then a
   commit split into substance and a separate oxfmt reformat. MiGallery owes npm->bun, an audit of 17
   scripts, 68 lucide icons, Tailwind PostCSS->Vite, oxlint/oxfmt/oxvelte, TS 7, 4 vulnerabilities,
   the duplicate `.eslintrc.json`+`eslint.config.js`, a pending `code-analysis.yml` and a harmonised
   `dependabot.yml`. le-cercle owes oxlint/oxfmt/oxvelte, TS 7 (fix the `^6.0.3` caret) and
   Dependabot on GitLab.

**ONE-OFF ACTIONS GO TO THE USER** (2026-08-25): *"Pour les choses qui ne se font qu'une fois, tu peux
me demander de les faire hein."* Building a tool for a single click is that waste - see item 3.

**A DELETED GROUP IS TWO ESTATES**: `cleanup.mjs` owns the server side, `dismiss.mjs` the copy each MEMBER's client keeps (W1 clean at 9 rows on 2026-08-24, W2 holding 189). One allowlist for both, `debris.mjs`. Detail on [cross-client-campaign](docs/wiki/cross-client-campaign.md).

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

**Google Play, both mails of 2026-08-26, are worked; TWO items will never clear, ONE is decided but
not built, TWO wait on YOUR signal.** Shipped: the four pre-launch recommendations, and the
device-to-device transfer the app was never excluded from. Unclearable: two deprecated-window-API
sites, inside the `enableEdgeToEdge()` Play itself asks for and inside play-services-base. Every
threshold is measured on
[mobile](docs/wiki/frontend/mobile.md#plays-q3-2026-quality-requirements-measured-against-this-app),
the only copy; the 28-day memory P90 does not exist yet, so read Android vitals from late September
2026. **WP-RESTORE-1** (Zero-Tap Sign-In, required April 2027): principle ACCEPTED by the user
2026-08-26, scheduled AFTER the campaign, NOT to be re-opened - the build is WebAuthn on a server
that has none ([backlog](docs/wiki/backlog.md)). **Waiting on the user:** a `workflow_dispatch` of
`android-release.yml`, authorised but *"attends mon signal"* - it yields the SIGNED APK check R
needs and publishes nothing to Play (that step is gated on `workflow_run`); and the release carrying
today's two Android fixes, deferred past the campaign, so the transfer refusal reaches nobody yet.

**Release status:** v0.14.4 cut 2026-08-24, every platform green including TestFlight - the iOS path
ran end to end for the first time and nothing there is owed any more (story in `CHANGELOG.md`).

`minClientVersion` still lives in `platform_config` and is still raised BY HAND from
`/admin/platform`, so no deploy touches it - and **half the old gap is closed, half is not.** A release
can now REACH App Store Connect, never proven before; but TestFlight is the BETA channel, so nothing
yet shows a build reaching an ordinary iOS user. Ship the client, verify it arrived, THEN raise
([legacy-compatibility](docs/wiki/legacy-compatibility.md)).

### CANARI - the test campaign

Four files, four jobs, all in WHERE THINGS LIVE above: board = state, campaign page = design,
methodology = how a result earns belief, README = operating manual. **Read them rather than re-deriving
state here, and keep no second copy.**

**The rig lives in the repo at `tools/cross-client-harness/`; its STATE lives outside at
`../canari-harness`** - `test-accounts.json`, the debug APK, A1's baseline, `results.ndjson`, and
`chrome-w1` / `chrome-w2`, which ARE the W1 and W2 devices. Losing a profile costs a re-enrolment and
SETUP-4's 2FA, the one step no tool here can answer. Outside the work tree a credential CANNOT be
committed and `git clean -xdf` cannot reach a profile.

**MUT-20 is unarmable until a campaign message reaches 90 days** (earliest 2026-11-09).

**A1 IS BACK** (user, 2026-08-26: *"J'ai remis le telephone si besoin"*), after a pause the same day -
so `+A1` and `+push` rows run again, COMM-18 included. **TAB-7 is the row to watch**: offline -> act ->
online with no reload is exactly the trigger DEL-10 says nothing honours.

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
