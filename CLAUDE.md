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
| The cross-repo convergence plan, repo by repo | [ecosystem-convergence.md](docs/wiki/ecosystem-convergence.md#11-the-cross-repo-convergence-plan-repo-by-repo) |

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
- ONE-OFF ACTIONS GO TO THE USER (2026-08-25): *"Pour les choses qui ne se font qu'une fois, tu peux me demander de les faire hein."* Building a tool for a single click is that waste.
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
    had no runner, written as the ladder reaches them. **Every verdict, every cause and the format of
    a cell are on [cross-client-testing](docs/wiki/cross-client-testing.md); design, cost and the
    decisions the dirt turns on are on
    [cross-client-campaign](docs/wiki/cross-client-campaign.md). Neither is restated here.**

    **THE USER'S PRIORITY, 2026-08-27, verbatim: *"PASS ou PASS-DIRTY sur COMM, DEL, MULTI, LIFE,
    NOTIF, HEAL."*** Those six ARE the target; TAB, CALL, PIN and CORRUPT come after them, and
    nothing else is worth a token until those six are green.

    **Where the ladder stands: rungs 1-10 TAKEN, 12 MULTI MEASURED.** **DEL is the first rung with NO
    `FAIL`** (4 `PASS` / 5 `PASS-DIRTY` / DEL-9 `VACUOUS`, on `0c31be5d`), and **both of its non-passes
    were HARNESS faults, now fixed** - the causes are on the board, in DEL-7 and DEL-9. MULTI's only
    product-shaped cell is MULTI-5 `ERROR` (a second tab, PIN-gate hypothesis UNPROVEN). **What is owed
    next: every DEL and MULTI cell was taken on a runner that has since CHANGED** (`del.mjs` is now
    `2dd7a0f4a933`, `multi.mjs` `74bb17b8283f`) - `rows.mjs` names them, and those re-runs come before
    LIFE. DEL-10 passed where it FAILed on `2a4297cb`, and **its P2 is NOT closed**: nothing names what
    changed, and the old FAIL measured a queued SEND where this one measured a queued EXIT.

    COMM's last full run (2026-08-27, `cb967b6c`) is
    15 `PASS` / 5 `PASS-DIRTY` / 3 `VACUOUS` / 1 `FAIL`. **The `FAIL` is COMM-8 and its cause is
    found and FIXED** - an external join was durable on the SERVER and volatile on the CLIENT, so a
    reload in the gap rejoined and FORKED the group (four groups in that one rung; story in
    `CHANGELOG.md`, rule in `durable-rules`). COMM-11's remaining dirt is the same signature.
    **COMM owes ONE re-run**, and it also owes the proof WP-REGRANT-2 wants.

    **A1 IS ARMED** - Pixel 6a, `adb devices` = `device`, `isKeyguardShowing=false`, and
    `node phone.mjs 9333` (ONE positional port, NOT `--ensure`) returned `ok:true` on 2026-08-27. So
    the four `+A1` rows (COMM-14/17/18/25, still on `6808a89c`) run this time. It carried DEL-7 to its
    first `PASS` (group reached A1 in 147ms, purged on wake, converged in 0ms). **A dead `adb devices`
    is not always the cable:** it was empty until the user re-plugged, and the `A1_WIFI` fallback
    needs a prior `adb tcpip 5555` it did not have.

    **A `PASS-DIRTY` NO LONGER STOPS A RUNG BY ITSELF (user, 2026-08-25)**, and **a x5 sweep of the
    WHOLE ladder accepting nothing short of `PASS` comes AFTER the campaign reaches the bottom (user,
    2026-08-26)** - until then one pass per rung is the target. **What is left is a WRITING job as
    much as a running one:** only CALL, CORRUPT and PIN have NO runner at all.

    **THE COMM-8 FIX IS PUSHED** (`01725cda`, 2026-08-27), so the re-run measures the right build
    once CD has deployed it - **and CD's colour is not the deploy's verdict, so read the SERVED
    artefact.** Getting it there cost four failed pushes, all `fatal: unable to access ...: Empty
    reply from server` (exit 128) while `git fetch` succeeded every time; the fifth, carrying
    `http.version=HTTP/1.1` **and** `http.postBuffer=524288000`, went through. **ONE SUCCESS DOES
    NOT SAY WHICH KNOB DID IT, or whether either did** - the failures were not reproduced against a
    control, so treat those two flags as a thing to TRY on the next `Empty reply`, never as the
    known fix. `http.sslbackend` is `schannel` and no proxy is set. A push takes minutes because
    the pre-push hook runs the frontend gates: **background, always.** And `git push ... | sed >
    log; echo $?` REPORTED SUCCESS ON A FAILED PUSH - the documented masking hazard, hit again:
    redirect, never pipe, then read `$?`.

    **A KILLED RUN CAN DESTROY A MEASUREMENT SECONDS FROM BEING RECORDED**, and **`node rows.mjs`
    SETTLES WHETHER THE BOARD STILL MATCHES THE LEDGER - run it before believing a cell**
    ([testing-methodology](docs/wiki/testing-methodology.md), the only copy). It caught the board
    over-claiming a SECOND time on 2026-08-27: eight COMM cells written `PASS` on a build those rows
    had never run on. The shared venue is `fbddc890` / `general` `064ac7d2`, rebuilt 2026-08-26 after
    a THIRD disappearance, cause unrecorded.

2. **DEFERRED PAST THE LADDER - seven UX and rendering items, substance in
    [backlog](docs/wiki/backlog.md) and NOWHERE else**, named here only so none is forgotten: the
    POSTS search that loads the whole base; the EMOJI picker that neither scrolls nor stays on
    screen; HEAL's partially-restored old client; **ONE BUNDLED EMOJI FONT everywhere** (Noto Color
    Emoji, decided 2026-08-23, owing ELEVEN rows to the SECOND campaign); the dead row a deleted
    group leaves every other member; the trash and the pencil on a device row not reading as the same
    kind of control; and a MENTION rendering as its raw `@[uuid]` token (NOTIF-13 pins it). The
    emoji, the dead row and the device controls want ONE pass over `app.css`, not seven local
    patches.

