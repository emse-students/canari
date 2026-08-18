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
| Wanted but not scheduled | [docs/wiki/backlog.md](docs/wiki/backlog.md) |
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
- COMMIT IN THE BACKGROUND: the pre-commit hook sweeps the WHOLE frontend (2-3 min) and re-stages it. Isolate unrelated dirty files first. `rm -rf apps/*/dist` before `git push`.
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
| **MiGallery** | `../MiGallery` | COMPLETE but for one follow-up: its search is still plain substring. The user's standing requirement is that **every search box across the ecosystem tolerates typos and word inversion and ranks by edit distance** - done in Sky (`personMatchScore`) and in Canari (`applyFuzzyNameSearch`, pg_trgm + unaccent), never started there. |
| **Portail-etu** | `../refonte-portail-etu` | COMPLETE. **No SSH to that box** - the self-hosted CD runner is the only way in; `deploy.yml` has a `workflow_dispatch` (a dispatch can 500 while STILL creating the run - check `gh run list` before re-dispatching). PUBLIC, so every run log must redact and `grep -a` is mandatory. `pm2 flush`, never `rm`. `data-export/` holds PII, never commit. |
| **Le Cercle** | `../le-cercle`, `gitlab.emse.fr:aurel.dautry/le-cercle` | Aurel's repo, but the rewrite is MERGED and we hold push rights now. See below. |

Work is tracked as Work Packages by severity: **P1** (security, or a broken user-facing path), **P2**
(correctness), **P3** (hygiene). Delete a WP outright once it ships. Everything wanted but NOT
scheduled is [backlog](docs/wiki/backlog.md) - file it there, never here.

### CANARI - THE QUEUE, IN ORDER

The user's decision of 2026-08-16 is that **every one of these lands before the campaign restarts**.
Work them top-down; each is one item, and an item is not done until its code, its tests, its doc and
its commit are in. The detail lives where the link says - **do not restate it here.**

**THE PHONE IS BACK (2026-08-17, the user) - nothing is on hold.** The campaign needs it; keep
`adb devices` answering. **There is NO iPhone (the user, 2026-08-18)**, so the iOS half of the
device ladder cannot be run at all - written up as such on
[device-verification](docs/wiki/device-verification.md) rather than left looking pending.

1. **`deleteWorkspace` really deletes** (decided 2026-08-18), behind an explicit confirmation -
   typing the community name. The durable-delete code has existed since WP-01; what is new is
   turning a reversible control irreversible, so the confirmation is part of the work, not a
   follow-up. See [backlog](docs/wiki/backlog.md).
2. **THE ADMIN ANNOUNCEMENT** (new, the user, 2026-08-18): a place in `/admin/platform` to publish a
   message shown ONCE PER ACCOUNT at the next app opening, on whichever device gets there first -
   so the "seen" state is server-side and survives a reinstall. A centred modal closed by a button,
   French and English both entered, one active announcement at a time, with an OPTIONAL client
   version range so "what changed in 0.15" reaches only those who have it. Scoped in
   [backlog](docs/wiki/backlog.md).
3. **MiGallery's fuzzy search** - the last of the four projects still on plain substring matching,
   against the user's standing requirement. In scope, decided 2026-08-18; port Canari's pg_trgm +
   unaccent approach or Sky's `personMatchScore`, whichever fits what that repo has.
4. Campaign leftovers: the five attributed residue rows on W1, then `openDM`'s full reload for the
   browsers.
5. **THEN, and only then:** rebuild the Android APK once, then run the clean campaign. **Everything
   must end green, so every phase runs** - and the board says what that really costs: MSG is the
   ONLY phase standing on a current build, TYPE/READ/MUT/FWD owe re-runs on an older one, and
   **twelve of the eighteen have never run at all**. CALL is 20 checks with **zero scripts
   written**, and **`call-service` gets its server-side logging FIRST** (decided 2026-08-18:
   invite, answer, ICE, hangup, duration) - a call failure two clients each see half of cannot be
   attributed without it, which is exactly what caught the silent channel-push 404s. Sequence and
   per-check state live on [cross-client-testing](docs/wiki/cross-client-testing.md) - the only
   copy of the ladder's order. **The whole community rework is verified by COMPILING and by unit
   tests only** - nothing has run against prod, no client has joined a distribution group on a real
   deploy, no notification has been decrypted from a Graine seed on hardware. Those are WP-62's
   rows, and this is where they run.

### CANARI - what is open

**Owed on the prod host, once the deploy that removes `mongo` has answered: delete the container
and `docker volume rm infrastructure_mongo_data`** (479 MB of MongoDB system files - the instance
never held an application database, checked twice). The compose files no longer declare it, so the
deploy stops it; the volume outlives a `compose down` and has to be named.

**Owed cleanup: remove the orphaned `minio_data` volume after 2026-08-28** (14-day rollback window
after the Garage migration - see [docker](docs/wiki/infrastructure/docker.md)). **And delete the
`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` repository secrets once a dev deploy has answered** - the
Garage rename (2026-08-18) removed the last thing that read them, `cd-dev.yml`, which had been
demanding them for a service stopped on 2026-08-14.

**Release status:** v0.14.0 cut 2026-08-17 (tag + `gh release create`, which drives the version bump,
the mobile builds and the deploy - `cicd.md`); both CD runs and the AppImage build green. Prod
VERIFIED answering `{"version":"0.14.0","minClientVersion":"0.14.0"}`. **The user raised
`minClientVersion` to 0.14.0 by hand at 10:49**, from `/admin/platform` - it lives in
`platform_config`, never in the code, so no deploy touches it. The Play Store serves 0.14.0; **the
App Store half was never verified, so the raise locks out any iOS user it has not reached.** The
shipping order this violated is written down for next time: publish -> VERIFY the store serves it ->
only THEN raise ([legacy-compatibility](docs/wiki/legacy-compatibility.md)).


### CANARI - the test campaign

Three files, three jobs, no overlap: **[cross-client-testing](docs/wiki/cross-client-testing.md)** is
the board (state only - every check, its verdict, the commit it ran on);
**[cross-client-campaign](docs/wiki/cross-client-campaign.md)** is the design (the ladder, the scope,
the standing rules, the preflight, the negative rows, the debris cleanup);
**[testing-methodology](docs/wiki/testing-methodology.md)** is how a result earns belief (nineteen
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