3.  **THE SFU RUNS SIX webrtc MAJORS NOBODY HAS PLACED A CALL ON.** `apps/call-service` compiles,
    clippy is clean under `--all-features` and its ten tests pass - none of which runs the ICE stack.
    The CI hole that let two breaking Dependabot majors merge green is CLOSED (no crate in this repo
    is uncompiled now), and the one known behaviour change is handled: an empty TURN credential used
    to degrade quietly and now fails the whole ICE configuration. **What settles it is ONE relay-path
    call**, which is rung 15 CALL and has no runner. Substance in [backlog](docs/wiki/backlog.md),
    story in `CHANGELOG.md`; neither is restated here. **A release must not carry this unplaced.**
4.  **`purge-devices.mjs` WOULD DELETE THE PHONE - a destructive control keyed on a string the
    product never renders.** **Do not run it until it takes an `--only` allowlist**; repair and
    evidence in [backlog](docs/wiki/backlog.md).
5.  **ONE NAMED STARTING POINT FOR EVERY PHASE, STEP AND STEP GROUP** - asked by the user 2026-08-25
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

**NOT TO BE RELITIGATED:** bun 1.4.0 is the runtime everywhere it can be AND lockfiles stay at v1
(independent facts; the invariant is enforced by `Guard the bun lockfile version` in
`code-analysis.yml`, never by pinning a toolchain, because a pin never governed a contributor's own
bun); **TS 7 IS REFUSED ON CANARI** and `dependabot.yml` ignores its majors, or
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
rather than re-deriving it**, which is what made this paragraph wrong twice. What is left is
JUDGEMENT, not migration, and it is three items: MiGallery's 88 lint warnings (section 11 names the
two that must not be swept); the `resolve()` question three repos now park differently -
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

**Release: v0.14.5, live on Play production at full rollout, nothing owed there.** What IS owed is
one iOS proof: `minClientVersion` is raised BY HAND from `/admin/platform`, and while a release can
now REACH App Store Connect, TestFlight is the BETA channel - nothing yet shows a build reaching an
ordinary iOS user. Ship the client, verify it arrived, THEN raise
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
