# CI/CD pipeline

Canari uses GitHub Actions for continuous integration and deployment. The pipeline lives in `.github/workflows/`.

## Workflows

### Package 1: opening a pull request (`ci.yml`)

**THE PIPELINE IS TWO PACKAGES, ONE PER HUMAN GESTURE** (user, 2026-09-03: _"Je veux une suite
d'evenements et d'etapes"_). This file is everything that happens when a pull request is opened;
`release.yml` is everything that happens when a release is published. There is no third file,
because a merge deploys nothing.

**It was `ci.yml` and `auto-merge.yml` until 2026-09-03** - two files listening for the SAME
`pull_request` event and never referring to each other, so the sequence a human wants to read was
split in half. The order, which the file's own header states:

| #   | job                  | what                                                                                                                                                                                       |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `changes`            | reads the modified paths and decides which of the jobs below run at all                                                                                                                    |
| 2   | the test jobs        | Rust, the four NestJS apps' real AppModule, TS, social-service's and chat-delivery's integration specs on a real PostgreSQL, frontend, the two self-test suites - in parallel, each behind its own path filter |
| 2b  | `dependency-ceiling` | ONLY on a Dependabot pull request: does a gate HERE exist that would see this update fail? A human's pull request carries no `updated-dependencies` block to decide on, so it skips        |
| 3   | `ci-passed`          | aggregates them. `success` AND `skipped` both pass. The ONE check the ruleset requires                                                                                                     |
| 4   | `arm-auto-merge`     | in **parallel** with 1-3, not after                                                                                                                                                        |

**SOCIAL-SERVICE'S `*.integration.spec.ts` RUN IN CI SINCE 2026-10-15** (`test-social-integration`,
a job in this file, not a fifth visible workflow). Each spec is gated on `SOCIAL_IT_DATABASE_URL`
and reports SKIPPED without it - and until that day nothing set it, so every one was skipped on
every pull request and `CI passed` was green for the reason that they had not run. The day the job
was written, the migration 082 spec turned out to have failed on EVERY run since its merge (#1913).
The job runs them in band against production's PostgreSQL, pinned by the digest the compose files
carry, and its last step FAILS unless jest ran as many suites as there are files on disk and skipped
none: a jest run that selects nothing is no longer a pass (the `test` scripts lost `--passWithNoTests` in WP-T2), but a gate that selects by name still needs its own count of what ran.
**Every integration spec has a 60 s budget per test and hook, set once** by
`apps/social-service/jest-integration-budget.cjs` (selected by the same file name), not jest's 5 s:
a spec builds its schema in `beforeAll` on a server that may have just started, and on a fresh
container that took 0.17 s to 4.5 s (45 cold starts, 2026-10-22) - past 5 s every test of the file
fails as a hook timeout. A test needing more still names its own budget.
**Since 2026-10-21 the same job runs a REDIS too** (production's digest; `SOCIAL_IT_REDIS_URL`), for
`lives/live-seats.spec.ts`, selected by name and counted by the same check: its real-Redis half (the
viewer cap's atomicity, a live's viewer count, a seat's expiry) had been skipped on every run before.
`ci-passed-gate.test.mjs` asserts the image, the variable and the selection, and that every Redis
`ci.yml` runs is production's.
**CHAT-DELIVERY-SERVICE GOT THE SAME JOB ON 2026-10-22** (`test-chat-delivery-integration`,
`CHAT_DELIVERY_IT_DATABASE_URL`, same digest, same no-skip count), written with migration 034
([chat-delivery](services/chat-delivery.md#a-key-group-frame-is-stored-once-migration-034-2026-10-22)).
It also runs `seat-lock.integration.spec.ts`, the seat lock's orderings - a claim, an eviction, a
route and a send's queued rows against one per-group advisory lock - which no fake can judge
([channel-encryption](protocols/channel-encryption.md)). The gate test asserts its image, its
variable and its skip check.
**ONE spec is excluded from it, by name in both steps: `internal/account-erasure.integration.spec.ts`**,
which copies every social table out of `public` and so needs the schema `synchronize` builds; it runs
in `boot-nest-apps` right after the boot built that schema (2026-10-17, found by rebasing on the
merged account erasure: on this job's empty database it failed with "no table ... in public").
`ci-passed-gate.test.mjs` holds the rest - every job is a need of `ci-passed`, `ci-passed` keeps
`if: always()`, the aggregation refuses `failure` AND `cancelled` (run, not read), and the job's
image equals production's.

**`arm-auto-merge` HAS NO `needs:`, AND THAT IS DELIBERATE.** `--auto` hands the decision to
GitHub, which merges the instant the required check passes and never before, so arming is a
declaration of intent rather than a verdict. A job that waited for the suite would hold a runner
for its whole length and would still have to re-read the checks at the end - and a job that merges
on its OWN reading of "green" is a second opinion about which jobs matter. Measured: #332 sat armed
for the ten minutes its suite took, and merged the moment `CI passed` concluded.

**THE CEILING IS A CHECK SINCE 2026-09-03, AND THAT IS ONE HALF OF ONE MECHANISM FOR EVERY PULL
REQUEST** (user: _"le auto-merge et les CI doivent considerer toutes les PR, les miennes ou
dependabot"_). It was asked only inside `dependabot-auto-merge.yml` - a SECOND merge mechanism
beside GitHub's own auto-merge, so a Dependabot pull request and a human's took different routes to
`main`. **#309 is the case**: `postgres 15-alpine -> 18-alpine`, fully GREEN, correctly refused,
open for days.

**AND IT CORRECTS WHAT THIS PAGE FIRST SAID.** The refusal was NOT "recorded nowhere on the pull
request" - the sweep posts a `github-actions` comment naming the exact missing test, and it is a
good comment. What a CHECK adds is narrower and still worth the change: **a comment is ADVISORY.**
It is absent from the checks list, which is where a reader looks for what blocks a pull request; the
merge machinery cannot read it, so anything that armed GitHub's auto-merge would merge straight past
it; and it sat outside `ci-passed`, the one check the branch ruleset requires. Feeding `ci-passed`
is what makes the refusal BINDING - an update with no gate cannot merge by any route, armed or not.
**Measured on the rebased #309: `Dependency ceiling -> FAILURE`, then `CI passed -> FAILURE`.**

**STAGE TWO LANDED THE SAME DAY, AFTER THE BINDING HALF WAS OBSERVED and not before.** The order
was not a preference: arming a pull request whose ceiling refusal was not yet a required check
merges `postgres 18` on a green suite, which is exactly the 33 minutes of 2026-09-01. The
observation that unlocked it was `@dependabot rebase` on #309 - the only way a new job can reach an
existing pull request, since it is gated on `pull_request` - giving `Dependency ceiling -> FAILURE`
and then `CI passed -> FAILURE`.

**SO THE SWEEP ARMS AND NO LONGER MERGES**, and three things went with the merge:

| Gone                           | Why it existed                                                                      | Why it is gone                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ~200 lines counting check-runs | to decide "is it green"                                                             | a SECOND OPINION about which jobs matter. `CI passed` is the ruleset's answer and is now the only one |
| `gh workflow run ci.yml`       | a `GITHUB_TOKEN` merge raises no `push`, so the merged combination was never tested | the App-token arming makes the merge raise it, exactly as for a human's pull request                  |
| the ceiling, and its comment   | to refuse what CI cannot judge                                                      | it is a binding CHECK now, and the annotation carries the same text the comment did                   |

**THE IDENTITY IS THE ONLY SILENT-WHEN-WRONG PART.** Auto-merge merges as whoever ARMED it, so a
`GITHUB_TOKEN` arming would raise no `push`, leave `main` without a `CI passed` check, and make
`release-preflight.sh`'s third gate refuse EVERY release - from a file that has nothing to do with
releasing. Four assertions hold it, two of them mutation-proved against exactly that swap.

**WHY THERE ARE TWO ARMING POINTS RATHER THAN ONE**, which is the one thing the "single mechanism"
goal does not get: **a `pull_request` run from Dependabot has no access to secrets** - GitHub runs
it as if it came from a fork - so the App token cannot be minted in `ci.yml` for those.
The sweep runs on `workflow_run` and a schedule, in the default-branch context where secrets exist.
One merge mechanism, two arming points, and the split is forced by where secrets live.

**AND THE SWEEP STILL HOLDS TWO PROPERTIES NOTHING ELSE DOES**, which is why deleting the file was
never the plan: CONVERGENCE (it enumerates every open Dependabot pull request, so the correct state
is reached from any starting state - seven mergeable green pull requests sat untouched on
2026-08-31 because an event-only automation acts on what it happened to catch) and STALENESS
(`lib/gate-moves.sh`, and asking Dependabot to rebuild a branch whose gates moved - the one thing
GitHub's auto-merge does not do, since it re-evaluates when the PULL REQUEST changes and never when
the BASE does).

**CLOSING A DEPENDABOT PULL REQUEST SUPPRESSES THAT VERSION, NOT THAT PACKAGE AND NOT ITS GROUP -
MEASURED 2026-09-18.** The question mattered because nine NestJS 12 pull requests were closed in ONE
batch on 2026-08-31, destroying the control case the plan had asked for (close ONE first, watch what
comes back). The answer arrived on its own: `@nestjs/schematics` 11.1.0 -> **12.0.0** was among the
closed singles (#266, #281), and when **12.0.1** was cut Dependabot proposed it again - #663 and
#666, opened and merged 2026-09-14. A closed pull request tells Dependabot "not this version";
the next version of the same package is a new proposal. **So a batch close costs nothing but the
measurement it destroys**, and the `openmls` four that were being held as a second control case are
moot: that train went in by hand as #680 on 2026-09-15, with the forward-compat gate that let it
merge.

**AND THEN STEP 6, WHICH IS WHY A RELEASE IS POSSIBLE AT ALL.** GitHub squash-merges, deletes the
branch (`delete_branch_on_merge`, set true on 2026-09-03; `--delete-branch` was passed until then
and did nothing, `gh` performing the deletion after a merge IT made and `--auto` making none, so
the flag is gone and the setting is inventoried in `infrastructure/MIGRATION.md` section 3bis with
`allow_auto_merge`, without which nothing arms at all), and
the merge raises a `push`, so this same file runs again on the merged `main`. That run is what puts
the `CI passed` check ON the commit of `main`, and `release-preflight.sh`'s third gate reads exactly
that check. An App token raises that event; `GITHUB_TOKEN` does not - so arming with the default
token would refuse every later release, from a file that has nothing to do with releasing.

Runs on every pull request to `main`, and again on every push to `main`:

| Job                  | What it checks                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rust tests**       | `cargo test` across all crates (`chat-gateway`, `call-service`, `mls-core`)                                                                                       |
| **TypeScript tests** | for each of the four NestJS services: `lint`, `format:check`, `typecheck`, `build`, `test`                                                                        |
| **Frontend tests**   | `vitest` in `frontend/`                                                                                                                                           |
| **Frontend lint**    | `oxlint` + `oxvelte` + `oxfmt --check` + `svelte-check` (0 errors required)                                                                                       |
| **Build**            | the generated sources first - [`.github/actions/build-mls-wasm`](../../.github/actions/build-mls-wasm/action.yml) then `bun run proto:gen` - then `bun run build` |

**THE HARNESS SELF-TESTS ARE TRIGGERED BY THE APP'S MESSAGE FILE TOO, AND FOR TWELVE DAYS THEY WERE
NOT.** `changes` said the rig "reads its own sources and nothing else", so `tools/cross-client-harness/`
was the whole trigger. Two of those self-tests read the APP: `caption-selftest` resolves every
Paraglide key the rig spells against `frontend/messages/fr.json`, and `selector-selftest` imports
`frontend/src/lib/styles/markupSources.ts`. Both exist to catch a renamed key - so the one pull
request they had to run on, the one doing the renaming, is the one they were skipped on. #1006
rebuilt the poll composer, `channel_poll_add_option` and `channel_poll_option_placeholder` went
with it, and the rig could not compose a poll until 2026-09-24, when an unrelated workflow edit
made CI run everything and said so. The trigger now names the two app paths those tests read.

**`typecheck` IS A SEPARATE STEP FROM `build`, AND THE DIFFERENCE IS THE TESTS.** `bun run build`
is `nest build`, which reads `tsconfig.build.json`; every service excludes `*.spec.ts` there. Jest
does not make up the difference - ts-jest transpiles without checking once `isolatedModules` is
set, which all four set - so until 2026-09-24 a service's own tests were typechecked by NOTHING
before the merge. One thing did check them, by accident:
`infrastructure/local/Dockerfile.social-service` compiled `tsconfig.json` where its three siblings
compile `tsconfig.build.json`. That is a gate on the wrong side of the merge. A type error in a
poll spec merged with #1006, `CI passed` went green on it, and the first thing to notice was the
`v0.18.22-alpha.1` release, whose `social-service` image build failed and stopped the pre-release.
The Dockerfile now matches its siblings, and `bun run typecheck` (`tsc -p tsconfig.json --noEmit`)
runs in CI for all four - unguarded, because a service that forgot the script is the very hole.

**The generated sources are not in git** (`frontend/src/lib/wasm/`, `src/lib/proto/canari.{js,d.ts}`),
so EVERY pipeline that ships a client builds them: `build.yml`, the three release workflows, and
`ci.yml` because the gates import them. One composite action, one pinned
`wasm-pack`, one cache key over `mls-wasm/**` + `mls-core/**` + `rust-toolchain.toml` - the
committed binary went a crypto fix stale precisely because only some pipelines rebuilt it
([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)).

**The second trigger is what makes a merge on `main` mean something.** A pull request is tested
against its own head, so two pull requests that each pass can still break `main` between them; the
push run is the one that says whether the merged result is green. It also covers what a required
check cannot - an admin bypassing the ruleset for an emergency hotfix still gets told, on `main`,
what the bypass skipped. **THE `push` RUN ALSO BUILDS THE PRODUCTION FRONTEND, ONCE (2026-10-06)**:
the suite lints, type-checks and tests but built nothing, so the build-id defects of #1476 and #1498
(a bundle naming no commit, two ids in one output) showed only at a release tag. The
`test-frontend` job runs `BUILD_WEB=1 bun run build` on `push` only - pull requests skip it for cost -
then `.github/scripts/assert-frontend-build.mjs` checks the stamp names THIS commit and that the wasm
and protobuf module are in; `assert-frontend-build.test.mjs` pins each refusal and that `ci.yml`
calls it. The release does not reuse the artefact: each estate bakes its own `VITE_*` origins in
(`build.yml`), which `main`'s build has none of. **Nothing here deploys**, so a red run on `main` is a statement about the
repository and never about production, which is still serving the last release.

### Build and deploy an estate (`build.yml`, `serve-dev.yml`, `serve-prod.yml`)

**IT HAS NO TRIGGER AT ALL: it is `workflow_call` only, and `release.yml` is its one caller**
(user, 2026-09-02: _"Le deploiement (production, android, ios...) se fait au bump. Pas au push sur
main."_). A push to `main` deploys nothing, and there is no `workflow_dispatch` either - a dispatch
would simply be a second door. Retrying a half-failed deploy is "Re-run failed jobs" on the release
run that already exists.

**IT IS THEREFORE A JOB OF THE RELEASE RUN, WHICH HAS ONE CONSEQUENCE WORTH KNOWING:**
`gh run list --workflow build.yml` returns NOTHING. A called workflow's jobs belong to the caller's
run, so the run to read is the `Release` one, and the harness's `deploy.mjs` names `release.yml` for
that reason.

**WHICH ESTATE IS DECIDED BY THE RELEASE, NOT BY A BRANCH, AND NOT BY THIS FILE EITHER.** It is
told, as three inputs - `sha`, `version`, `prerelease` - resolved ONCE by the caller's `preflight`
job. Until 2026-09-03 it read `frontend/package.json` back off a checkout and decided for itself,
which is how three chains came to each re-derive the same fact:

| The release                     | What is deployed                                                    | Image tag it moves |
| ------------------------------- | ------------------------------------------------------------------- | ------------------ |
| `v0.15.0-alpha.1` (pre-release) | `dev.canari-emse.fr`, plus the Play _internal_ track and TestFlight | `:dev`             |
| `v0.15.0` (stable)              | production, deployed BY `:v0.15.0`                                  | `:latest`          |

1. `enumerate-services` names all eight services (no diff: every service is built every release)
2. Builds the frontend against that estate's `VITE_*` set, then every image → GHCR, each tagged `v<version>`
3. Self-hosted runner: sync `.env`, `docker compose pull`, then every service replaced one at a time by `infrastructure/lib/rolling.sh` ([below](#a-deploy-replaces-nothing-a-member-is-talking-to)) - production by `--tag v<version>`, so re-running an old release's deploy is a ROLLBACK
4. Database migrations, then health checks
5. MiConnect's blueprints: a pre-release DRY-RUNS them against the production MiConnect, and a
   stable APPLIES them before `prod-released` moves. The same runner lives on MiConnect's host, so
   `apply-blueprints.sh` reaches the worker container directly. The fresh-instance gate before both
   is the CI job `test-miconnect-blueprints` ([authentik](infrastructure/authentik.md#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30)).

**THE CALLER DECIDES, ONCE, AND A HYPHEN IS STILL THE DEFINITION.** The reason this used to be
read out of the manifest here is worth keeping, because it explains what NOT to go back to:
`github.event.release.prerelease` does not exist in a `workflow_run` context - the event was the
bump run's completion, not the release - and `workflow_run.head_branch` carried the tag for a
release-triggered bump but said `main` when the bump was dispatched by hand, which would silently
have sent an alpha to production. So the manifest was the only honest source available _to a
workflow woken by another workflow_. Now that all three arms are CALLED, the honest source is the
caller: `release_kind()` in `.github/scripts/lib/release-preconditions.sh` answers stable-or-
prerelease once, off the version being released, and the same answer reaches the estate, the Play
track and the App Store channel. A hyphen in a semver version IS the definition, and there is now
exactly one implementation of that sentence.

`GITHUB_TOKEN` pushes from the version-bump workflow do **not** trigger `on: push`. CD is chained via `workflow_run` instead (no `branches:` filter — GitHub would silently drop release-triggered parents).

#### There is no baseline: every service is built every release, and production deploys by `v<version>` (2026-10-06)

The change detector (a baseline = the previous release of the same kind, a diff, a path-to-service
map) was deleted on 2026-09-03 because it saved nothing a release waits for and its failure mode was
silent. Eight images, three tags each (`<sha>`, `v<version>`, and the estate's moving tag), every
release. **That is what makes a rollback real**: production is deployed by `--tag v<version>`, which
exists for every service, so re-running an old release's `Deploy to Production Server` puts THAT
release back. It used to deploy `latest`, and v0.16.1's rerun redeployed v0.16.4 while passing twenty
steps (2026-09-06). `release-chain.test.sh` pins the pair; the GHCR prune keeps 30 pushes.
A rollback does not revert a migration the newer release applied: read it before rolling back across one.

**`prod-deployed` is gone, and its replacement answers a different question.** That tag was the
change detector's INPUT; the detector reads releases now, so the tag survives only as `prod-released`

- the record of which commit production is serving, written by the deploy that made it true. The
  user took that deletion knowing its cost: **after an emergency push straight to `main`, nothing says
  which commit production is running** until the next release.

#### A deploy replaces nothing a member is talking to

**The defect (backlog P1, 2026-10-09):** a tab or app open across a production deploy got `502` for
the 1-2 minutes it took, and a send in that window showed "Échec de l'envoi". Two causes, both read
from the code: ONE `docker compose up -d` recreated every service whose image changed - and every
image changes every release - each one stopped BEFORE its successor started; and every service ran
as PID 1 with no `SIGTERM` handler, so each stop waited out the 10 s timeout and then killed whatever
was in flight. Nothing in the four visible workflows changed: the whole fix is inside the deploy
library's script, `infrastructure/deploy/deploy-environment.sh`.

**How a release replaces a service now** (`infrastructure/lib/rolling.sh`, one service at a time,
in `depends_on` order):

1. `up -d --no-deps --no-recreate --scale <svc>=2` starts the NEW replica beside the old one.
2. Wait for its healthcheck (`start_interval: 2s`, so a ready replica is seen in seconds, not at the
   next 30 s tick). An unhealthy replica is removed and the deploy STOPS - the old one never stopped
   serving (measured: 0 failed requests across a refused release).
3. Wait out the Docker DNS lifetime nginx caches (`ROLLING_RESOLVER_TTL_SECONDS`, 2 s, plus one), so
   every proxy has seen the new address.
4. `docker stop` the old replica: its `SIGTERM` handler closes the listener, answers what is in
   flight, exits (`drain-on-sigterm.ts` in the four NestJS services, `serve_until` in the gateway).

**Every service declares how it may be replaced**, as the label `canari.deploy.replace`, and
`infrastructure/lib/replace-modes.py` refuses the compose file BEFORE anything changes when a
declaration cannot hold:

| Mode        | Meaning                                         | Services                                                                                            | What it requires                                             |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `overlap`   | two replicas at once, as above                  | gateway, chat-delivery, core, social, frontend-ssr, frontend                                        | no host port, no volume, a healthcheck with `start_interval` |
| `exclusive` | recreated in place - a short gap remains        | media-service (its metadata index is one JSON file on `media_meta`), call-service (rooms in memory) | -                                                            |
| `pinned`    | a third-party image, never changed by a release | postgres, redis, garage, adminer, `edge`                                                            | not an image this repository builds                          |

**THE HOST PORT MOVED TO A CONTAINER THAT NEVER CHANGES.** Two replicas cannot both bind
`127.0.0.1:8081`, so the frontend lost its port and a new `edge` service holds it: a pinned nginx in
`stream` (L4) mode whose configuration is `infrastructure/edge/nginx.conf`, mounted as a DIRECTORY
(a file mount keeps the inode `git reset --hard` replaces) and reloaded in place after each deploy. It
resolves `frontend` through Docker's DNS at 2 s and fails a refused connect over to the next address.
The frontend's own nginx does the same for the services behind it: `resolver valid=2s`,
`proxy_connect_timeout 2s`, `proxy_next_upstream error timeout`. A refused connect is retried even for
a POST, because nothing was sent. **These three numbers must agree with `rolling.sh`**, and
`deploy-replace.test.sh` fails when they do not.

**The proof is a test that sends throughout** (`.github/scripts/tests/deploy-rolling.test.sh`, a
fixture estate of the same shape): ~1500 POSTs at concurrency 12 across a release, ALL `200`, on
compose 5.5 and on 2.26.1 (the host's version); the same release done the old way, as its control,
shows hundreds of failures. A minute-boundary cron firing in both replicas was the one harmful shared-state
race found: the form reminder now claims its row with a conditional `UPDATE`
(`forms-reminder.scheduler.spec.ts` fails without it).

**What is NOT zero, said rather than hidden:**

- A request can stall up to ~2 s when a proxy still holds the retired replica's address and the
  connect times out instead of being refused (measured max 2.2 s).
- A WebSocket on the retired gateway or frontend is closed, and the client reconnects - a drop, not
  an error the member sees.
- media-service and call-service are `exclusive`: their few seconds of gap remain
  ([backlog](backlog.md)).
- A Node-to-Node call landing in a peer's drain window can still be refused (not observed).
- **The transition deploy** - the first one carrying this - moves the port from the frontend to the
  edge: about one second with nothing on `8081`. And compose 2.26 hashes a service with `depends_on`
  differently with and without `--no-deps`, so the deploy ALWAYS uses `--no-deps`; a manual `up -d`
  with dependencies on the host makes the NEXT deploy recreate `edge` and `adminer` once.
- **The first deploy carrying this costs more than that second.** The new `canari.deploy.replace`
  labels change the compose definition of `postgres`, `redis`, `garage` and `adminer`, so that deploy
  recreates them STOP-FIRST under live traffic (`redis` has no `start_interval`: `wait_healthy` can
  wait ~30 s). And the OLD frontend still runs `resolver valid=10s` while rolling.sh waits 3 s, so it
  can answer `502` for up to ~7 s per replaced service. Reasoned from how compose hashes a
  definition, not run. **The "no 502" reading is taken on the SECOND pre-release**; the first proves
  only that the edge took the port.
- The `*/5` Le Cercle webhook retry (`retryDueWebhookDeliveries`) does not claim its rows, so both
  replicas can retry in the overlap. Harmless: Le Cercle inserts with `ON CONFLICT(payment_intent_id)`,
  so no member is credited twice; only a counter update and a `[CERCLE]` line are doubled.

#### The edge is ready when it listens, not when it runs

**Found as a CI flake (2026-10-18), and it was a deploy defect.** `deploy-rolling.test.sh` failed its
first case, `v1 answers through the edge`, with `curl: (56) Recv failure: Connection reset by peer` in
**3 of 62** `Test CI Scripts` runs (jobs 117678020679, 117703956520, 117780454771; the other 59 passed
the same code). The edge had NO healthcheck, so `wait_healthy` returned at `running none` - the
moment Docker started the process, before nginx had opened port 80 - and `replace_services` handed
back an "up" estate. On Linux, Docker's port proxy accepts on `127.0.0.1:<port>` before the container
listens, fails to reach it, and closes with the request unread: a reset.

Evidence, on a Linux `dockerd` 28.5.2 (`docker:dind`, the runners' engine line): a request to a
started-but-not-listening nginx returns exactly `(56) Connection reset by peer`; `docker run -d`
followed at once by a request reset **30 times in 30**; with the healthcheck below awaited first,
**30 answered in 30**. Ruled out: the edge listening but unable to reach `frontend` gives the same
code, but `frontend` was already healthy and resolvable when the edge started (the plan replaces it
first), and the test now prints the edge's state and log on that failure, which separates the two.

**The fix is the readiness proof, in production too:** the edge's healthcheck is
`test -s /var/run/nginx.pid && grep -q ' 00000000:0050 00000000:0000 0A ' /proc/net/tcp` - the pid
file nginx's master writes after opening its listeners and installing its signal handlers (so the
deploy's `nginx -s reload` that follows has a master to reach), and the kernel's LISTEN row for `:80`,
which a stale pid file left by a killed container cannot fake. It proxies nothing: a probe THROUGH the
relay would open a `frontend` connection every 30 s. `deploy-replace.test.sh` requires prod, dev and
the fixture to carry the same test. No retry was added to the test: its single POST is the assertion.

**Cost, once:** adding a healthcheck changes the edge's compose definition, so the first deploy
carrying it RECREATES the edge on each estate - the ~1 s gap of an edge image bump, said above.

#### Every job checks out the SHA `release-kind` resolved, because `main` is a moving reference (2026-09-03)

All five jobs used to check out `ref: main`, and the comment above `CHECKOUT_REF` explained why it
is `main` and not the event's SHA — correctly, and only half the question. **`main` moves.** Five
jobs resolving it independently can resolve five different commits, and the window is not
theoretical: the bump's own push raises a `push` event (see the App-token side effect above), so
`ci.yml` is running on `main` while this workflow starts, and any pull request merged in those
minutes lands inside it.

**What made it a correctness bug rather than a race nobody would notice** is that
`release-kind.outputs.sha` is what tags the images and writes the `prod-released` / `dev-deployed`
markers. A second commit arriving mid-run would have been BUILT while the first one was RECORDED —
so the marker naming what production runs would have been wrong, with nothing anywhere disagreeing.
A recorded provenance that can be false is worse than none, because it stops the next person looking.

The commit is now resolved in the release's `bump` job and handed to every arm as `inputs.sha`.
One release, one commit, and the marker is a measurement instead of an assumption.

**AND THE CROSS-CHAIN HALF IS CLOSED TOO, since 2026-09-03.** `android.yml` and `ios.yml` used to
check out `main` by name, which was a smaller version of the same defect: a merge landing between
the two runs would ship a store bundle built from a different tree than production, and because
those workflows recorded no marker there was nothing anywhere to contradict. The fix was the one the
backlog said it needed - _deciding where the release's SHA is resolved ONCE for all three chains_ -
and the answer is `bump.outputs.sha`. `release-chain.test.sh` asserts that no arm checks out
`ref: main` and that all three receive that output, because this is a wiring property and wiring is
what a file can be read for.

#### AND IT SURVIVED ALL OF THAT ON THE OTHER SIDE OF THE RUNNER, FOR A WEEK (2026-09-10)

The 2026-09-03 fix stopped the arms resolving `main` **on the runner**. Neither estate uses
`actions/checkout` for the tree it deploys: each drives a long-lived checkout on its own box, and
both went on running `git reset --hard origin/main` there. **That tree is what production is served
from** - `infrastructure/docker-compose.prod.yml`, the nginx configuration and the migration SQL all
come from it, and only the service images come from the build.

So the marker was false in exactly the way the section above says a marker must never be. `serve-dev.yml`
referenced `inputs.sha` **twice, and both were inside the step tagging `dev-deployed`**: the only
thing the dev estate did with the commit it was handed was claim to have deployed it.

**The window is not small, and it is structural rather than accidental.** `serve-prod` needs
`[build, android, ios]`, so it waits behind the iOS build; measured on the last five releases, the
gap between the bump resolving the commit and the box resolving `main` again is:

| release                 | bump ends | box resets | gap             |
| ----------------------- | --------- | ---------- | --------------- |
| `v0.16.6` (production)  | 19:45:12  | 20:07:45   | **22 min 33 s** |
| `v0.16.6-alpha.7` (dev) | 19:29:05  | 19:35:13   | 6 min 08 s      |
| `v0.16.6-alpha.6` (dev) | 14:14:57  | 14:21:45   | 6 min 48 s      |
| `v0.16.6-alpha.5` (dev) | 01:19:09  | 01:24:34   | 5 min 25 s      |
| `v0.16.6-alpha.4` (dev) | 12:45:11  | 12:50:47   | 5 min 36 s      |

Auto-merge lands pull requests unattended throughout. Both boxes now reset to `inputs.sha`; the
released commit is always an ancestor of `main` because the ruleset forbids a force-push, so
fetching the branch makes it reachable and the reset fails loudly if it somehow does not.

**THE TEST WRITTEN TO CATCH THIS PASSED ON THE MARKER.** The assertion was `grep -q 'inputs.sha'`
over the file, and the line satisfying it was the line making the false claim. It now derives the
population - every workflow declaring a `sha` input, which is what "was handed a commit" means, and
which correctly excludes `scheduled.yml`'s dev refresh - and asserts of each that every `git reset
--hard` names that commit. A presence is not a property.

#### The dev estate is the PRE-RELEASE target, and the promotion is gone

| The release | Jobs that run                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------ |
| pre-release | `release-kind`, `detect-changed-services`, `build-frontend`, `build-docker-images`, `deploy-dev` |
| stable      | the same four, then `deploy-to-server`                                                           |

**`build-frontend-dev`, `build-frontend-images-dev` and `promote-dev-to-main` were deleted on
2026-09-03.** The first two were a near-identical copy of the frontend build, kept only because one
push used to deploy both estates at once - a run deploys exactly one now, so the single job picks
the estate's `VITE_*` set and tags the right images. **The frontend cannot be re-tagged from one
estate to the other**: SvelteKit inlines `import.meta.env.*` at build time, so the API origins, the
Authentik client id and the "test environment" banner are baked into the bundle.

`promote-dev-to-main` fast-forwarded `main` onto `dev` once the dev estate had ANSWERED
`/api/version` as that commit. It existed because `dev` was a branch nothing else would advance, and
a branch nobody promotes is a parking lot. With one branch there is no promotion left to perform.

**WHAT WAS LOST WITH IT, stated because it was real:** an automatic proof, on production-shaped
data, that a commit serves before production is given it. A pre-release provides that only when
somebody publishes one. That is the trade the user chose, and it is written here so a later session
does not "restore" the promotion by accident.

All of the dev arm is gated on the repository variable `vars.DEV_ENVIRONMENT_ENABLED`, **`true` since
2026-09-02**. It is a `vars` and not a `secrets` entry so its value shows in the run log — a silent
gate is one nobody can debug. Setting it to anything but `true` makes a pre-release deploy nothing.

**A skip is not a success, and `deploy-dev` learned that the hard way.** Its `if:` accepted
`result == 'skipped'` for the jobs it listed — correct in itself, since a skip legitimately means
"this service did not change" — but the frontend BUILD was not in its `needs:` at all, so a FAILED
frontend build let the deploy run and point the stack at `frontend-ssr:dev`, an image never pushed.
GitHub reports a job whose dependency failed as **skipped**, not failed, so the two states are
indistinguishable from the status alone; what makes the disjunction honest is the `needs:` edge,
because without it there is no result to read and the condition is vacuously true. `build-frontend` is
in `needs:` and its result is checked, alongside the image job's.

**The deploy body is three scripts, not inlined YAML, and BOTH estates are on them since
2026-09-24.** `infrastructure/deploy/render-env.sh` resolves every `.env` key from
`infrastructure/deploy/env-manifest.tsv` and refuses to write a partial file;
`infrastructure/deploy/deploy-environment.sh` then takes the environment as an argument; and
`infrastructure/deploy/verify-secrets.sh` asserts afterwards that the CONTAINERS hold what was
rendered. Dev reads `DEV_<NAME>` for every secret and never the bare name, so a missing dev secret
is EMPTY rather than production's value.

**Production moved last, and it took `serve-prod.yml` from 943 lines to 306.** Dev had exercised the
scripts for three weeks while production kept 277 lines of hand-written
`if [ -n "$X" ]; then upsert; else warn; fi` and its own copies of the pull, the up, the migrations
and the health wait. Two things the swap bought immediately: the service list a deploy requires to
be running is DERIVED from the compose file rather than hand-listed, where the hand list had never
contained `frontend-ssr`; and the equivalence was measured rather than assumed - rendering
production's `.env` through the script reproduced all 61 keys with **no value different**. Two
things it cost, both caught before shipping: the old job named its variables after the key they
rendered (`AUTHENTIK_BASE_URL` held `secrets.AUTHENTIK_URL`), which `render-env.sh` does not read,
and `deploy-env.test.sh` now asserts the variable NAME rather than merely that the secret is
mentioned. Everything about the estate itself is on
[dev-environment](infrastructure/dev-environment.md), the only copy.

`scheduled.yml`'s `dev-reset` job empties dev and loads the fictional seed, on demand only (no cron,
not part of `all`), behind the same gate. Nothing copies production's data into dev since 2026-10-16
([dev-environment](infrastructure/dev-environment.md#3-the-data-a-fictional-seed-and-nothing-from-production-owner-2026-10-16)).

### The smoke sign-in (WP-SMOKE-LOGIN, decided 2026-10-18)

`serve-dev.yml` runs `.github/scripts/smoke-login.mjs` right after the wasm check and BEFORE
`dev-deployed` moves, so a refused sign-in leaves the marker where it was and gate 4 refuses the stable
(a stable ships the pre-release that served dev). It walks what a browser walks: MiConnect's flow
executor (`/api/v3/flows/executor/<slug>/`), the authorization code, `POST /api/auth/oidc/callback`,
then `GET /api/auth/verify` with the minted token (the auth_request that guards every route). It
needs no browser and no PIN: it proves the identity and token path, not the MLS vault.

**Dev only, by construction (user, 2026-10-18).** The step lives in `serve-dev.yml` and reads
`DEV_SMOKE_*` secrets of the `development` environment. No production credential exists in GitHub, and
`serve-prod.yml` never signs in. Production's sign-in stays covered by the wasm check, the stable's
gates and the dev run having passed on the same code.

**Absent secrets are a named, loud skip, never a pass.** Neither set: exit 0 with a
`::warning title=Smoke sign-in SKIPPED` and a run-summary block saying NO sign-in was tried. Only one
of the pair set: exit 1 (a half-created pair must not read as "not configured"). A refusal exits 1 with
the stage it died at (`ak-stage-password`, `oidc-callback`, `verify`...) and the reason, never the
password; the summary says the marker was not moved.

**What it needs** - both secrets exist since 2026-10-18 (a dedicated external account with no
admin right; it creates its own row on dev at first sign-in):

| Name                 | Kind   | Where                     | What                                                                                                                                                                   |
| -------------------- | ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEV_SMOKE_USERNAME` | secret | `development` environment | the login of a DEDICATED MiConnect account used by nothing else                                                                                                        |
| `DEV_SMOKE_PASSWORD` | secret | `development` environment | its password; it must be able to pass the flow with NO second factor (the campaign's service-account path has none, [cross-client-campaign](cross-client-campaign.md)) |

It reuses `DEV_AUTHENTIK_URL` and `DEV_AUTHENTIK_CLIENT_ID`, which dev already has. The flow is NOT a
variable: `serve-dev.yml` passes `SMOKE_FLOW_SLUG: password-login`, because MiConnect's default flow
(`miconnect-auth`) is CAS-only - it identifies a password account and then DENIES it
(`ak-stage-access-denied`).

**The real shape (authentik 2026.8, first live run 2026-10-18)** - the first version was written
against fakes and died on it with `flow executor answered HTTP 302`:

- the walk starts on `/if/flow/password-login/?next=<authorize URL, ENCODED>` and hands the executor
  that page's whole query string as `?query=`, as the flow interface does. **`next` raw loses
  everything after its first `&`**: the flow then ends on an authorize URL holding only `client_id`;
- an ACCEPTED stage answer is a **`302` back to the executor's own URL** (follow it with the jar), a
  REFUSED one a `200` challenge carrying `response_errors`;
- the stages are `ak-stage-identification > ak-stage-password > xak-flow-redirect`, the redirect
  pointing at the authorize URL, which then `302`s to `/auth/callback?code=...` on the session cookie.
  No consent stage and no CSRF header were needed.

The fake in `.github/scripts/tests/smoke-login.test.mjs` copies that shape, the CAS-only denial
included. A different component named in a failure is the flow asking for a stage the account cannot
answer.

### The store arms (`ios.yml`, `android.yml`)

Called by `release.yml` with the sha, the version and the release kind, so the Play track
and the App Store channel cannot disagree about what is being released:

| Workflow      | Output                                                                                                                   | Stable             | Pre-release      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------- |
| `android.yml` | `.aab` for Google Play                                                                                                   | `production` track | `internal` track |
| `ios.yml`     | `.ipa` via `altool`, then the App Store version created, the build attached and the whole thing **submitted for review** | App Store review   | TestFlight       |

**iOS USED TO STOP AT TESTFLIGHT, AND THAT WAS THE LAST ASYMMETRY BETWEEN THE TWO STORES.**
`altool --upload-app` hands Apple the binary and returns - exactly right for a pre-release, and one
manual gesture short of shipped for a stable: somebody had to open App Store Connect, create the
version, attach the build and press Submit. Nothing asked for that gesture and nothing reported its
absence, while the same release put Android on the Play `production` track by itself. So a stable
release was **half-shipped by construction**. `tools/app-store/submit.mjs` closes it; everything
about how, including the release-notes file a human owes each stable and why its first line names
its own version, is in [its README](../../tools/app-store/README.md), the only copy.

**BOTH ARMS ARE ALSO HAND-DISPATCHABLE, AND THAT IS A CAPABILITY RATHER THAN A SECOND DOOR.** It is
the only way to compile Swift, ObjC or Kotlin from the Windows workstation this project is developed
on. What makes it safe is `publish`, an INPUT: `release.yml` takes the callable default `true`, a
hand dispatch defaults to `false`, and every step that reaches a store or a release reads it. The
version that reasoned about `github.event_name` instead is the defect described two sections down -
in a called workflow that field is the CALLER's event, so the reasoning is not merely wrong, it is
unanswerable.

#### The Linux desktop build is SUSPENDED, not lost (2026-09-03)

`appimage-release.yml` was deleted on the owner's decision - _"il n'y a actuellement aucune
perspective de ce cote la"_. It worked: it built and attached a `.AppImage` to every release, and it
carried the same baked-origin assertion the store bundles do. Nothing was broken about it; there is
simply no audience for a Linux desktop client right now, and a release workflow nobody wants costs
about ninety seconds and ninety megabytes on every tag.

**What actually went, and what deliberately stayed.** The workflow file went, the README stopped
advertising a Linux desktop client, and the tables here and in
[the French guide](../user-guide/workflow-developpement.md) lost their row. **The incident records
kept the word on purpose**, because each one explains a guard that is still live: the
`@tauri-apps/plugin-log` parity check exists because a version mismatch killed Android, AppImage and
iOS on one tag, and the `rustflags` warning in `.github/actions/build-mls-wasm/action.yml` exists
because the AppImage release of v0.14.1 died of a leaked `-D warnings`. Deleting those sentences
would delete the reasoning behind checks that still run.

**Bringing it back is one file and no decisions.** The last version is in this repository's history
(`git log -- .github/workflows/appimage-release.yml`), Tauri's `bundle.targets` is still `all`, and
nothing else was adjusted to make its absence work - so restoring the file restores the behaviour.
`v0.15.0-alpha.1` is the last release carrying an AppImage asset; the asset was left attached rather
than deleted, because a published release is a record.

**One runtime fact survives the removal and must not be tidied away with it.** On
`tauri://localhost` - iOS, macOS _and_ a Linux desktop build - WKWebView drops the refresh cookie,
which is why the client carries it in `X-Canari-Refresh` instead. That is a property of the engine,
not of a workflow, and it stays true for anyone who builds the desktop target locally
([sessions](sessions.md#the-credential-a-client-carries-itself)).

**THERE IS NO TESTFLIGHT GROUP TO SELECT, and that surprised the checklist.** `altool --upload-app`
hands the build to App Store Connect, and every INTERNAL tester sees every processed build
automatically - internal groups are not opt-in per build, unlike external ones. That is exactly why
decision 9 chose internal channels: no Beta App Review in the loop. On iOS the alpha/stable
difference is the backend the bundle is built against, and nothing else.

**PLAY ACCEPTS TWO TRACKS NOW BECAUSE EACH ALPHA CARRIES ITS OWN `versionCode`.** One upload per job
is still the rule - Google rejects re-uploading the same `versionCode` to a second track in one job,
confirmed on v0.9.21 (_"Version code 9021 has already been used"_) - and what changed is that
`bump-app-version.sh` bands the pre-release counter into the code, so an alpha and its stable are
different numbers. See the version-bump section for the band.

**AN ALPHA POINTS AT `dev.canari-emse.fr` AND A STABLE AT PRODUCTION, ASSERTED IN ALL THREE.** This
is the one place in the migration where a mistake ships to phones: a store build bakes its backend
origin in and cannot be re-pointed afterwards, so an alpha built against production would let the
tester programme write to real data, and a stable built against dev would point every user at a box
wiped every Monday. Neither is visible in a green pipeline, so each workflow resolves the URL and
FAILS on a mismatch. There is no fallback from the `DEV_*` secrets to the production ones - falling
back is precisely how an alpha ends up talking to production.

### Package 2: publishing a release (`release.yml`) - the one entry point

**THREE HUMAN GESTURES, AND NOTHING ELSE MOVES** (user, 2026-09-03): open a pull request, which
`arm-auto-merge.yml` squash-merges onto `main` once `CI passed` is green and which deploys NOTHING;
publish a pre-release `vX.Y.Z-alpha.N`, which deploys `dev.canari-emse.fr` and feeds the store
tester programmes; publish a stable `vX.Y.Z`, which deploys production and both store production
channels.

`release.yml` is the only workflow either publication triggers, and it has five jobs:
`preflight` -> `bump` -> `deploy` + `android` + `ios`.

**IT CARRIES BOTH PUBLICATION PATHS RATHER THAN BEING TWO FILES, and the reason is worth keeping.**
The two publications are one machine differing by one boolean. A second entry point would either
duplicate the chain - the exact "a decision taken more than once" defect this rebuild removed - or
add a THIRD level of reusable-workflow permission plumbing, which is what killed this chain's first
run. So the paths are told apart by the EVENT TYPE:

| event         | estate               | Play         | App Store                |
| ------------- | -------------------- | ------------ | ------------------------ |
| `prereleased` | `dev.canari-emse.fr` | `internal`   | TestFlight               |
| `released`    | `canari-emse.fr`     | `production` | submitted for **review** |

**AND THAT CLOSED A DEFECT NOTHING COULD SEE.** `published`, the old trigger, fires for BOTH kinds,
so the "Set as a pre-release" checkbox was invisible and the version string was the only statement
read - ticking the box on a `v0.17.0` silently deployed production, and forgetting it on a
`v0.17.0-alpha.1` silently pushed a tester build to both production channels. Neither shows in a
green run. `prereleased` and `released` fire for exactly one kind each, so both statements now
arrive and the preflight compares them: the event says one, `release_kind()` says the other, and a
mismatch is a refusal naming BOTH sides, because whichever is wrong the reader has to know which to
change. The dispatch path keeps the old behaviour, deliberately: a dispatch carries no checkbox, so
the version is the only statement made. The three arms are `uses:` calls, not
`workflow_run` listeners, so they are jobs of ONE run: one page to read, real `needs:` ordering,
and the same inputs to all three.

**AND INSIDE EACH ARM, THE STORE COMES BEFORE THE GITHUB RELEASE ASSET** - which is not cosmetic
ordering, it is what `v0.16.0` cost. Both arms attached their bundle to the GitHub release BEFORE
publishing to the store. On the stable that attachment was refused (`Resource not accessible by
integration`, pointing at _update-a-release_, with `Contents: write` granted and PRINTED by the
runner), and `Upload to TestFlight` plus the App Store submission were both `skipped` behind it:
production and Google Play received 0.16.0 and **Apple received nothing**, the run complaining only
about the convenience. The Android arm had the identical ordering and merely happened to succeed.
**A store is the deliverable; a release asset is a copy for humans** - so the store is served first
and a refusal on the asset still fails the job, having already shipped. The assertion is on the
ORDER and on the ABSENCE of `continue-on-error`, because swallowing the refusal would trade a
visible skip for an invisible one. **The refusal itself is unexplained** and open in
[backlog](backlog.md), with six causes ruled out by measurement.

**WHY IT IS ONE FILE NOW.** Until 2026-09-03 the two publications drove FOUR workflows chained by
`workflow_run`, and three things were measured wrong on the first day the chain ran for real:
nothing was gated on the TESTS (the chain required the BUMP to succeed, which is a different
statement, and `v0.15.0` shipped on a RED run); production went AHEAD of dev, the two gestures
landing on two unrelated commits with nothing comparing them; and each chain resolved `main` for
itself. All three are the same defect - a decision taken more than once, and a precondition
asserted nowhere.

#### The five gates, and the one that makes a lag impossible

`.github/scripts/release-preflight.sh` runs before the bump, so a refusal refuses the deployment,
both store uploads and the version bump itself:

| #   | Question                                             | Why a refusal rather than a report                                                                    |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Is the version a version?                            | a typo must not reach a store band computation                                                        |
| 2   | Is the released commit on `main`?                    | everything downstream reads the trunk                                                                 |
| 3   | Did `CI passed` conclude **success** on THAT commit? | "if the tests are green" was written nowhere at all, and an ABSENT check is not a passing one         |
| 4   | Has the dev estate already served it? (stable only)  | **production cannot be ahead of dev**                                                                 |
| 5   | Do the App Store release notes name THIS version?    | Apple refuses a submission without them, and refusing at the END of a release costs the whole release |

**Gate 4 is why this file exists** (user, 2026-09-03: _"Je ne veux pas un detecteur de retard, je ne
veux pas que ca soit possible"_). It compares the released commit against the `dev-deployed` marker
the dev deploy writes: `identical` or dev `ahead` both mean the code went through dev, and dev
`behind` is a refusal naming how many commits are missing and telling the reader to publish a
pre-release at that commit first. A detector was written first and deleted unshipped - the same
measurement, as a refusal instead of a report.

**"Served dev" MEANS "the dev estate was asked what wasm it serves" (2026-10-06).** `serve-dev.yml`
runs `tools/cross-client-harness/deployed-wasm-check.mjs https://dev.canari-emse.fr` BEFORE its
`Record the deployed commit` step, so a dev estate serving a wasm that can panic (the 2026-09-06
class: every login refused as a wrong PIN, every status code 200) never moves the marker, and gate 4
refuses the stable. It is not a login; the sign-in is the next step ([the smoke sign-in](#the-smoke-sign-in-wp-smoke-login-decided-2026-10-18)).
`release-chain.test.sh` pins the order; `archive/deployed-wasm-selftest.mjs` pins the three exit codes.

**A PULL REQUEST THAT MERGES BETWEEN THE PRE-RELEASE AND THE STABLE COSTS ONE MORE PRE-RELEASE, AND
WHICH GATE REFUSES DEPENDS ON WHICH COMMIT YOU TAG.** Measured 2026-09-17 during `v0.18.10`: the
pre-release was cut at `14d77ab3`, the bump pushed `2e42ddac`, the dev deploy marked `dev-deployed`
at **that bump commit** (`serve-dev` is handed `needs.bump.outputs.sha`, not the tag's) - and then an
unrelated pull request merged, moving `main` one commit further. Neither commit could carry the
stable:

| Tag the stable at                  | Refused by | Because                                                                   |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------- |
| the commit dev served (`2e42ddac`) | **gate 2** | `main` no longer points at it                                             |
| `main`'s new head                  | **gate 4** | dev is `behind` by the merged commit, so production would be ahead of dev |

CLAUDE.md's one-line warning names gate 2, which is the first of those two; the second is the one you
actually meet if you follow the instinct to tag the newest commit. **The fix is neither a bypass nor
a revert: cut a second pre-release at the new head, let it move the marker, then cut the stable.**
That is gate 4 working exactly as specified - the extra pre-release is the documented price, paid in
minutes - and it is worth knowing before a release rather than during one, because both refusals
arrive AFTER the tag exists.

**THERE IS NO BYPASS INPUT, deliberately.** A skip flag is a fallback path, and reaching one means
the primary path failed - so the fix belongs there. The emergency path is unchanged and is not in
software: a human with admin rights acting by other means, written into `CHANGELOG.md` when taken.
Gate 4 costs one extra pre-release in a real emergency, which deploys dev in minutes.

**THE ADMIN BYPASS SHORTENS NOTHING, AND THAT IS THE DOCUMENTED PRICE (decided 2026-10-06, the
cheaper of the two options the 2026-09-06 outage left).** `gh pr merge --admin` skips the ruleset's
`CI passed` on the PULL REQUEST; gate 3 then refuses the release until `CI passed` has run on the
merged commit - main's own CI, 14-22 minutes after the merge (measured 2026-10-18), the same suite the bypass avoided. So the
sequence in an emergency is: admin-merge, `gh run list --branch main` until CI is green, publish the
pre-release (or `gh run rerun` a refused one - it needs no new tag, and rescues only this gate), then
the stable. Gate 3's refusal says so in its own words (`release-preflight.sh`, pinned by
`release-preflight.test.sh`). A short path that is actually short would need a gate that trusts
something other than a green suite on the commit, and the project's rule is that a refusal names the
test that would lift it, not a switch.

#### Two incident-time items decided NOT to be built (2026-10-06)

Both came out of the 2026-09-06 outage and both were re-read against `origin/main` before any code.

**An auto-merge hold on files an in-flight fix touches.** The proposal keyed on an open `hotfix/*`
pull request. No such population exists: the last 60 merged branches were `fix/` (25), `feat/`
(16), `docs/` (9), `dependabot/` (8) and `test/` (2), so the hold would never fire; keying on `fix/`
instead would make two overlapping fixes hold each other. And the harm it was written against - a
green merge silently reverting a fix - needs the other pull request to have changed the SAME lines,
which git refuses as a conflict (and a conflicting pull request does not merge); a change to other
lines of that file keeps the fix. What is left is a SEMANTIC interaction between two correct changes,
which is `CI passed`'s job. The real incident-class defect of that day - a session re-arming a
deliberately disarmed merge - has its own rule in [durable-rules](durable-rules.md): a disarmed
auto-merge is a decision until something proves it a fault.

**Splitting `release.yml`'s `group: release` so the stores do not hold the lock.** The premise
holds (an estate-only pre-release waited behind another's TestFlight upload) but the split cannot be
made sound from here: job-level groups do not compose into a lock over a graph of jobs (a second run's
`bump` would interleave with the first's `land` and `serve-*`), and a callee-level group on
`android.yml` / `ios.yml` alone leaves the workflow-level lock in place. Nothing short of
restructuring the whole run can be tested off GitHub, and the cost of getting it wrong is a refused
or double-bumped release. **The supported gesture is the one the item itself named: `gh run cancel
<run>` on the superseded pre-release once its estate jobs are green** - the estate work is already
recorded (`dev-deployed`), only the store arms die, and the waiting run starts.

#### The bump job

It stages `git add -u`, so whatever the bump script writes is what gets committed — see
[Version bump](#version-bump) below for why that replaced a path list.

#### The push this workflow makes is the ONE push to `main` that is not a pull request, and the ruleset refused it (measured 2026-09-03)

**The first real release found this, and nothing before it could have.** `main` carries ruleset
`22152902`: no direct push, `CI passed` required. The bump ends in `git push origin HEAD:main`, and
with `GITHUB_TOKEN` that push is made by `github-actions[bot]`, which is not a bypass actor. So the
push was refused, the run went red, and **nothing downstream started** — every arm needed the bump.
Fail-safe, and a chain that does not run. **That accident is now the design**: the preflight sits in
front of the bump precisely because everything already depended on the bump succeeding.

**The Actions app cannot be exempted.** Adding it to `bypass_actors` returns
`422 Actor GitHub Actions integration must be part of the ruleset source or owner organization`
for a repository-level ruleset. That was measured, and the ruleset read back unchanged afterwards.

**What works is the App that is already installed.** `canari-auto-merge` (app id `4791068`) is an
organisation installation, so GitHub accepts it as a bypass actor — and
`arm-auto-merge.yml` already mints installation tokens for it. The bump job now does the
same and checks out with that token, because a later `git push` uses whatever credential the
checkout persisted. **That same file mints the same identity for the same asymmetry read the
other way round** - see below. Until 2026-09-04 those were two files, `dependabot-auto-merge.yml`
and `auto-merge.yml`; `release-chain.test.sh` asserts neither has come back. The token is minted per run and expires in an hour, which is why an App beats a
long-lived PAT here: there is no secret to rotate before it silently expires.

**One side effect, and why it is harmless HERE.** A push made with an App token _does_ raise a
`push` event, where a `GITHUB_TOKEN` push does not — `arm-auto-merge.yml` documents that
asymmetry and depends on it. The consequence is that `ci.yml` runs once on the bump commit, which is
useful rather than costly. **It does not double a deploy, only because the three deploy libraries have no trigger at all** - it is
`workflow_call` only. Anyone giving a deploy workflow a `push` trigger has to read this paragraph
first.

**AND THE SAME ASYMMETRY IS LOAD-BEARING IN THE OTHER DIRECTION, WHICH IS WHY `arm-auto-merge.yml` USES
AN APP TOO.** Auto-merge merges as whoever armed it. Armed with `GITHUB_TOKEN`, the merge would
raise no `push` event, `ci.yml` would never run on `main`, the merge commit would carry no
`CI passed` check - and gate 3 above would then refuse EVERY release, on commits that had in fact
been tested. Someone "simplifying" `arm-auto-merge.yml` to the default token would break releasing from
a file that has nothing to do with releasing, so `release-chain.test.sh` asserts it does not.

**The first release, `v0.15.0-alpha.1`, sidestepped this rather than fixing it**: the bump was landed
through an ordinary pull request BEFORE the tag, so the workflow re-ran the same script, found no
diff, printed `No version changes` and exited 0 without ever reaching the push. That worked and
proved the rest of the chain, but it made publishing a release a two-step manual dance. The App
token is the fix; bump-before-tag stays available as the emergency path if the App is ever
uninstalled.

#### The bump promotes the release notes, and that is the one modification nothing was making (2026-09-03)

Every version-bearing manifest is rewritten by the script; `CHANGELOG.md` was not touched at all.
So `## [Unreleased]` stayed `[Unreleased]` through every release, and the next cycle wrote its
entries into the same section. **That is not cosmetic drift: it is why 4098 lines sat under one
heading covering fifteen shipped versions, with no way left to say which release a user got a given
fix in.** Nothing failed, which is exactly why it survived fifteen releases.

`promote_changelog` in `scripts/bump-app-version.sh` now rewrites `## [Unreleased]` into a fresh
empty `## [Unreleased]` followed by `## [X.Y.Z] - <date>`. Three properties matter, and each is a
test in `.github/scripts/tests/bump-staging.test.sh`:

- **STABLE ONLY**, which is the whole reason `RANK` is passed in. An `-alpha.N` is a tester build,
  not the release of those notes: promoting on it would close the section and leave the stable that
  follows days later publishing an empty one — the same drift, inverted.
- **IDEMPOTENT**, because a re-run is ordinary — the workflow is hand-dispatchable and a release can
  be re-published. A heading for that version already present means the work is done.
- **IT REFUSES TO PROMOTE AN EMPTY SECTION, and emits a `::warning::` rather than a log line.** A
  version heading with nothing under it reads as a fact ("this release documented nothing") instead
  of as the gap it is. **This arm is reached in the ORDINARY course of things** - every release
  leaves `[Unreleased]` empty behind it, so the next one finds it empty unless somebody wrote an
  entry, and a line on stderr in a runner log is not a report. It must not FAIL the release either
  (a release is what ships a fix; blocking one over a documentation gap is the wrong trade), so
  under GitHub Actions it annotates the run summary where the person who published the release will
  see it. Its own test found this: `v0.15.0` left `[Unreleased]` empty, three assertions written
  against the repository's changelog started failing, and the mechanism was behaving exactly as
  designed - which is why the suite now writes its own fixture and asserts BOTH arms.

**It lives in the SCRIPT and not in the workflow**, so `git add -u` picks it up with everything else
and the notes land in the bump's own commit. A workflow step doing it after the commit would need a
second commit and a second push, and the push is the part the ruleset scrutinises.

`v0.15.0` is the first release promoted this way, and its section therefore spans everything since
`0.14.0` rather than only its own changes — the fourteen releases in between were published while
the drift was live. That is stated inside the section rather than corrected, because re-attributing
4098 lines to fifteen tags after the fact would be a guess.

**ONE ARGUMENT BECOMES THREE DIFFERENT STRINGS**, and conflating any two of them breaks a store
upload rather than a build. `scripts/bump-app-version.sh` is the only place that decides:

| Value            | Example          | Where it goes                                                              | Why                                                                                                                                                                  |
| ---------------- | ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the full version | `0.15.0-alpha.1` | every `package.json`, `Cargo.toml`, `Cargo.lock`                           | all accept a semver pre-release, and `frontend/package.json` is what the client identifies itself by (`VITE_APP_VERSION`, so `minClientVersion` compares against it) |
| the numeric core | `0.15.0`         | `tauri.conf.json`, `CFBundleShortVersionString`, `MARKETING_VERSION`       | Apple requires the short version to be numeric; a suffix there is an App Store validation failure                                                                    |
| the band         | `1500001`        | `bundle.android.versionCode`, `CFBundleVersion`, `CURRENT_PROJECT_VERSION` | one integer identifies a build on both stores, and every alpha needs its own                                                                                         |

**THE BAND IS `(major*1e6 + minor*1e3 + patch) * 100 + rank`, `rank` = N for `-alpha.N` and 99 for a
stable.** 99 and not 0: rank 0 would put `0.15.0` BELOW every alpha of `0.15.0`, and a store refuses
a code it has already accepted. The order reads `0.15.0-alpha.1` 1500001 < `-alpha.98` 1500098 <
`0.15.0` 1500099 < `0.15.1-alpha.1` 1500101. Today's `0.14.15` shipped as 14015 under Tauri's own
derivation (`major*1e6 + minor*1e3 + patch`, which cannot see a suffix), so the band steps up by a
factor of 100 exactly once and stays monotonic; the ceiling `0.999.999` → 99999999 is well inside
Play's 2100000000. `alpha.N` is capped at 98 for the same reason.

**AND THE ONE THING THAT WAS NOT SETTLED NOW IS (measured on `v0.15.0-alpha.1`, 2026-09-03).** The
open question was whether `tauri ios build` re-syncs both version keys from `tauri.conf.json` during
the build and so overwrites the committed `CFBundleVersion` — which would make the second alpha of a
version a duplicate build TestFlight refuses. **The shipped `.ipa` carries
`CFBundleShortVersionString 0.15.0` and `CFBundleVersion 1500001`, which is the band.** Whether
Tauri rewrote the plist or left it alone is therefore moot: the script writes the same numbers into
`tauri.conf.json` and into the plist, so a re-sync is idempotent, and Tauri 2.11.4 exposing no iOS
build-number override costs nothing. `ios.yml` still patches that plist with `PlistBuddy`
for the export-compliance key; nothing needs to re-assert the build number there.

`.github/scripts/tests/bump-version.test.sh` runs the script in a sandbox, reads every file back and
asserts the ordering directly (31 assertions).

### A stable ships the latest pre-release, and `main` may move on (2026-10-02)

**A PRE-RELEASE tag is still refused when `main` moved past its sha between the head read and the tag, and a rerun re-reads the same tag and cannot rescue it; a stable is immune** (it ships the latest alpha, #1367).

A stable used to be built on the commit its tag named and pushed to `main`, so it was REFUSED the
moment anything merged after that commit - each merge during a release cost a new tag. Now (user:
_"une release n'opere que sur le tag de la derniere pre-release"_):

- **Resolve.** `release.yml`'s preflight picks the highest `vX.Y.Z-label` tag of the stable's own
  version (`latest_prerelease_tag`, version order) and resolves THAT commit once; no such tag is an
  error naming the command to cut one. The stable's own tag is not read.
- **Gates.** 2 asks only that `main` contains the commit (the fast-forward question has nobody
  asking it); 3 reads `CI passed` on it; 4 and 5 are unchanged.
- **Bump.** The bump runs on that commit, whose `changelog.d/` holds exactly the entries it
  contains, and pushes to **`release/vX.Y.Z`** (force: a re-run rewrites it), never to `main`. The
  stable tag is then **moved to that commit**, so `vX.Y.Z` names what production runs. Pre-releases
  are unchanged: bump pushed to `main`.
- **Hosts** fetch the released commit BY NAME (`git fetch origin <sha>`), not `main`, since the
  shipped commit is on the release branch.
- **Land.** The `land` job, parallel with the arms and blocking nothing, runs
  `.github/scripts/land-release-changelog.sh`: on `main`'s head it folds ONLY the fragments the
  shipped commit carried, touches NO manifest (main's version is its latest pre-release's), and
  retries the push when a merge wins the race. Idempotent; a red `land` is re-run, it never holds
  production back. Test: `land-release-changelog.test.sh`.

## GitHub Secrets

See [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) (section 3) for the full secrets inventory.

**A credential is real in THREE places, not two.** The CD regenerates `infrastructure/.env` from the
repo secrets, so a value set over SSH lasts until the next deploy. It must therefore be a GitHub
secret AND named in `serve-prod.yml` - and the third, just as mandatory and the easiest to forget, is the
service's own `environment:` block in `infrastructure/docker-compose.prod.yml` (and `.dev.yml` for
parity), spelt explicitly as `FOO: ${FOO:-}`. `.env` holding the value proves nothing about whether
Compose passes it INTO the container: `GOOGLE_SAFE_BROWSING_API_KEY` shipped correctly in `serve-prod.yml`
and `.env.example` and was still absent from the running container (WP-SAFELINK-1), where the
endpoint answered 200 with a silently fail-open verdict rather than an error.
`docker exec <container> env | grep FOO` is the only way to catch it.

## Rotating `JWT_SECRET`

A single secret signs the services' tokens. Rotating it is already a supported operation — nothing in the workflows needs
changing — but nothing schedules it either, which is why it is written down here.

**The procedure is two steps**, and the second is not optional:

1. Change the `JWT_SECRET` repository secret (`openssl rand -hex 32`).
2. Re-run the CD workflow.

`serve-prod.yml` makes this safe by refusing every failure mode it can see:

| Step      | What it does                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| l.498     | Fails the deploy outright when `JWT_SECRET` is absent — no accidental default                                           |
| l.538     | Upserts it into `infrastructure/.env` on the server                                                                     |
| l.863-869 | Re-reads the value **from inside the running core-service container** and compares its sha256 against the GitHub secret |

That last check is what makes a rotation believable: a deploy where the new secret did not actually
reach the running process **fails**, instead of reporting success over a service still signing with
the old key.

**Rotation is a hard cut, on purpose.** There is no `JWT_OLD_SECRET` grace window in Canari and
none should be added: the grace period is paid for with a second step that is invisible and
therefore never taken (Le Cercle's production is the standing proof — its old secret still signed
sessions months after the rotation "happened"), and it is exactly backwards for the case you
actually rotate in, a leak, where the old key must die _now_. Canari signs in through Authentik, so
the cost of the hard cut is one mostly transparent SSO redirect.

**A rotation is not the everyday revocation lever.** Signing one device out, or ending one stolen
session, is a row in `auth_sessions` — see [`services/core-service.md`](services/core-service.md).
Reach for the secret only when the secret itself is suspect.

## Container registry

All service images are published to GitHub Container Registry:

```
ghcr.io/emse-students/canari/<service>:<tag>
```

| Tag                           | Meaning                                                                        | Moved by         |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------------- |
| `latest`                      | the newest stable's images (informational: production deploys by `v<version>`) | a STABLE release |
| `dev`                         | what the dev estate is deploying                                               | a PRE-RELEASE    |
| `<sha>`                       | the immutable one - this exact commit                                          | every release    |
| `v0.15.0` / `v0.15.0-alpha.1` | the release that produced it; **what production deploys**                      | every release    |

**The two moving tags never cross**, and that is what lets one registry feed two estates from two
different commits. Production is deployed by the release's `v<version>`; dev by its moving `dev`
(a rollback of dev is not a goal).

## Hosted runners are pinned to `ubuntu-24.04`, never `ubuntu-latest` (2026-10-18)

GitHub moves `ubuntu-latest` to Ubuntu 26 on 2026-10-19. Every hosted job now says `runs-on: ubuntu-24.04`,
the image the runs used the day before (a `main` run's "Set up job" log reads `Ubuntu 24.04.5 LTS`), so the
pin changes nothing today. Self-hosted labels are untouched. **Revisit on or after 2026-11-18**: move to
`ubuntu-26.04` deliberately, as ONE pull request whose CI is the trial run, never as a side effect of a
floating label. `tools/ecosystem-shape` does not assert the hosted label (only the self-hosted one), so
no assertion needed adapting.

## Self-hosted runner

**THE DEPLOY JOB RUNS ON THE MACHINE IT DEPLOYS, AND AFTER 2026-09-24 THAT IS NOT A PREFERENCE.**
It reads as one, because the job builds nothing: it checks out, logs in to GHCR, pulls `latest` and
runs `docker compose up`, all of which a GitHub-hosted runner could do over SSH. **It could not.**
The migration target does not accept SSH from GitHub-hosted runners (a per-port filter upstream of the
host, not a ban on one address), so a GitHub-hosted runner has no route in at all. The measurement
is on
[estate-migration](infrastructure/estate-migration.md#canari---moved-2026-09-24-it-was-two-estates-and-a-ci-runner-not-one-estate).

**So the model is the same in all five repositories, and it is one sentence: `release.yml` is the
only thing that deploys, and its deploy job runs on the machine it deploys to. Nothing deploys
across the network.**

| Repository      | Forge            | Runner           | Scope                                                 | Machine                                                                             |
| --------------- | ---------------- | ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Canari**      | GitHub           | `canari`         | ORG, group `canari`, selected to this repository      | the target (**registered 2026-09-24, stopped and disabled until the estates move**) |
| **Portail-etu** | GitHub           | `portail-etu`    | ORG, group `portail-etu`, selected to that repository | the target                                                                          |
| **Le Cercle**   | `gitlab.emse.fr` | `cercle-portail` | project, tag `cercle-portail`                         | the target, **registered PAUSED**                                                   |
| **MiConnect**   | none             | -                | -                                                     | the target, deployed by hand: no pipeline has ever touched it                       |
| **Sky**         | GitHub           | `sky`            | REPOSITORY                                            | the old VM                                                                          |
| **MiGallery**   | GitHub           | `MiGallery`      | REPOSITORY                                            | the old VM                                                                          |

**Two runners on one machine are kept apart by the GROUP, never by the label.** Every runner here
carries the same default `self-hosted,Linux,X64`, so a label decides nothing; `visibility=selected`
on a group naming exactly one repository is what keeps a Canari job off the Portail-etu runner and
the reverse. `allows_public_repositories` must be `true` for both, because both repositories are
public - what governs a fork's pull request executing on the box is GitHub's approval requirement
for outside contributors, and nothing in this repository.

**The last two rows are the inhomogeneity, and it is DECIDED rather than tolerated quietly.** Sky and
MiGallery share `mitv` exactly as the first two share the target, so the argument for a group is
identical and they are still repository-scoped. **They convert to org-level groups AFTER Canari's
move** (user, 2026-09-24), as their own chantier: the change is independent of the migration -
another machine, two repositories with no release in flight - and doing it now would mean two
estates being altered at once for a gain that waits perfectly well. Until then, the org runner
listing is a complete map of who may execute code on the target and an incomplete one of the
estate, which is the one thing to remember when reading it.

**ONE ACCOUNT, DELIBERATELY, AND THE HALF-MEASURE WAS REFUSED** (user, 2026-09-24: _"Soit on
separe tout, soit on rassemble tout."_). Both GitHub runners on the target run as one
service account, and its group is `docker`, which is root-equivalent. So the group decides WHERE a job
lands and not what it may touch once there. The account detail is kept privately.

**A second service account was considered and rejected as exactly the kind of fence that reads as a
boundary without being one.** It would separate the work trees and the runner
credential files, and it would separate nothing that matters, because both accounts would still hold
the same socket. **The only shape that would really separate them is a rootless daemon per runner**,
which is a chantier on a machine this project does not own. It is named here so that nobody later mistakes the shared account for an oversight.

On the old `canari` box, until it is switched off, the runner runs as a system user of its own and
reaches the Docker socket the same way.

### There is one runner, so a workflow that asks for it must say what it may not overlap with

All three deploy libraries declare `concurrency: { group: cd-deploy, cancel-in-progress: false }`. Until 2026-09-02 it
declared nothing, and three deploy runs were in flight against `/home/canari/canari` at once - each
able to `git reset --hard` and `docker compose up` while another was mid-flight. Production came out
of it answering normally, which is why the gap had gone unnamed: the race heals cleanly almost every
time.

Three details decide the shape, and only the first is obvious.

- **One group covers BOTH estates.** They are two checkouts on one machine and one run deploys both,
  so a per-environment group would let a dev deploy and a prod deploy overlap on the same Docker
  daemon.
- **`cancel-in-progress: false`.** A killed deploy leaves containers half-recreated and the checkout
  on a commit whose images were never pulled - a state nothing downstream is written to recognise.
  Queueing behind a running deploy is the only safe answer.
- **What makes the runs GitHub drops harmless is a property of the DETECTOR, not of this block.**
  At most one run waits per group; the rest are cancelled while pending. That would lose work if
  `detect-changed-services` measured against the previous RUN - it measures against the previous
  RELEASE of the same kind, which no cancelled run can move, so the survivor rebuilds everything the
  dropped ones would have. **The baseline was the `prod-deployed` tag until 2026-09-03**, and that
  tag was itself the second reason to serialise: two overlapping runs could have one write it while
  the other was still deploying, making the baseline claim a deploy that had not finished. A release
  is published by a human before any of this starts, so that particular race went with the tag. What
  is left to serialise is the Docker daemon and the checkout, which is reason enough.

`deploy-env.test.sh` asserts this, DERIVED from `runs-on: self-hosted` rather than from a list of
workflow names - there is exactly one such runner, and a typed list would pass on the day somebody
adds the third workflow. **"One" is a statement about what is RUNNING, not about what is
registered**: from 2026-09-24 this repository has two registered runners, and the second is stopped
and disabled precisely so the sentence stays true. The window in which both run is the flip itself,
and the old one stops in the same breath as the new one starts. `scheduled.yml`'s `dev-reset` job carries its own `dev-reset` group and satisfies the same
rule.

**Still open, and not covered by either group:** a dev reset and a dev deploy can overlap, the
reset stopping dev's containers to reseed while `deploy-dev` brings them up on new images. A
workflow may declare only one group, so joining them would put a dev database reset in
front of a production hotfix - a cost paid on the production path for a dev-only race. It is named
here rather than fixed silently.

## Release workflow

```
gh release create vX.Y.Z --target $(git rev-parse HEAD)      <- the human gesture, and the last one
  |
  '- Release (release.yml), ONE run
       |
       |- preflight   five gates; a refusal ends it here, having moved nothing
       |- bump        writes the version into 18 files, commits, pushes to main, outputs the SHA
       |
       |- THE FORK, and there is only one: prerelease -> estate = dev | production
       |
       |- three arms, in parallel, each building THAT SHA
       |    |- build.yml    the frontend and every docker image, built FOR that estate
       |    |- android.yml  .aab -> Play `production` (stable) or `internal` (pre-release)
       |    '- ios.yml      .ipa -> App Store Connect, then for a stable: version created,
       |                    build attached, release notes written, SUBMITTED FOR REVIEW
       |
       |- serve-dev.yml   PRE-RELEASE ONLY, needs [build]
       |    '- dev.canari-emse.fr - never held behind a store queue an alpha does not use
       |
       '- serve-prod.yml  STABLE ONLY, needs [build, android, ios]
            '- canari-emse.fr - and only once BOTH stores accepted this version
```

A pre-release stops at TestFlight and the Play `internal` track, which is what a tester programme
is. A stable goes all the way on both stores. **Nothing here is reached by a push to `main`.**

### The web goes last, and only if both stores took the same version

Since 2026-09-04 (user: _"j'aimerais que toutes les versions soient toujours alignees [...] on
pourrait faire en sorte que le deploiement sur les stores et sur le web soit coordonne ?"_).

**What "aligned" can and cannot mean.** Store AVAILABILITY is never simultaneous - Apple reviews in
days, Play rolls out over hours - so no gate can make three destinations live at the same instant,
and one claiming to would be lying. What IS enforceable is the useful half: **the web never serves
a version a store refused.** A build that fails to sign, an `.aab` Play rejects, an App Store
submission answered with a 500 - each now leaves `production` _skipped_ and production serving the
previous release, instead of a web estate a version ahead of every phone.

**Why the two estates are separate calls.** A called workflow cannot depend on a job of its caller,
so `needs: [android, ios]` is only expressible out in `release.yml`. Until 2026-09-07 that was done
by calling ONE file, `deploy.yml`, TWICE with a `phase: build | production` input - and that is the
shape that had to go. GitHub materialises EVERY job of a called workflow as a row in the run graph,
including the jobs whose `if:` cannot possibly hold on that call, so each call drew the other call's
jobs as skipped rows that were not "not taken this time" but INCAPABLE of running. Measured on
`v0.16.4` (run 34057019347), the last stable to reach the end: **22 rows, 5 skipped, and 4 of those
5 structurally impossible.** A parameter that selects half a file produces the other half as dead
rows, on every call, for ever.

So the split is by what a file DOES: `build.yml` builds, `serve-dev.yml` and `serve-prod.yml` each
deploy one estate, and `release.yml` calls exactly the ones a release kind needs. Every row a run
draws is a row that can run; `release-chain.test.sh` fails if any workflow is ever called twice
again. The permissions became exact as a side effect - the single `deploy` job had to grant the
UNION of what both halves needed, so the build jobs ran with a token that could move release
markers and the estate jobs with one that could push images.

**And the release kind is asked ONCE** (user, 2026-09-07: _"faire la dichotomie plus tot dans
l'arborescence"_). `preflight` resolved it, and it was then carried DOWN as `prerelease` and
re-tested in eight places, each callee re-deriving the same fork for itself. It becomes an estate
NAME at the fork - `dev` or `production` - and below that point nothing asks again: neither estate
workflow mentions a pre-release at all, and `build.yml` is simply told which estate it is building
for. Two things genuinely differ by estate and both read that name directly: the secret set that
goes into the frontend `.env`, and the floating docker tag. The rename also collapsed the URL
cross-check from two branches into one comparison - `URL_ENVIRONMENT != ESTATE` - because both
sides finally speak the same vocabulary.

**`needs:` is a SUCCESS dependency and there is no `always()` there.** That is what makes the gate
real rather than a formality: a failed or cancelled mobile arm leaves `production` skipped, and the
recovery is "Re-run failed jobs" on the run that already exists. `release-chain.test.sh` fails if
`always()` ever appears in that job, because inside `build.yml` the `always() && <result test>`
shape is used legitimately and would read as idiomatic here.

**The measured cost is ~14 minutes, paid by production alone**, from `v0.16.1-alpha.1`: the two
mobile arms are the wall, and everything else already finished inside their shadow.

## A manual workflow run is the only native compiler available off macOS

`android.yml` and `ios.yml` both accept `workflow_dispatch`, and **every** publish step (GitHub
Release, Google Play, TestFlight, the App Store submission) is gated on the `publish` input, which a
hand dispatch defaults to **false**. A manual run is therefore a pure compile check that ships
nothing — and it is the only way to compile Swift, ObjC or Kotlin from a Windows machine. Dispatch
both before believing any native change.

**THE GATE USED TO BE `github.event_name == 'workflow_run'`, AND THAT BROKE THE DAY THE CHAIN
COLLAPSED INTO ONE RUN.** In a `workflow_call` workflow `github.event_name` is the CALLER's event -
`release` or `workflow_dispatch` - so the condition went permanently FALSE, and four steps died at
once: both "Upload to Release" steps, the TestFlight upload and the Play publish. The build would
have succeeded, the run would have been green, and **no store would have received anything**. It was
caught by reading the files rather than by any gate, and the assertions that would have caught it
are now in `release-chain.test.sh`. The rule it left: **a condition that cannot be true is the same
class of defect as a required check that is always skipped** - invisible, green, and load-bearing.
What replaced it carries the distinction as DATA, from the one place that knows it.

This is not a formality. A Swift `guard` body that falls through, a Kotlin nested type declared in
a companion object, a plugin command missing from its ACL: none of these are visible to
`cargo clippy`, `bun run check` or any gate that runs locally. On Android specifically, the release
build (`:app:compileUniversalReleaseKotlin`) is the first real Kotlin compile — a debug build does
not exercise it.

### A green run is not proof that *your* file compiled

The iOS `project.pbxproj` is hand-maintained (there is no xcodegen here), so a source file that is
in the repository but absent from the target's build phase is **skipped, not failed**. The run is
green and the change was never compiled. Grep the log for the file by name:

```
SwiftCompile ... <YourFile>.swift
CompileC     ... <YourFile>.o
```

**That grep is iOS-only, and looking for a Kotlin equivalent wastes an afternoon.** Tauri drives
Gradle quietly - no `> Task :` lines, no `BUILD SUCCESSFUL` - so hunting a task line finds nothing
and proves nothing either way. It is also unnecessary: Gradle compiles by **source set**, so a file
sitting in `src/main/kotlin` cannot be silently skipped, and the produced APK is itself the proof.

**A disappeared compiler warning can be the verdict.** When a deprecation warning was the only
thing that ever revealed a piece of dead code, its absence from the next run is what confirms the
removal - there is nothing else to assert against.

### A raw `cargo build` for the static lib must ask for `custom-protocol` itself

`ios.yml`'s "Prebuild Rust static lib (libapp.a)" step calls `cargo build --lib --release
--target aarch64-apple-ios` directly rather than `tauri ios build`, because that CLI's export step
cannot express the two-target (app + NSE) manual-signing profile map this project needs. But
`tauri ios build` is also the thing that normally enables the `tauri` crate's `custom-protocol`
Cargo feature - and `tauri-build`'s `build.rs` derives its `dev` cfg from exactly that feature
(`dev = !has_feature("custom-protocol")`, `tauri-2.11.1/build.rs`). Skip the feature and the release
profile compiles as a **dev build anyway**: the webview loads from the Vite dev server
(`WebviewUrl::App` resolving against `devUrl`, `127.0.0.1:1420`) instead of the bundled
`frontendDist` assets, which is unreachable from a real device. The symptom is a black screen on
launch with Tauri's own hardcoded string, `Failed to request https://127.0.0.1:1420/: ... did you
grant local network permissions?` (`tauri-2.11.1/src/protocol/tauri.rs`) - this shipped once, to
TestFlight, before the step was corrected to pass `--features tauri/custom-protocol` explicitly.
Android does not carry this risk: `android.yml` builds through `bun tauri android build`,
the real CLI, which sets the feature itself.

**Enabling the feature has a second consequence: `generate_context!()` now actually validates
`frontendDist`.** With `custom-protocol` on, the macro embeds `../build` into the binary at compile
time and panics if that directory is missing - it only skips the check in dev mode
(`dev && dev_url.is_some()`, `tauri-codegen`'s `context.rs`). "Prebuild Rust static lib" runs
**before** "Build iOS archive" - the step that actually runs `bun run build` to produce `../build` -
an order that only worked while the build was silently compiling as dev and never looked at the
directory. The Vite build now has its own step, "Build frontend", placed before the Rust compile.

## Signing

Two **named** provisioning profiles must exist and match `PROVISIONING_PROFILE_SPECIFIER` exactly:
one for the `Canari` app, one for the `CanariNotifications` notification-service extension. Team is
"Les Rootz" (`4CLNB8SR6L`); the profiles expire **2027-07-11**.

`ios.yml` also patches `ITSEncryptionExportComplianceCode` into `Info.plist` at build time
from the `APP_STORE_CONNECT_EXPORT_COMPLIANCE_CODE` secret (App Store Connect's own compliance
documentation code for this app - distinct from `ITSAppUsesNonExemptEncryption`, which is committed
since it's not account-specific). Kept as a secret rather than committed: this is a public repo, and
every other Apple-account value here is already handled that way. The step skips, not fails, when
the secret is unset - `Info.plist` stays as committed, and the TestFlight upload step fails with a
409 explaining exactly why.

## Version bump

`scripts/bump-app-version.sh` must patch the NSE's `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION` alongside the app's — an NSE left behind on an older version is rejected
at upload.

**`bump-version.yml` used to stage an explicit `git add` list, and that was a standing hazard this
page carried as a warning: any new file the script learned to patch had to be added there too, or
the bump silently left it uncommitted.** A warning is not a mechanism. Since 2026-09-03 the step
stages **`git add -u`**, which asks git what changed instead of asking a human to remember — the
list was a second, silent statement of which files carry a version, and nothing compared the two
statements. `-u` and not `-A`, deliberately: it stages modifications to TRACKED files only, so an
untracked artefact cannot ride along. `frontend/mls-core/Cargo.lock` is the live example — the
script rewrites it, `.gitignore`'s `*.lock` means git does not track it, and it must stay out of the
commit. `.github/scripts/tests/bump-staging.test.sh` asserts the whole shape in a detached
worktree: 17 tracked files modified and all covered, no untracked file created, no manifest left on
the previous version, and both store numbers carrying the band.

A `Cargo.lock` pins the version of every LOCAL crate as well, and it does **not** live next to the
crate it pins: `mls-core` is pinned in `frontend/src-tauri/Cargo.lock` **and** in
`frontend/mls-wasm/Cargo.lock`. So the script
collects the `[package] name` of every manifest it bumps and rewrites every matching `[[package]]`
block in every lock — a per-crate patch, not a per-directory one.

Until 2026-08-06 it patched no lock at all, and the symptom was not a broken build (nothing runs
`cargo --locked`) but a **misattributed diff**: the entry stayed a release behind until some
unrelated commit happened to run cargo and the pre-commit sweep carried the regenerated lock in.
`0.12.0 → 0.13.0` shipped inside a docs commit (`0e86b34c`) that way.

Which locks are committed is a separate decision, kept in `.gitignore`: a lock is committed when the
package it locks is itself built into a **shipped artefact** (`frontend/src-tauri`, `frontend/mls-wasm`,
`apps/*`), and ignored when the crate is only ever consumed as a dependency (`mls-core`) —
those resolve inside their consumer's lock. The negations must sit **after** the
generic `*.lock` line: last matching pattern wins, and for two releases a `*.lock` added lower in the
file silently overrode the `!apps/*/Cargo.lock` written above it. `frontend/src-tauri/Cargo.lock`
survived only because a tracked file ignores `.gitignore` entirely.

**A generated file the repo COMMITS needs both halves or neither** - the bump must patch it, and
`.gitignore` must really keep it. Worse than either half is a generated file **the formatter also
owns**: the Tauri plugin ACL outputs (`plugins/*/permissions/{autogenerated,schemas}/`) were written
expanded by `build.rs` and folded back by the pre-commit formatter, so every Android build dirtied
the tree and every commit undid it. They are gitignored now, like `gen/schemas/` already was; the
SOURCE (`default.toml`, and the `COMMANDS` list in `build.rs`) stays tracked. **Before ignoring any
generated file, delete it and rebuild** - that is the only proof the generator really owns it.

**A generated file in git is a COPY of the truth, and a copy goes stale in silence.** The question is
never "is it up to date", it is **which pipelines rebuild it and which ship the committed one**.
`frontend/src/lib/wasm/` was committed and rebuilt by `deploy.yml` alone, so the web ran the current
`mls-core` while the Android, iOS and AppImage releases shipped the binary from the last commit that
thought to regenerate it - **two different cryptos in one fleet, with nothing comparing them**.
Rebuilding the untouched sources produced a different binary, which is how it was proven rather than
argued. The fix is not a habit: **every pipeline shipping a client builds the artefact itself**, from
one composite action with one pinned toolchain
([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)). A build step duplicated per pipeline is
the same defect wearing a different hat - two toolchains put two cryptos back in the fleet.

## Dependency updates, and the auto-merge that ships them

Dependabot opens the pull requests (`.github/dependabot.yml`); **from there they are the same as
anybody's**. `arm-auto-merge.yml` arms GitHub's own auto-merge on every pull request in the
repository, and GitHub squash-merges each one the moment `CI passed` goes green. The one thing a
dependency update is asked that a human's pull request is not is the `dependency-ceiling` job, and
that is a CHECK feeding `ci-passed`, so an update with no gate here cannot merge by any route.

**There is no sweep any more (deleted 2026-09-04).** `dependabot-auto-merge.yml` was 448 lines on an
hourly cron, plus a 179-line decision script and a 250-line staleness library, and it existed for one
reason: a `pull_request` run from Dependabot gets no secrets, so the arming job inside
`ci.yml` could not mint an App token on its pull requests. `pull_request_target` runs in
the base repository's context, with its secrets, for every pull request - so one file now covers the
whole population. What went with the sweep, and what did not:

| The sweep did                                                          | Now                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| Armed Dependabot's pull requests                                       | `arm-auto-merge.yml`, for everybody, on `pull_request_target` |
| Refused updates this repository has no gate for                        | `dependency-ceiling`, a job of `ci.yml` feeding `ci-passed`   |
| Asked Dependabot to rebase a branch whose gates had moved              | **Nothing, and nothing did before** - see below               |
| Failed hourly while any branch was stuck, mailing the owner every time | Gone with the cron                                            |

**The rebuild half never worked, which is why deleting it loses nothing that ran.**
`@dependabot recreate` and `@dependabot rebase` authorise by PUSH ACCESS, and an App _installation_
is not an account with push access: `Contents: write` is not the same permission. Measured refused
ten times out of ten, on eight pull requests, with two identities (`github-actions[bot]` and the
`canari-auto-merge` App). The underlying question - can a pull request that was green against an
older set of gates still merge - is answered where it matters instead: `ci.yml` also runs
on `push: main`, so a merge that breaks the trunk turns `CI passed` RED on `main`, and
`release-preflight.sh` gate 3 then refuses every release cut from that commit. The protection sits at
the release, which is the only place it changes anything.

**Nobody is assigned to any of it.** `.github/CODEOWNERS` requested a review from two humans on every
pull request in a repository whose written model is that no approval is required (user, 2026-08-31:
_"Je prefere blinder de test et faire les choses automatiquement qu'avoir une review humaine qui
n'arrive jamais"_). It was deleted on 2026-09-04 with the sweep, for the same reason: a notification
about a decision nobody makes.

### A Dependabot cargo bump that is incomplete by construction is completed and merged (WP-RUST-LOCK-AUTOMERGE, 2026-10-18)

`frontend/mls-wasm` and `frontend/src-tauri` commit a `Cargo.lock` and consume `frontend/mls-core` (no lock, on purpose) by path. Dependabot's one pull request for an `mls-core/Cargo.toml` bump therefore leaves both locks stale and fails CI's `cargo metadata --locked` step. It was the last dependency update that could not merge unattended; the user decided on 2026-10-18 that a machine completes it and `CI passed` stays the only verdict. The one-workspace remedy (one `Cargo.lock` for `frontend/`) stays the structural fix and is not done.

**Two halves, no new visible workflow** (the four-workflow rule holds; `shape.mjs` is green):

| Half | Where | What it does |
| --- | --- | --- |
| Completing | job `cargo-lock-refresh` of `scheduled.yml` (the daily 09:00 UTC slot it shares with `stores`; by hand: dispatch job `cargo-lock-refresh`, not part of `all`) running `.github/scripts/cargo-lock-refresh.sh` | for each open Dependabot cargo pull request `#n` whose commits are all signed Dependabot commits, whose files are all manifests and lockfiles, and which leaves a committed lock stale: builds `deps/lock-refresh/cargo/dependabot-<n>` from `main`, cherry-picks Dependabot's commits (author and trailers kept, committer the App), adds ONE App commit running `cargo update -p <crate> --precise <version>` in each stale lock, pushes and opens a pull request AS THE APP, closes `#n` with a pointer |
| Arming | a `# canari-only:` region in `arm-auto-merge.yml`'s authorisation step | arms an App-authored pull request only if every check of the allowlist below holds, and DISARMS one that stops holding |

**The arming allowlist, every item read over the API (the job still checks nothing out):**

1. the branch matches `^deps/lock-refresh/cargo/dependabot-<n>$`, and `#n` is a `dependabot[bot]` pull request from a `dependabot/cargo/` branch;
2. every commit of `#n` has the shape of a Dependabot commit: author login `dependabot[bot]` AND address `49699333+dependabot[bot]@users.noreply.github.com` AND committer `web-flow` AND `verification.verified: true` - the shape of every real one (read off #296 on 2026-10-19). **What that proves, exactly: GitHub created the commit, naming Dependabot - NOT that Dependabot made it.** `web-flow` signs whatever GitHub creates on someone's behalf, and a person with WRITE access can create a commit with any author through the API. The one unforgeable fact is the pull request's author, `dependabot[bot]`, from check 1. **The precondition is that write access is trusted already**: a writer can open and arm a pull request of their own, so the shape check protects the allowlist's meaning against a careless or lookalike commit, not a boundary against a writer. A NAME alone is nothing: `user.name = dependabot[bot]` costs nothing, and a `github-actions[bot]` merge commit is signed by `web-flow` too (#296 carries one);
3. this pull request is `#n`'s commits CARRIED BY CONTENT - same count, same order, same messages, AND the same patch: every `+`/`-` line of every file of each commit, read per commit (`commits/<sha>`, at most 20 per side), equals the original commit's - plus ONE commit on top, authored and committed by the App's login. **Who committed them is not what is relied on**: an address is not an identity and the App's commits are unsigned, so a commit's identity is never accepted in place of its content (a different App address still arms; a carried commit with the right message and another patch does not). A patch the API will not show is refused;
4. every file is a `Cargo.toml` or a `Cargo.lock`; the MANIFEST change, compared line for line (the `+`/`-` lines, so another base's context and line numbers do not matter), is the one in Dependabot's pull request; **every `source` key a lockfile GAINS has the crates.io value** (`"registry+https://github.com/rust-lang/crates.io-index"` or `"sparse+https://index.crates.io/"`, compared exactly), so no git or other-registry source arrives through a lock; and **no lockfile moves or adds a crate of the Tauri runtime** (`tauri`, `tauri-*`, `wry`, `tao`: a `name` key added, or a `version` key changed under one). **Every key is matched with ANY spacing, bare or quoted** (`source="..."`, ` source = "..."`, `"source" = ...`, `'name' = '...'`): Cargo writes `key = "value"`, but a check keyed on that spelling is one a hand-written lock walks past (`B31`, `B31b`; the refresh: `A36`, `A36b`, `A37`). `--locked` and the registry checksums hold the rest of a lock to its manifests;
5. `CI passed`, which GitHub reads, as for everybody - including `dependency-ceiling`, whose `if:` now covers every `deps/lock-refresh/` branch (the author there is the App, so a ceiling that read only `dependabot[bot]` would let exactly this one past). **On those branches the ceiling also re-applies the refresh's own refusals** - a Tauri-runtime crate and a breaking update (`ceiling_is_tauri_runtime_crate`, `ceiling_update_is_breaking`, the same functions the refresh calls) - so the pull request that gets ARMED is bound by them, not only the job that wrote it. On Dependabot's own branch nothing changes: the suite decides.

**An unreadable answer DISARMS.** The App path runs under an `ERR` trap: any API call that fails (including the "is it armed" read inside a refusal) disables auto-merge, logged loudly, and the run goes red. Without it, a `synchronize` run that could not evaluate the new head failed red and left the arming made for the OLD head standing on the new one. A refusal disarms unless the read says plainly "not armed". A list longer than one page is refused rather than paginated, and more than 20 commits on either side is refused before any per-commit read (`B29`).

**The arming is tied to ONE commit.** The evaluation must be of the event's head: the file list is read BEFORE the commit list, and the commit list must end on `github.event.pull_request.head.sha` - otherwise refused, and the run the new head raised decides (`B28`). The App path then arms ITSELF with `gh pr merge --auto --squash --match-head-commit <that sha>` (GraphQL `expectedHeadOid`), so GitHub refuses the arming if the head moved after the reads; it never hands the shared arming step `armable=true`, because that step arms without the binding and lives outside the `canari-only` region (changing it would fork the four repos).

**What the refresh refuses, and how a refusal is seen.** A commit that is not a signed Dependabot commit; a file that is not a manifest or a lockfile; a crate of the Tauri runtime (`tauri`, `tauri-*`, `wry`, `tao`), named by the trailer OR moved by the refresh in any lock (a runtime bump is a native work package owed a device reading); a BREAKING update (`ceiling_update_is_breaking` in `lib/ceiling.sh`: a major, a `0.x` minor, a `0.0.x` patch, or no `update-type` at all, which is how Dependabot writes a requirement update); a dependency `lib/ceiling.sh` has no gate for; a trailer whose name or version is not a crate name and a full semver; a `cargo update` that fails; a lock still failing `cargo metadata --locked` after it; a lock that gains a `source =` other than crates.io; commits that do not cherry-pick onto `main`; a refresh pull request a person closed; a branch of the reserved name that already exists with no pull request of the App's and a tip the App did not write. **The breaking refusal is this path's alone**: the ceiling itself still decides nothing on semver, because a break stops the suite on its own; the unattended second actor is the one that must not write lockfiles for a bump nobody asked for. Each refusal is written ONCE on the pull request (a marker) and listed in ONE issue, _Dependabot cargo updates the lockfile refresh refused_ - found by its exact title, updated each run, closed once nothing is refused. That is the split `cargo-unreachable` already uses: **the issue says there is work; a red run says the mechanism is broken** (an unreadable API, a cargo that cannot answer, a refused push or pull request).

**Idempotence is durable state, not a clock.** The branch name derives from `#n`, so a refresh pull request that exists decides everything (open or merged: close `#n`; closed by a person: refused, nothing reopened). **But the NAME is not ours alone**: anybody can open a pull request from a fork on a branch of that name, and `gh pr list --head` matches by name. So only pull requests from THIS repository (`isCrossRepository == false`) AUTHORED BY THE App (`app/<slug>`) count, the newest by `createdAt` when there are several; any other is ignored and named once in the issue (and the issue then stays open, so it is seen). A run that died after its push and before its pull request leaves a branch the next run overwrites, with `--force-with-lease` on the SHA it just read - **and only when that branch's tip was authored by the App**: a branch of the reserved name with no App pull request and a tip somebody else wrote is refused, never overwritten. A run that died before closing `#n` is finished by the next one. The job has its own concurrency group, so two runs never both read "no pull request yet".

**Never a push onto Dependabot's branch** (refused ten times out of ten, see above): the original is closed with a pointer, and Dependabot then stops proposing that version.

#### The threat model - this mechanism ARMS MERGES

| Who | What they could try | What stops it |
| --- | --- | --- |
| A fork contributor | open a pull request on a `deps/lock-refresh/...` branch, to get it ARMED | `arm-auto-merge.yml` only considers branches of THIS repository, and only the App's login (unforgeable: it is the pull request's author as GitHub records it) |
| A fork contributor | open a pull request NAMED `deps/lock-refresh/cargo/dependabot-<n>`, so the refresh reads it as its own and closes Dependabot's `#n` "superseded by" the attacker's pull request, or (closed) suppresses `#n` for good | the refresh counts only same-repository pull requests authored by the App; the fork's is ignored and named in the issue (`A30`, `A31`) |
| Anybody with push access | create the reserved branch first, so the refresh force-pushes over it or adopts it | the refresh overwrites a branch with no App pull request only when its tip was authored by the App; otherwise refused and reported (`A33`) |
| Anybody with push access | push a commit onto an armed refresh pull request | the `synchronize` run re-evaluates the allowlist and DISARMS it - and an API failure during that run disarms too (`B21`, `B22`); a push landing between the reads and the arming is refused by the head binding (`B28`). Such a person can already open and arm a pull request of their own, so this protects the allowlist's meaning, not a boundary |
| A lookalike commit | author name `dependabot[bot]`, or a signed commit of another bot | the login, the address, the committer and GitHub's signature verdict are all required, by the refresh AND by the arming; and the arming compares the carried commits by PATCH, not by message (`B23`). The shape proves GitHub made the commit, not Dependabot (item 2 above) |
| A lockfile as a carrier | a git or other-registry `source`, or a moved Tauri-runtime crate, in the App's lock commit | the refresh refuses a non-crates.io source before committing (`A34`, any spelling `A36`, `A36b`); the arming refuses one (`B24`, `B24b`, any spelling `B31`) and refuses a moved or added runtime crate (`B25`, `B25b`, any spelling `B31b`); the ceiling refuses runtime and breaking updates on the refresh branch |
| A hostile title, branch, body or trailer | shell or option injection | no `${{ }}` of an untrusted string in any `run:`; the branch is matched against an anchored regex before use and the head is fetched as `refs/pull/<n>/head`; pull-request numbers must be digits; crate names must start with a letter and versions be full semver before they reach cargo or a regex; the title is stripped to printable characters and passed as ONE argument; the arming compares strings inside `jq`, never in the shell; nothing is `eval`ed |
| An upstream crate | a malicious release Dependabot proposes | out of scope here, as for every Dependabot update: `CI passed`, the ceiling, and the fact that a merge does not deploy |
| The job's credentials | the App token sits in the job while cargo reads Dependabot's manifests | `cargo metadata` and `cargo update` resolve and fetch, they run no build script; the token is minted with `contents: write` and `pull-requests: write` ONLY (`permission-contents` / `permission-pull-requests`, inputs read in the action's own `v3` `action.yml`; the ARMING token is not narrowed, because its minting step is shared by the four repos and arms everybody's pull requests), and the issue is written with `GITHUB_TOKEN` (`issues: write`), so the App needs no Issues permission |

**Tests**, all offline: `tests/cargo-lock-refresh.test.sh` (a real git with a bare remote serving `refs/pull/<n>/head`, a fake `cargo`, and a STATEFUL fake `gh` whose pull requests and issues live in JSON, every `--jq` run by the real jq, commit identities derived from the commits the way GitHub derives them), `tests/arm-auto-merge-app.test.sh` (extracts the YAML's own `run:` text and runs it against API-shaped fixtures), `tests/ceiling.test.sh` (the shared trailer parser and the breaking predicate), and `tests/dependency-ceiling.test.sh` (the runtime and breaking refusals on a refresh branch, and their absence on Dependabot's own). `shape.mjs` cuts the `# canari-only:` region before comparing the four copies of `arm-auto-merge.yml`, so every edit outside it still forks.

**Unmeasured until the first live run:** that the API resolves the App's commits (committer of the cherry-picks, author and committer of the lock commit, address `<app user id>+canari-auto-merge[bot]@users.noreply.github.com`) to the login `canari-auto-merge[bot]`, and that `gh pr list` reports the App's pull requests as `app/canari-auto-merge`. Read, not measured: `gh pr merge --auto --match-head-commit` sends the SHA as `expectedHeadOid` of `enablePullRequestAutoMerge` (gh `v2.88.0`, `pkg/cmd/pr/merge/http.go`, and the GraphQL input exists, both read 2026-10-19); the offline test asserts the flag is passed, not what GitHub does with it. If it does not, the refresh pull request is NOT armed - the safe direction - and the arming log says which check refused it.

### Every update merges onto `main`, and what protects production is that a merge does not deploy

For one day (2026-09-02) all six blocks of `dependabot.yml` carried `target-branch: "dev"`, asked by
the user (_"Est-ce qu'on pourrait dire a Dependabot de push sur la branche dev au lieu de la prod
?"_). The user cancelled the two-branch model the following day; the lines are gone and updates
merge onto `main` again.

**The danger they answered has MOVED, not gone.** Every gate in this repository answers a question
about the SOURCE - does it compile, do the tests pass, is the lockfile coherent. None runs anything
against real data, and that is the class the outage of 2026-09-01 came from: `postgres
15-alpine -> 18-alpine` passed every gate, merged, and PG 18 then refused production's data
directory. 33 minutes down.

**What stands between that update and production now is that nothing deploys at a merge.** An update
sits on `main` until somebody publishes a release, and a `X.X.X-alpha.N` pre-release deploys the dev
estate - which holds a fictional seed, not production's data - before any stable does. The honest difference is
WHO DECIDES: the old mechanism ran with nobody at the keyboard, this one runs when a human publishes
an alpha. The ceiling in `ci.yml`'s `Dependency ceiling` check is what still refuses the update classes
this repository cannot see the failure mode of; it is not a substitute for a rehearsal, and
[backlog](backlog.md) says so.

**Two cables into CD were cut on 2026-09-03, and one was replaced rather than removed:**

- The **convergent trigger** was `CD - Deploy to Production`'s completion, because CD ran on every
  push to `main` and was therefore the closest thing to "somebody did something". CD runs once per
  release now, so hanging the sweep off it would drain the queue once a release. **`CI` took that
  job**, being what runs on every push to `main`.
- The **deploy dispatched after a merge** is gone. It existed because a `GITHUB_TOKEN` squash merge
  raises no `push` event - github's anti-recursion rule - so CD never saw a single merge and `main`
  drifted from production silently. There is no deploy to dispatch any more. **The dispatch itself
  survives, pointed at `ci.yml`**: the same anti-recursion rule means CI would not run on `main`
  either, and CI is what says whether the merged COMBINATION is green and what wakes the next sweep.

The **staleness comparison** still reads the pull request's own `baseRefName` rather than a `main`
literal. It is `main` for everything now, but that line is what would have to change the next time a
second branch exists, and hardcoding it is what made the previous switch a hazard rather than a
setting.

### Security updates are a SECOND switch, and neither `dependabot.yml` nor this page showed it

Dependabot has two independent halves, and only one of them lives in a file anybody reads.
`repos/{owner}/{repo}/vulnerability-alerts` decides whether an advisory is REPORTED; a separate
`repos/{owner}/{repo}/automated-security-fixes` decides whether one is ever FIXED by a pull request.
Until 2026-09-02 the first was on and the second was `{"enabled":false}`, so a push printing
`GitHub found 1 vulnerability on the default branch` was announcing an advisory with no actor at all.
Both are read with one call each:

```sh
gh api repos/emse-students/canari/vulnerability-alerts    # 204 = on, 404 = off
gh api repos/emse-students/canari/automated-security-fixes
```

**And the two halves interact in the direction nobody expects.** A security pull request ignores the
`update-types` restrictions in `dependabot.yml` - but only while the feature that opens it is
enabled. With it disabled, a conservative version-update rule silently BECOMES the security policy:
`cargo`'s `production-dependencies` group is capped at `update-types: ["patch"]`, so the minor bump
that carried GHSA-7gcf-g7xr-8hxj (`serde_with` 3.19.0 -> 3.21.0, in `frontend/src-tauri/Cargo.lock`)
was unreachable by every route at once. Check both switches, per ecosystem, and do not hand-patch the
lock instead - `cargo update -p serde_with --precise 3.21.0` also added `bs58` and dropped three
`windows-*` crates, a resolver-wide change on the one target this repository can only verify by
compiling. The rule is in [durable-rules](durable-rules.md).

### Native and identity-provider manifests (2026-10-23)

A dependency audit found three committed manifest trees nothing watched. What is declared now, and
what is deliberately not:

| Tree | Dependabot | What gates an update |
| --- | --- | --- |
| `frontend/src-tauri/gen/android` (Gradle: AGP in `buildSrc`, Firebase, AndroidX, the wrapper) | `gradle`, its own block | **Nothing on a pull request**, so `ceiling_gate_for_ref` (`lib/ceiling.sh`) refuses every update there. The `:app` module cannot be configured without the generated, git-ignored `tauri.settings.gradle` and the `google-services.json` secret; only `android.yml` builds it, at release time. The refusal names the missing gate: a pull-request job that compiles `:app`. |
| `frontend/src-tauri/android-tests` (the JVM test project) | `gradle`, its own block | `test-android`, which builds and runs it whenever it changes. The only Gradle directory the ceiling lets through - an allowlist, so a new Gradle directory starts refused. |
| `frontend/src-tauri/gen/apple` | **not declared** | The Podfile declares no pod, CocoaPods is not a Dependabot ecosystem, and the `swift` ecosystem reads `Package.swift` while Firebase is pinned in `project.pbxproj` + `Package.resolved` of an Xcode project. `firebase-ios-sdk` moves by hand. |
| `infrastructure/authentik/compose.yml` | `docker-compose`, its own block | The ceiling's datastore arm, against **this file's** PostgreSQL major. |

**Why the identity provider's file needed a ceiling change before it could be watched.** Its
PostgreSQL ran 16 while production ran 18 (2026-10-23). Dependabot proposes the highest tag with the
same suffix, so its first pull request there is `16-alpine -> 18-alpine`; compared with
production's compose file - the only one the ceiling read - that is "the major production runs" and
it would have passed: the 2026-09-01 outage, moved onto the database every sign-in depends on. So
`ceiling_compose_from_ref` reads the directory off Dependabot's branch
(`dependabot/docker_compose/infrastructure/authentik/...`) and the datastore arm compares with that
file; `version-gap.yml`, which records rehearsals of PRODUCTION's data directory, lifts nothing
there. Image names are compared without `docker.io/library/`, which that file spells and production's
does not (`ceiling_image_name`). The `dependency-ceiling` job's sparse checkout carries the file, and
`ceiling.test.sh` derives the stateful images from it exactly as it does from production's.

**Each new directory has its OWN block** rather than joining a `directories:` list, because the
ceiling reads the directory off the branch name, and one block per directory is what guarantees the
branch carries it.

**Two things this does not cover, owed a decision rather than code:**

- **The authentik server and worker images are invisible to Dependabot.** They are written
  `${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:${AUTHENTIK_TAG:-2026.8.0}` so the host's `.env`
  can override them, and Dependabot does not resolve an interpolated reference. A literal reference
  would be watched (and `test-miconnect-blueprints` boots it, so an update would be gated) but would
  take the `.env` override away on a host this repository does not own. That is the operator's call.
- **`gen/android` may not resolve at all.** Its `settings.gradle` applies the git-ignored
  `tauri.settings.gradle`; if Dependabot's update job fails on it, the symptom is an absence of pull
  requests, exactly as for the two cargo directories below. Read the first Monday's update job.

### And a manifest can make a whole directory invisible to Dependabot

Enabling the switch above did not ship the fix, because a THIRD refusal was waiting under it, and
this is the one worth carrying. Dependabot tried within the minute and its update job failed on
`cargo`'s own parse:

```
error: failed to get `tauri-plugin-customtabs` as a dependency of package `canari v0.14.15`
Caused by: package specifies that it links to `tauri-plugin-customtabs`
           but does not have a custom build script
```

`build.rs` is committed and present in the working tree. **Dependabot materialises a temp checkout
of manifests and lockfiles only**, so a `links` key with no build script beside it is a manifest
cargo refuses to read - and the key arrived with the plugin on 2026-08-08 (`7cf394f3`). Every cargo
update in `frontend/src-tauri` has been impossible since, security ones included, and nothing said
so: the graph simply stopped producing pull requests. **The population is the proof, not the log** -
that directory has produced exactly ONE Dependabot pull request ever, #195 on 2026-07-24, while
`/frontend/mls-core`, in the same ecosystem entry of `dependabot.yml`, produced three on 2026-08-31.
**THE WAY OUT TAKEN, AND THE TWO THAT ARE REFUTED (user, 2026-09-10 - both mechanisms shipped, so
this is closed and the two refutations are here to stop it being re-opened).**

**Removing `links` from the plugin manifest is WRONG, not merely risky, and the proof is a generated
file rather than an argument about cargo.** `links` is what makes cargo export a build script's
`cargo:KEY=VALUE` metadata to dependents as `DEP_<LINKS>_KEY`, and this build script emits exactly
the two keys `tauri-build` needs - `android_path` and `ios_path`. Without `links` cargo does not
propagate them at all, so `tauri-build` never learns where the plugin's Kotlin lives.
`frontend/src-tauri/gen/android/tauri.settings.gradle` is that propagation's OUTPUT and says so in
its first line (_"THIS IS AN AUTOGENERATED FILE"_):

```
include ':tauri-plugin-customtabs'
project(':tauri-plugin-customtabs').projectDir = new File(".../plugins/tauri-plugin-customtabs/android")
```

Every one of the nine plugins listed there declares `links`, the two LOCAL ones included - and the
`tauri-plugin-keystore` patch is the second. Drop the key and that `include` disappears, the Kotlin
never compiles into the app, and `open_custom_tab` fails at runtime on a phone **while everything
still builds green** - the exact class three iOS defects already came from. So the option is closed
for the whole local-plugin family, not for one crate. **Undeclaring the two directories** is the
other refusal: honest bookkeeping, no risk, and it makes the artefact that ships to phones
permanently unmanaged, which is what _"un projet qui peut vivre tout seul"_ is against.

**So both stay declared and are updated deliberately, behind two named mechanisms**, because
"somebody remembers" is not one. `dependabot-cargo-reach.test.sh` (in `make test-ci-scripts`) derives
the blocked directories from `dependabot.yml` by following every `path = ` dependency and collecting
the manifests declaring `links`, then compares that set against a pinned one - so a NEW blocked
directory fails on the day it is committed. `cargo-blocked-update-report.sh` runs `cargo update
--dry-run` in them on the Monday cron and OPENS AN ISSUE when the tree is behind; its header carries
why the report is an issue and not a red run, and the four ways an empty answer can lie.

### A vendored fork is watched for upstream releases (2026-10-21)

Neither mechanism above reaches a crate replaced through `[patch.crates-io]` by a copy under
`frontend/src-tauri/patches/`: its `=X.Y.Z` pin is one `cargo update` cannot move, and whether
`cargo audit` matches advisories against a PATH package was never verified. Job `vendored-upstream`
of `scheduled.yml` (the Monday `0 4 * * 1` slot it shares with `cargo-unreachable`; by hand: dispatch
job `vendored-upstream`) runs `.github/scripts/vendored-upstream-report.sh`, which compares, for each
crate on its ALLOWLIST (today `tauri-plugin-websocket` alone - [backlog](backlog.md) holds the two
other forks), the fork's `[package]` version with crates.io's `max_stable_version`. Pre-releases are
ignored on purpose: upstream has a `3.0.0-alpha` line, and a fork of a stable owes it nothing.

| Exit | Means | Title |
| --- | --- | --- |
| 0 | every watched fork is upstream's latest stable | - |
| 1 | upstream released past the fork (the message names the rebase: the release, the `CANARI PATCH` hunk count, the pin to move), or the forked release was yanked | `Upstream <crate> released past the vendored fork`, `Upstream withdrew the release <crate> was forked from` |
| 1 | the reporter is broken: an allowlist entry the manifest no longer patches, a pin that does not name the fork's version (the patch would silently not apply), a 404, any unexpected status, a response with no usable version | `Stale vendored-fork allowlist entry`, `Vendored fork and its pin disagree`, `Vendored-fork watch is broken` |
| 75 | crates.io did not answer after curl's own bounded retries (transport, 408, 429, 5xx); a finding in the same run wins | `crates.io unreachable - not a finding` |

**Exits 1 and 75 look the same in `gh run list`** (both are an ordinary failed run): the
annotation TITLE in the run summary is what tells a finding from an unreachable registry, without
opening the log. The response body is written with `-o` to a file, never captured from stdout: with
`--retry`, curl prints a failed attempt's body to stdout ahead of the successful one, so a 503 then
a 200 read from stdout would be a false "broken reporter".

**A red run is the report, like `alerts` and unlike `cargo-unreachable`**: a fork behind upstream is
a rebase owed, not the normal state of a tree. `tests/vendored-upstream-report.test.sh` (in `make
test-ci-scripts`) runs it against a fake `curl` and fixture trees - the control case is a newer
release that must fail - and once against the REAL tree, so a pin that drifts from its fork fails on
the pull request that drifts it.

### What it refuses, and why it is not a semver rule

**A ceiling on an automatic merge is a statement about your tests, never about the version number.**
The first ceiling written here refused every major and every `0.x` minor, and the measurement that
condemned it is that 33 pull requests were open and it refused 28 - a queue nobody drains is worse
than the merge it prevented (user, 2026-08-31: _"Je prefere blinder de test et faire les choses
automatiquement qu'avoir une review humaine qui n'arrive jamais"_).

`base64` 0.22 -> 0.23 and `axum` 0.7 -> 0.8 break by **not compiling**, which is exactly what the
suite sees. What a suite cannot see has no relation to semver: a dependency that **writes a format
something else must still read** changes behaviour while compiling perfectly. So the ceiling is a
list of dependencies whose failure mode is unobservable here, and **every entry names the test that
retires it**:

| Family                                                    | Why the suite is blind to it                                                                                                                            | The test that retires it                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `aes-gcm`                                                 | it opens a channel push sealed by ANOTHER member's device, so both directions are cross-version, and `src-tauri` freezes neither                        | a channel-push fixture                                                                                                     |
| `postgres`, `redis`, `garage` - **a major crossing only** | a datastore major is refused by the data ALREADY ON DISK, and every gate here creates its cluster from an EMPTY volume - the one case that always works | starting the new major against a data directory written by the old one, and proving the documented upgrade path carries it |

**Six families have already LEFT this table, which is what a refusal is for** - it names a missing
gate, and it goes the day the gate arrives. `@nestjs/*` left because `boot-nest-apps` constructs the
real `AppModule` on all four services, which alone moved the ceiling from 5 merge / 28 refuse to 26
merge / 6 refuse. `chacha20poly1305`, `argon2` and `ciborium` left because `cross_version_state.rs`
opens artefacts they sealed in v0.14.14, and for an AT-REST envelope - read only by the device that
wrote it - that backward direction is the whole question. Bare `typeorm` left because
`app-module.boot-spec.ts` now issues a real query through every entity the app registered.

**`webrtc*`, `str0m`, `sdp`, `ice`, `turn` and `stun` left on 2026-10-09**, retired by the test the row
named, taken in-process rather than by hand: `apps/call-service/tests/relay_path.rs` starts the
library's own TURN server on loopback, builds two peers the way the SFU builds them (default codecs and
interceptors, mDNS off, `RTCIceTransportPolicy::Relay`), and asserts that every candidate is `typ relay`,
ICE reaches `Connected`, a data-channel message crosses (DTLS and SCTP) and an opus RTP packet arrives
(SRTP). It runs in the `Call Service (SFU)` job of the Rust matrix whenever `apps/call-service/` changes,
which is every Dependabot cargo bump of it, in about 2 s once compiled. **What it does not cover:** the
SFU's forwarding logic (`main.rs` is a binary, so the test links the library directly), a browser peer,
renegotiation, and any TURN provider but the library's own - so the by-hand call in
[calls](frontend/modules/calls.md#the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)
stays owed before calling is revived. The `webrtc` 0.20 major is not refused by name any more: it does
not compile against this SFU, which the suite sees on its own, and the port meets this test.

**`openmls*`, `tls_codec*`, `hpke-rs*` and `libcrux*` left on 2026-09-15, and that one could not be
closed by a fixture at all.** For an at-rest envelope the reader is the writer, so bytes frozen once
answer the whole question; for a WIRE format the reader is another device on another version, and the
direction that had no evidence was the forward one - a frame minted TODAY arriving at a client still
running the old release. `aes-gcm` closed its equivalent on determinism, re-sealing a frozen plaintext
under a frozen key and nonce so that equal bytes settle both directions at once; an MLS frame carries a
random reuse guard, so there is nothing to reproduce and nothing to compare. The gate therefore RUNS THE
OLD CODE: [`mls-forward-compat.sh`](../../.github/scripts/mls-forward-compat.sh) checks `FIXTURE_VERSION`
out into a throwaway worktree, builds `frontend/mls-cross-version` - one driver depending on nothing but
`mls-core` through a relative path - against BOTH libraries, and has the two binaries hold one
conversation through files: the old side opens the group and admits today by Welcome, today mints a
frame the old side must read, and the old side mints one today must read.

Its own job in `ci.yml` runs it, and `ci-passed` needs that job, so a break blocks the merge. **The
filter that starts it is the load-bearing part**: a Dependabot bump of this family touches no source
file at all, only `frontend/mls-wasm/Cargo.lock` and `frontend/src-tauri/Cargo.lock`, so a path filter
naming `mls-core/**` would have skipped every pull request it was written to judge and every run would
have been green for the reason that nothing was asked. `.github/scripts/tests/mls-forward-compat.test.sh`
feeds that filter the file list a real bump produces and requires it to fire. What the gate does NOT
cover: one group, one epoch, one application frame each way - a change breaking only a removal, an
The live list is `Dependency ceiling` in `ci.yml`, which reads `.github/scripts/lib/ceiling.sh`: the table above is the whole of it.

A refusal is **never** routed to a human queue. It is posted as a comment on the pull request naming
the missing test, once, behind the marker `<!-- canari-auto-merge-ceiling -->`.

#### The table is DERIVED, because its failure mode is an absence (2026-09-01)

**The last two rows of that table cost a production outage, and the entry that would have prevented
it was not wrong - it was missing.** `postgres 15-alpine -> 18-alpine` merged at 10:33 on a fully
green suite, the dispatched deploy recreated the container, PostgreSQL 18 exited on startup against
the existing `postgres_data`, and eight services lost `auth_db` - the only database - for 33 minutes.
The CD run went red one step later, on `Run database migrations`, after thirty `pg_isready` attempts.
**The frontend kept answering 200 throughout**, which is why nothing looked wrong from outside.

Three things had to be true at once, and each is worth keeping:

- **A datastore major is the one failure mode this repository structurally cannot see.** `make
  run-ci`, `boot-nest-apps` and every compose stack initialise an EMPTY volume. Green means "18 can
  create a fresh cluster" and carries no information about the cluster production has.
- **Two comments asserted the ceiling "refuses any major".** It never has. `update-type` is parsed
  and used for nothing but a log line, deliberately - see the top of this section - and a comment
  claiming a rule is not the rule.
- **The obvious correction would not have worked either.** Replaying the real trailer parses to
  `postgres||18-alpine`: `update-type` is **empty**, because `15-alpine -> 18-alpine` is not a semver
  comparison Dependabot can make. A "refuse every major" rule would have called it unclassified and
  merged it exactly as the name table did. For a Docker tag the NAME is the only discriminator there
  is.

So the repair is not the missing row. The table moved to `.github/scripts/lib/ceiling.sh`, and
`.github/scripts/tests/ceiling.test.sh` **reads `docker-compose.prod.yml`** and demands an arm for
every third-party image that mounts a named volume - the same reasoning
`app-module.boot-spec.ts` uses to walk every registered entity rather than a named few. The next
stateful service is covered by whoever declares it. The test asserts the other direction too, so the
table cannot quietly widen into the blanket refusal this section exists to argue against, and the
sweep runs it **before** it may merge anything (`infrastructure/docker-compose.prod.yml` is in the
job's `sparse-checkout` for exactly that reason - the two move together).

**And the arm is no wider than the hazard, which took a second draft to get right.** Refusing the
whole NAME was the obvious reaction to the outage, and it is the opposite mistake: an on-disk format
is stable _within_ a major, so `redis 8.8-alpine -> 8.10-alpine` cannot meet the failure mode, and
two open pull requests (#306, #308) would have been frozen by it - turning "silently moving" into
"silently ageing", which is precisely what these digest pins were given a Dependabot ecosystem to
prevent. So the discriminator is the major **production runs**, read out of the compose file rather
than assumed, and three properties follow:

- **It fails closed.** An absent or unparseable `dependency-version`, or an image the compose file
  does not name, is refused. A false refusal costs one comment; the false pass cost 33 minutes.
- **A stateless image is allowed even across a major.** `adminer` mounts no volume, so there is no
  old data for a new version to refuse - and that line is what keeps the arm about STATE rather than
  about being a container.
- **Replayed against the live queue** the day it was written: #309 (`postgres 18-alpine`) refused,
  #306 and #308 (`redis 8.10-alpine`) allowed, #307 (`adminer`, digest only) allowed.

One operational consequence, learned twice on the day: **a fix applied to the box is erased by the
next deploy.** `serve-prod.yml` hard-resets the box to the released commit, so pinning the image back over SSH
restores service in seconds and survives exactly until the next dispatch - which is what happened at
13:29, when a deploy from an origin still carrying 18 took production down a second time. The manual
repair buys time to write the real one; it is never the repair.

Postgres CROSSED to 18 on 2026-09-18, in a window the user fixed, by the procedure in
[databases](infrastructure/databases.md#crossing-a-major-version---the-rehearsed-procedure) - a
logical migration onto a NEW volume, the 15 one kept intact. **The refusal was not retired by it and
must not be read as retired**: nothing in that crossing opened a data directory written by 15, so it
demonstrates nothing about `pg_upgrade`, and `lib/ceiling.sh` still declines the next postgres major
by name. What carried the crossing was a procedure and a window, never a green suite.

#### A refusal is retired by a DECLARED gap in dev, and exactly one kind of evidence counts

The datastore arm names the test that would lift it, and the dev environment is where that test can
be run: dev is deliberately allowed to run a stateful image one major ahead of production, on a copy
of production's data. `infrastructure/dev/version-gap.yml` is where the result is declared, one row
per stateful image, and `lib/ceiling.sh` consults it - a row whose gap is declared **and proven**
releases exactly the major it was proven for, and nothing else.

**The reason it is a declaration and not a comparison** is that the obvious gate - assert dev and
prod pin the same major - would fire on the very difference the environment exists to carry, and
would be deleted the first time it did. So the difference is stated, and what is asserted is that the
statement matches both compose files. `tests/dev-gap.test.sh` derives the row set from the images
production mounts a named volume for, so a stateful service added later is covered by whoever
declares it rather than by whoever remembers this file.

**AND THE PART THAT MATTERS MOST WAS FOUND WHILE BUILDING IT: A GREEN DEV DEPLOY IS NOT THE EVIDENCE
THE CEILING ASKS FOR.** The plan for the dev environment said that PostgreSQL 18 starting in dev on a
copy of production's data and serving `/api/version` would be the test that retires the `postgres`
refusal. It would not have been, and believing it would have re-armed the 2026-09-01 outage behind a
gate that reads as proof. Dev's data was a **logical** copy - `pg_dump` replayed into a cluster the
new major initialised itself, from empty - and since 2026-10-16 it is a schema plus a fictional seed
loaded the same way. Neither ever touches a data
directory written by the old major, and cannot fail the way production failed. It would have gone
green on 18 while saying nothing about `pg_upgrade` or the 18+ move of the mount point from
`/var/lib/postgresql/data` to `/var/lib/postgresql`. The next `postgres` major would then have
auto-merged on that green.

So each row states WHICH question its gap answers, and only one of the four answers lifts anything:

| `evidence`         | What it demonstrates                                                                                                                                                                                                                                                                                                                                | Lifts                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `none`             | There is no gap; dev runs production's major.                                                                                                                                                                                                                                                                                                       | nothing                      |
| `fresh_cluster`    | The new major serves a cluster it created from empty. This is what every gate here already proves, and it is the one case that always works.                                                                                                                                                                                                        | nothing                      |
| `logical_restore`  | The new major serves this application's schema and data loaded into it - a dump and restore, or since 2026-10-16 dev's schema-only restore plus the fictional seed. Worth having - it catches a schema or query the new major rejects - but the cluster is still one the new major built. **This is what the dev environment produces on its own.** | nothing                      |
| `in_place_upgrade` | The new major serves production's OWN data directory, carried across by the documented upgrade path, with the mount layout the new image expects.                                                                                                                                                                                                   | the refusal named in `lifts` |

It fails closed on every other input, proved against fixtures: the wrong evidence value, an
`in_place_upgrade` with an empty `proof`, a missing gap file, a different major, and a sibling image
in the same arm are all still refused.

### What the sweep taught, kept because the lessons outlive it

Three findings from the year the sweep ran, none of which depend on it existing:

- **A convergent trigger names an EVENT; a workflow is only ever its current proxy, and nothing
  announces the day one stops being the other.** The sweep hung off "CD completed" because CD ran on
  every push to `main`. When deployment moved to the version bump, that same trigger silently became
  "once per release" - weeks apart - and nothing said so.
- **Scheduled delivery on a public repository is best-effort, and GitHub DROPS the slots an hourly
  cron misses rather than queueing them.** `code-analysis.yml` asks for `0 2 * * *` and ran at 03:01,
  03:09, 08:05, 08:24, 08:47, 12:37 and 14:10 UTC on seven consecutive days. A clock is a floor under
  the worst case, never the thing a verdict waits on.
- **Counting deliveries is the wrong question; read one log.** Two of the four repositories had a
  sweep that was delivered, ran, went GREEN and had never executed anything - the script landed
  without its executable bit, `Permission denied` on every pull request, `merged 0`, six consecutive
  green passes in Sky. The step swallowed a non-zero status by design so one unmergeable branch could
  not stop the sweep, and it swallowed "the script could not run" with it. No count would ever have
  found that.

**And one about check runs, which is why `push: main` matters.** A check-run's conclusion is evidence
about the workflow that PRODUCED it, not the ones `main` carries today. PR #272 was `CLEAN` with
every check green and no `Boot the real AppModule` run at all, because that job was written after its
CI last ran: **an absent check and an inapplicable one look identical**, so "nothing failed" is not a
merge condition. The sweep tried to answer this per pull request and got the predicate wrong twice -
too wide, then measured unsound when narrowed. It is answered on `main` now, after the fact and
before any release.

### One changelog, three destinations, and the one that had never received it

`store/whats-new.txt` is the one text a stable release owes a human (user, 2026-09-03: the changelog
can be the same on every platform, and in the GitHub console at the version bump). Until that day it
reached exactly ONE of the three:

| Destination    | Before                                                                             | Now                                                            |
| -------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| App Store      | `whatsNew` on every version localization, then the version is submitted for review | unchanged                                                      |
| Google Play    | **nothing at all**                                                                 | `whatsnew-fr-FR` and `whatsnew-en-US`, via `whatsNewDirectory` |
| GitHub release | whatever a human typed, or nothing                                                 | the same notes, in a marker-delimited block                    |

**PLAY'S SILENCE IS THE FINDING, AND IT IS THE ASYMMETRY THAT HID IT.** A _wrong_ what's-new is
refused by the API; a _missing_ one is not - the field simply keeps whatever it held. So every
release told iOS users what had changed and left Android users with the previous text, and no gate,
log line or review would ever have said so. It was found by asking what read `store/whats-new.txt`:
`submit.mjs`, and nothing else.

**ONE IMPLEMENTATION OF THE NOTES RULE, THREE CALLERS.** `submit.mjs --check-notes` is the fifth
preflight gate; `--print-notes` is what the Play arm and the notes job read the text through. The
alternative was `tail -n +2` in two workflows, which is three opinions about the version marker, the
trim and the length ceiling - drifting the day the format changes. `release-chain.test.sh` asserts
that nothing else reads the file in code, and the predicate drops COMMENT lines, because the first
draft accused three files that merely name it while explaining where the notes come from.

**THE GITHUB RELEASE JOB RUNS BESIDE THE THREE ARMS AND NOTHING DEPENDS ON IT**, which is not
tidiness: on `v0.16.0` a refused release update `skipped` TestFlight and the App Store submission
behind it, so production and Play shipped and Apple got nothing. A release body is a convenience;
the stores are the deliverable. A refusal here fails the run loudly and can skip none of them - and
it would be a second instance of that unexplained 403 on a different endpoint, which is evidence
the open P1 does not have yet.

Its composition is `.github/scripts/release-notes-body.sh`, a pure function of two files, kept out
of the YAML for the usual reason: its interesting inputs are ones a live release never produces - a
body carrying a STALE block, a body with the markers and nothing between them, a body of pure
whitespace. **Idempotence is the property that is silent when wrong**: a composer that appends
rather than replaces grows the body by one copy of the notes per re-run, and a release is re-run
exactly when something else already went wrong, so the damage reads as the other failure's
consequence. Eleven assertions, and the mutation that makes the block-strip a no-op fails three.

**TWO THINGS WERE MEASURED RATHER THAN ASSUMED, and both were about to become constants:**

- **The Play listing's locales are `fr-FR` and `en-US`** - read through the Publishing API on
  2026-09-03, in an edit that was deleted and never committed. A `whatsnew-<LOCALE>` file for a
  locale the listing lacks is refused, and a missing one is silent, so guessing here fails in the
  invisible direction.
- **Play's release notes are capped at 500 characters, and the FIRST measurement of this said the
  opposite.** The API reference states no limit, and `PATCH` on a track accepted 400, 500, 501, 1000
  and 5000 characters - so "no Play ceiling is encoded" was written here, with a caveat that the
  edit had never been COMMITTED and commit-time validation was therefore unexercised. **That caveat
  is what turned out to matter.** `POST edits:validate` runs a commit's validation and changes
  nothing:

  ```
  532 (the first 0.16.1 notes)  ->  403  "notes in language fr-FR with length 532,
                                          which is too long (max: 500)"
  499                           ->  200  valid
  501                           ->  403  same message
  ```

  `PATCH` only stores the draft. So the Console's 500 IS the API's, enforced at validate/commit
  time, and **the gate now carries the TIGHTEST of the three destinations** -
  `min(Apple 4000, Play 500)` in `submit.mjs`, with a message naming which one binds. Without it the
  fifth gate passes in seconds and the Android arm dies at the store step after a twenty-minute
  build, which is learning by failing what a fact could have told us. `0.16.1`'s notes were 532
  characters when this was found.

### Never write to somebody else's pull request, and the day that cost seven of them

Kept because the mechanism is gone and the lesson is not. The sweep rebuilt stale branches with
`PUT /repos/{owner}/{repo}/pulls/{n}/update-branch` - the obvious API - which pushes a merge commit
authored by `github-actions[bot]`. On 2026-08-31 that cost three things at once, across seven pull
requests:

1. **The re-triggered `pull_request` run is created as `action_required`**, parked until a human
   clicks Approve. A push authored by Dependabot is not. Twenty runs were sitting there.
2. **Dependabot then refuses the branch permanently**: _"Looks like this PR has been edited by
   someone other than Dependabot. That means Dependabot can't rebase it - sorry!"_
3. The branch was no longer _stale_ either - `update-branch` had made its base current `main` - so it
   passed straight through to a merge decision reading checks that would never complete.

**The step written to drain the queue was the one filling it.** Nothing in this repository writes to
a pull request's branch any more.

### Two traps in reading Dependabot's own commit trailers

- **Dependabot YAML-quotes a dependency name starting with `@`**, so the commit trailer reads
  `"@nestjs/common"` with the quotes. A `case` on `@nestjs/*` matches nothing - which is how a first
  draft merged the exact major it was written to refuse. `dependency-ceiling.sh` strips the quotes.
- **A "update the requirement to permit the latest version" pull request carries no `update-type`
  trailer at all** (PR #297, openmls 0.9.0), so any logic keyed on the update type reads an empty
  string. Treat unknown as major.

The `updated-dependencies` trailers are parsed **as blocks**, never as three independent `sed`
lists: a grouped pull request carries several, and an update Dependabot could not classify has no
`update-type`, so three lists pasted side by side would pair the wrong name with the wrong version.

### The two duplicate gates, and why they are two

`.github/scripts/lib/declared-duplicates.mjs` holds ONE list, read by two self-tests asking
opposite questions.

| Gate                             | Question                                   | Fails when                                                                |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `declared-duplicates.test.mjs`   | do the copies we DECIDED on still agree?   | a group drifts - three of four agreeing is the failure it names           |
| `undeclared-duplicates.test.mjs` | is this duplicate one somebody decided on? | a function body is identical across two files and appears in neither list |

The second was written on 2026-09-16 because the first is blind to the dangerous half: a copy
nobody declared is a copy nobody will remember to update. It walks `frontend/src` and `apps` in ONE
pass - so a body shared between the client and a service is seen as one group - extracts function
bodies by brace balance, normalises away comments, blank lines and indentation, and hashes them.

Two disposals silence a group, both requiring a `why`: **`DECLARED_GROUPS`** (the copies must
agree, and the other gate then enforces that) or **`ACKNOWLEDGED_IDIOMS`** (their agreeing means
nothing, so the entry must argue a divergence would be harmless). There is deliberately no third.

**What it cannot see**, so a green run is not mistaken for a proof: two copies that have ALREADY
drifted by one character are invisible to it - which is the state the calendar defect was in. It
reads `.ts` and `.svelte` only, skips tests and generated trees, and ignores bodies under four
normalised lines. The threshold is four rather than five on purpose: the only idiom below five is
acknowledged by name, and a threshold chosen to clear the awkward case silences it without anybody
reading it, plus every future case that happens to be the same length.

### Verifying a change to the CI scripts

The decisions live in `.github/scripts/lib/` precisely so they can be exercised on inputs GitHub
will not produce on demand, and `make test-ci-scripts` runs every suite in seconds. Change a
decision, change its assertion, and prove the assertion by breaking the thing it guards - a test
that passes on a mutation is a test that asserts nothing.

**And lint before pushing, because this workstation has no `shellcheck` and CI does.** A change to
these scripts went red on 2026-09-01 for two findings a local run would have named in one second
(`SC1091` - `# shellcheck source-path=SCRIPTDIR` is **per-command, not per-file**, so a second
`source` needs its own copy - and `SC2016` on a `'${'` case pattern that meant the brace literally).
Fetch the pinned version into a scratch directory and use the invocation `ci.yml` uses:

```sh
curl -sSL -o sc.zip https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.zip
# unzip, then, from the repo root:
./shellcheck.exe -x .github/scripts/*.sh .github/scripts/lib/*.sh .github/scripts/tests/*.sh
```

### The npm advisory endpoint's silence is not a verdict, and telling them apart is one script

`bun audit` exits **1** for `POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503`
exactly as it exits 1 for a real advisory. On 2026-09-03 that turned a five-minute npm outage into a
red `Check Dependencies Vulnerabilities`, a red `CI passed`, and a repository in which nothing could
merge - over a tree in which nothing was wrong. It bit on that day and not before because the
security pass had just become part of `CI passed`; the same 503 a week earlier produced a red tick
nobody was waiting on.

`.github/scripts/audit-dependencies.sh` is the only place that runs `bun audit`, and it answers with
three exit codes rather than two:

| Exit | What it means                                     | Who decides what it costs |
| ---- | ------------------------------------------------- | ------------------------- |
| `0`  | the registry answered and the tree is clean       | -                         |
| `1`  | the registry answered and named an advisory       | always a failure          |
| `2`  | the registry never answered, after three attempts | **the caller**            |

**A `2` is not a verdict about the tree**, so what it costs is passed in as
`registry_outage_is_failure`, an input on `code-analysis.yml`:

- **a pull request tolerates it.** A refusal whose only remedy is unavailable is a stop, not a gate,
  and nobody in this repository can restore npm.
- **the nightly `scheduled.yml` pass FAILS on it.** Nothing is queued behind that run, so the
  failure costs no merge and IS the report: this tree has now gone a day unaudited. Without that
  half, a tolerated outage quietly becomes a tree nobody has audited in a week, with only warnings
  in closed logs to show for it.

### And the audit is not the whole question, because GitHub knows things it does not

`bun audit` and `cargo audit` each read ONE advisory database and each need a manifest they can
parse. GitHub reads its own, needs neither, and raises alerts against the default branch that
nothing here used to look at. On 2026-09-04 that gap was measured rather than supposed:
GHSA-7gcf-g7xr-8hxj (serde_with, in `frontend/src-tauri/Cargo.lock`) was invisible to all three of
the mechanisms meant to catch it - Dependabot could not open the pull request, `cargo audit` exited
0 because the advisory is GHSA-only, and no gate read the alert list.

`.github/scripts/github-alerts-report.sh dependabot` is that third reader, in the nightly pass on
the same 02:00 cron. **The same script reads the CODE SCANNING list too** (`... code-scanning`,
2026-10-04), because the pull-request `CodeQL` check refuses only a NEW alert: a standing one failed
nothing, and alert 2521 stood four weeks until somebody listed the alerts by hand. Every open code
scanning alert now makes the nightly red; a false positive is closed by dismissing it on GitHub, the
one place that records why. **It is not on the pull-request path and must not go there**: the alert list is a
property of the DEFAULT BRANCH, so a pull request can neither be blamed for an open alert nor
sensibly blocked by one, and putting it there would wall every merge on a fact about `main`.

**It answers the four causes of an empty list separately**, which is the whole of its design: a 200
with no alerts is health; a 403 means the token may not read alerts and NOTHING looked; a 404 means
the feature is disabled or the slug is wrong; no response is a transport failure. The last three
fail by name. The same rule as the `2` above, in a different place: _a refusal is not a clean
report._

**The unknown case fails CLOSED, and that stopped being hypothetical within the hour.** Only a
narrow list of recognised transport failures is classified as silence; anything else is a finding.
**The wording differs by bun version** - the same npm 503, the same evening, in two repositories:

| bun   | the line                                                                         |
| ----- | -------------------------------------------------------------------------------- |
| 1.4.0 | `error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503` |
| 1.3.8 | `error: audit request failed (status 503)`                                       |

The portal met the second with a classifier that knew only the first, and it did exactly what it
should: reported a finding, went red, and was fixed. Both shapes are now asserted, so a repository's
bun version stops being able to decide the verdict. _A classifier that fails open on its own blind
spot stops auditing and reports success for ever._ `audit-dependencies.test.sh` asserts that direction explicitly, alongside
both sides of the distinction, the policy flip, and the fact that the `--ignore=` flags the one
suppressed advisory rests on still reach the tool.

**AND THE RATE IS MEASURED, because the rule says a fallback's name is not believed until it is -
AND THE FIRST MEASUREMENT WAS WRONG, in the way this repository's rules name explicitly.** It
counted `grep -c` over a log fetched per run and reported _six 503s in fifty requests, no exhausted
budget_. Two of those runs had returned **no log at all**, and a count over an empty string is
zero: an absence of data read as a verdict. The re-measurement checks every log's size and its step
marker first, and reports `UNREADABLE` rather than clean - the guard is the finding, not the
numbers.

Twelve readable `ci.yml` runs on 2026-09-04, five trees each, sixty tree-audits:

| run         | 503s | exhausted | which tree                                    |
| ----------- | ---- | --------- | --------------------------------------------- |
| 33857687014 | 2    | 0         | `chat-delivery-service`, `media-service`      |
| 33854391020 | 6    | 0         | `core-service`, `media-service`, `frontend`   |
| 33851910609 | 3    | 0         | `media-service`, `social-service`, `frontend` |
| 33850722894 | 4    | **2**     | `chat-delivery-service`, `media-service`      |
| 33849668875 | 4    | **2**     | `core-service`, `social-service`              |
| 33847721971 | 5    | **1**     | `media-service`, `social-service`             |
| 33836519287 | 0    | 0         | -                                             |
| 33835252690 | 1    | 0         | `core-service`                                |
| 33833975381 | 1    | 0         | `core-service`                                |
| 33832780239 | 0    | 0         | -                                             |
| 33831909478 | 0    | 0         | -                                             |
| 33831223145 | 0    | 0         | -                                             |

**Twenty-six 503s in sixty requests - 43% - and FIVE exhausted attempt budgets, which is five trees
that went unaudited and were tolerated.** Two further runs were unreadable and are excluded rather
than scored.

**THE RATE IS NOT STATIONARY, and that is the part a single number hides.** Read the table
bottom-up: the older six runs score 0, 0, 0, 0, 1, 1 and the newer six score 2, 6, 3, 4, 4, 5. The
endpoint degraded across one day. _A predicate that named the last incident is not the predicate
that names the next one_ applies to rates as much as to queries: any threshold set on the bottom
half of this table is already false at the top.

**WHAT THE DISTRIBUTION RULES OUT.** Not this pipeline's own request rate - the 503 lands on the
first, third and fourth tree indifferently, and a retry twenty seconds later often succeeds; a rate
limit would spare the first and punish the last. Not the size of the POST body - `frontend`, by a
wide margin the largest tree, is not over-represented. It is npm's advisory endpoint, and 43% is not
flakiness to tolerate: it is a dependency that fails two times in five.

**WHAT IT COST, IN BOTH CURRENCIES.** Each 503 is a full five-minute timeout, so twenty-six of them
is over two hours of runner time in one day - and `bun audit` takes about five minutes per tree even
when it SUCCEEDS, which is why one sequential job ran 14 to 39 minutes against two minutes for
CodeQL. **That is what made this the critical path of every pull request, and the audit became a
five-way matrix taken out of `CI passed`** (#369).

**IT GATES `CI passed` AGAIN SINCE 2026-09-29, ON AN ANSWER ONLY** (user). Out of the gate, it let
#1229 merge with a real advisory red on the job - GHSA-253c-mchw-3w2r in `markdown-it`, published an
hour before the run - fixed by #1230 after the fact. The classifier below already separates the two
things a gate must not confuse, so the job is back in `ci-passed`'s `needs` with
`registry_outage_is_failure: false`: exit 1 (an advisory, or anything unrecognised) blocks the
merge, exit 2 (npm never answered) passes as a warning. The cost accepted with it: a new advisory on
untouched code turns every pull request red until its fix merges, and an outage makes the job slow
without making it red. The block above `dependency-audit` in `ci.yml` is the only other copy.

**THE BACKOFF IS WHAT MAKES AN EXHAUSTED BUDGET MEAN SOMETHING.** `BACKOFF_BASE_S=20` sleeps 20s
then 40s, so three attempts span a minute plus `bun audit`'s own timeout. Three consecutive 503s are
therefore not three independent draws; they are one npm blip lasting minutes. That is what the
`0.16.2-alpha.1` bump commit met - three attempts, three 503s, exit 2, correct. The pass went red
anyway, because the CALLER could not read the answer, and that defect is above. _The classifier's
rate says the design is right; only its reader was wrong._

### Container images are scanned (2026-10-23)

`bun audit` and `cargo audit` read lockfiles; what an estate RUNS is images, and until 2026-10-23
nothing read them. `Dependency audit / Container image scan` (`code-analysis.yml`, job
`image-scan`) runs `.github/scripts/image-scan.sh`: Trivy, pinned by version and SHA-256 in the job's
`env`, over every image `image-scan-targets.sh` derives - the SHIPPED stage (last `FROM`) of each
`infrastructure/local/Dockerfile.*`, and every third-party `image:` of the production, dev and
identity-provider compose files, an interpolation read as its default. This repository's own images
are left out (they are their Dockerfile's base plus our code, which the lockfile audits read), and so
are builder stages and the local compose file, which reach no estate.

| Choice | Why |
| --- | --- |
| HIGH and CRITICAL, **with a fix published** (`--ignore-unfixed`) | a finding nobody can act on is a wall, not a gate |
| in the `dependencies` half, so it gates `CI passed` and runs nightly | same footing as the audits: a database that moves without a commit; exit `2` (database or registry unreachable) is priced by `registry_outage_is_failure` |
| the allowlist is `.github/image-scan-allowlist.yaml`, Trivy's own format | one entry per advisory, each with a `statement`; `image-scan-allowlist.test.mjs` refuses a missing statement, an unknown key and any `expired_at` - an entry retires on evidence, never on a date |
| **every entry retires itself** | each image is rescanned WITHOUT the allowlist and `ignored-advisories-still-reported.sh` (media-service's check) fails on an id nothing reports any more. A pull request that moves a pin deletes the entries it made unnecessary in the same commit |
| Trivy from its release tarball, not `aquasecurity/trivy-action` | a tag can move, a checksum cannot. **Nothing watches the pin**: move it by changing `TRIVY_VERSION` and `TRIVY_SHA256` together, the checksum read from that release's `trivy_<v>_checksums.txt` |

**What the first measurement found (Trivy 0.75.0, 2026-10-23), and what each became:**

- `postgres:18-alpine` (production, dev, local, the CI service containers) carried fixable OpenSSL and
  `libuuid` advisories: **the digest moved** to the current `18-alpine` build, same major.
- `nginx:1.31.7-alpine` (the edge, production and dev) carried `libexpat` and `libx11`: **moved to
  `1.31.8-alpine`**, which carries neither.
- `gosu` in both postgres images (26 Go standard-library advisories): **allowlisted** - it runs once
  in the entrypoint to drop privileges and `exec`s postgres, so that code never runs; the newest
  upstream image still ships the same build.
- npm bundled in `node:24-alpine` (3): **allowlisted** - `frontend-ssr` runs `node index.js` and never
  invokes npm.
- `ghcr.io/goauthentik/server:2026.8.0` (41 ids): **allowlisted**, each saying whether 2026.8.5 fixes
  it (30) or not (11). The upgrade (#2315) must delete the 30 it retires, which this check will
  insist on.

**2026-10-24, the first day it went red on its own:**

- The 30 authentik entries 2026.8.5 fixes were **deleted** (#2362); the retirement check had named them.
- `frontend-ssr` was back on `node:25-alpine` (Dependabot's #2338 undid #2308): Node 25 left support on
  2026-06-01 and its image has not been rebuilt since, so its OpenSSL (`CVE-2026-45447`) and bundled npm
  (`tar`, `brace-expansion`, ...) were reported. **Back to `node:24-alpine`**, and `dependabot.yml` now
  ignores node MAJORS for that directory (a `versions` range is refused for a docker ignore): an odd
  major never becomes LTS, so a node major moves by hand, onto the next LTS line.
- `CVE-2026-111497` (`brotli-libs` 1.2.0, fixed in Alpine's 1.2.1-r0 of 2026-10-22) is in `adminer`,
  `nginx:1.31.8-alpine`, `nginx:stable-alpine` and `postgres:18-alpine`, and **every one of those pins
  was already the newest upstream build**: no digest carrying the fix existed that day, so there was
  nothing to move to. **Allowlisted** (decided the same day), scoped by purl to
  `brotli-libs@1.2.0-r1` so a later build is not covered: the inventory shows only libcurl (all four)
  and freetype (nginx) depend on it, which decode brotli in fetched HTTP responses and WOFF2 fonts, not
  in request bodies - runtime use was not verified. The rescan retires the entry when the pins move
  ([backlog](backlog.md#p3---bump-the-four-alpine-pins-when-upstream-rebuilds-with-brotli-121-2026-10-24)).
- Later the same day, two more on every pull request. **`CVE-2026-109869`**, `undici` 6.28.0 in
  `node:24-alpine`, is npm's own copy (`usr/local/lib/node_modules/npm/node_modules/undici`) and the
  tag was already the newest Node 24 (24.22.1, npm 11.19.1): **allowlisted** by path with the other
  npm entries - `frontend-ssr` never runs npm, and Node's built-in `fetch` is compiled into the binary,
  not that file. **`CVE-2026-111497` again**, as Debian's `libbrotli1` 1.1.0-2+b7 in
  `goauthentik/server:2026.8.5` (fixed in 1.1.0-2+deb13u1): 2026.8.5 is the newest authentik release,
  so **allowlisted** by purl
  ([backlog](backlog.md#p3---bump-authentik-when-a-release-ships-debians-libbrotli1-110-2deb13u1-2026-10-24)).
  One id on two packages exposed a hole in the retirement: the id check stays satisfied while EITHER
  half is reported, so the half that moved would never retire. **The retirement now also reads each
  purl-scoped entry as `id package version`** (`image-scan.sh --allowlist-purls`, compared with a YAML
  parse by `image-scan-allowlist.test.mjs`) and fails on a triple the raw scan no longer reports.

**2026-10-26, the nightly `Scheduled` run red again: `CVE-2026-92392`**, curl 8.22.0-r0 (fixed in Alpine's 8.23.0-r0), in `adminer`, both nginx pins and `postgres:18-alpine`. The four floating heads were rescanned that day: `postgres:18-alpine` had a newer digest than the pin and `nginx:stable-alpine` had moved, but both still carried 8.22.0-r0, so there was no patched digest. **Allowlisted by purl** (`curl` and `libcurl`, 8.22.0-r0); it retires with the pins, and the backlog item for the brotli pins now owes both fixes ([backlog](backlog.md#p3---bump-the-four-alpine-pins-when-upstream-rebuilds-with-brotli-121-2026-10-24)).

**Not gated: Trivy's Dockerfile misconfiguration scan.** Measured the same day, it finds `DS-0002`
(no non-root `USER`) in all eight Dockerfiles and `DS-0029` (`--no-install-recommends`) in the two
Rust ones. A `USER` change on production images needs its volumes' ownership verified on a running
estate, so it is a backlog item ([backlog](backlog.md#p3---the-eight-service-images-run-as-root-trivy-ds-0002-measured-2026-10-23)), not a gate that would be red from day one.

### A `code_scanning` rule on the ruleset: analysed 2026-10-23, NOT applied

**The question.** Ruleset `22152902` requires one check, `CI passed`. The `CodeQL` check-run (the
code scanning results of the `Security / CodeQL Security Analysis` upload) is advisory: it fails on a
NEW high alert and nothing enforces it. A `code_scanning` rule (tool `CodeQL`, `alerts_threshold:
errors`, `security_alerts_threshold: high_or_higher`) would make it binding. GitHub documents three
conditions under which that rule blocks a merge: a required tool found an alert at the threshold,
its analysis is **still in progress**, or the tool is **not configured** for the repository. The risk
to measure is the second: a pull request on which CodeQL never runs waits for ever.

**What decides it here, read rather than assumed:**

| Case | Does CodeQL upload an analysis for the pull request? |
| --- | --- |
| a documentation-only pull request | **yes** - `security` in `ci.yml` is NOT behind `changes` (deliberately: a secret can be committed in a doc), and the `CI` workflow has no `paths` filter |
| a paths-filtered job skipped by `Detect changes` | irrelevant - no CodeQL step is paths-filtered |
| a Dependabot pull request | **yes** - #2152, #2154, #2156 each carry an analysis on `refs/pull/N/merge` |
| a pull request from a fork | none in the last 300; a fork run gets a read-only token, so this is the case to watch if one arrives |
| a pull request with NO `CI` run at all (a conflicting merge ref, or a run that never started) | no - but `CI passed` is then missing too, so it is already blocked; the rule adds nothing |
| `push` to `main` (the release bump) | not a pull request, and made by `canari-auto-merge`, a bypass actor |

Measured over the 40 most recent pull requests: **every one that had a `CI` run carried a CodeQL
analysis**, the 16 with no JavaScript or TypeScript file among them; the three without one were
drafts carrying no `CI passed` check at all (one of them conflicting). The upload's category is fixed (`/language:javascript-typescript`,
`codeql-category.test.mjs`), so no "configuration not found" can appear. On `main` today: one open
alert (`warning`, security `high`, a test file) - a STANDING alert, which the rule like the check
judges only when a pull request introduces it.

**Two facts that shape what the rule would actually do.** `canari-auto-merge` (`4791068`) is a
bypass actor with `bypass_mode: always`, and auto-merge merges as whoever armed it - so the new rule
binds exactly as far as `CI passed` already does for those merges, no further. And the analysis
takes 2-4 minutes, well inside the CI run, so "in progress" costs no extra wall-clock time.

**Recommendation: apply it.** No pull request this repository produces today would be blocked for a
missing analysis, and it turns the one security verdict still advisory into a binding one. **Its
precondition must stay true**: CodeQL must never move behind `changes` or a `paths` filter - that
would make every documentation pull request wait on an analysis that never starts. Apply it while
watching the first fork pull request, if one ever comes. The decision is the user's
([owed](backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).

`PUT` replaces the whole ruleset, so the body carries every current rule plus the new one (read back
2026-10-23 with `gh api repos/emse-students/canari/rulesets/22152902`; read it again before applying):

```sh
gh api -X PUT repos/emse-students/canari/rulesets/22152902 --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" },
    { "actor_id": 4791068, "actor_type": "Integration", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "allowed_merge_methods": ["squash", "merge", "rebase"],
        "dismiss_stale_reviews_on_push": false,
        "dismissal_restriction": { "allowed_actors": [], "enabled": false },
        "require_code_owner_review": false,
        "require_extra_approval_for_unattributed_changes": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": false,
        "required_reviewers": [] } },
    { "type": "required_status_checks", "parameters": {
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "CI passed" }],
        "strict_required_status_checks_policy": false } },
    { "type": "code_scanning", "parameters": {
        "code_scanning_tools": [
          { "tool": "CodeQL", "alerts_threshold": "errors", "security_alerts_threshold": "high_or_higher" } ] } }
  ]
}
JSON
```

Undoing it is the same `PUT` without the last rule.

### A Tauri plugin bump is two halves, and the crate half can be a runtime bump (2026-10-08)

`Security / Guard the committed lockfiles` runs `frontend/scripts/check-tauri-plugin-versions.mjs`:
the JS package (`package.json`) and the crate (`src-tauri/Cargo.lock`) must agree on major.minor.
Dependabot's `bun` block moves the JS half and cannot move the crate (its `cargo` entry for
`frontend/src-tauri` is unreachable, see the block in `.github/dependabot.yml`), so every plugin
minor arrives red by construction: #1491 (`plugin-store` 2.5.0), #1596 (`plugin-opener` 2.7.0),
#1597 (`plugin-http` 2.8.0). **Grouping the pair is not possible** - a group only spans what the
ecosystem can open a PR for, and the cargo side opens none here; `dependabot.yml` is unchanged.

Measured 2026-10-08, one at a time from a clean `origin/main` with `cargo update -p <crate>
--precise <version>`: each of the three crates (`tauri-plugin-store` 2.5.0, `-opener` 2.7.0, `-http`
2.7.0+/2.8.1) requires `tauri ^2.12`, so the lock moves `tauri 2.11.1 -> 2.12.1`, `wry 0.55.1 ->
0.57.0`, `tao 0.35 -> 0.37`, and cargo reports the vendored `patches/tao` as `patch.unused`. That
is the rebase in [backlog](backlog.md) ("the wry bump that removes the abort"), a native work
package owed an A1 deep-link run, so **all three stay held and their PRs open**. The JS and the
crate move together, in the PR that rebases `tao`. The latest versions the CURRENT tauri accepts
are `tauri-plugin-store` 2.4.5, `-opener` 2.5.5, `-http` 2.7.0 (JS 2.4.x/2.5.x/2.7.x to match).

**Closed the same day, by hand, and the recipe is the mechanism.** The rebase #1609 landed (tauri 2.12.1), so
store/opener/http moved with it. The next three arrivals - `plugin-biometric` 2.4.1 (#1622),
`plugin-websocket` 2.5.0 (#1623), `plugin-log` 2.10.0 (#1624) - stayed red for the reason above while
being fully movable: measured 2026-10-09, `cargo update -p <crate> --precise <version>` moves ONLY the
crate (websocket also moves `tokio-tungstenite`/`tungstenite` 0.28 -> 0.29, which only that plugin uses),
and `cargo check --lib` in `frontend/src-tauri` compiles. **The recipe for a plugin PR that is red on
`Guard the committed lockfiles` with `tauri-plugin-X (vA) : @tauri-apps/plugin-X (vB)`:** in ONE
commit, `bun add @tauri-apps/plugin-X@B` in `frontend/`, `cargo update -p tauri-plugin-X --precise B` in
`frontend/src-tauri`, `node frontend/scripts/check-tauri-plugin-versions.mjs`. First ask the dry run
(`cargo update --dry-run -p ... --precise ...`) whether `tauri` itself would move: if it does, that is a
runtime bump and stops being this recipe.

### Four audit advisories are suppressed on one edge of media-service, and why each is unreachable

The open line is in [backlog](backlog.md#p3---audit-advisories-are-suppressed-because-they-cannot-be-reached-and-retire-themselves); the reasoning is here. The reachability argument for the `decode-uri-component` ignore and the assertion that keeps it honest are in `.github/workflows/code-analysis.yml`, the only copy of that half.

- `GHSA-vcc3-ghjq-m6fr` (moderate, denial of service) covers every `decode-uri-component` at or below 0.4.2 and reaches media-service as `minio > query-string > decode-uri-component`. It is ignored for that one service only: nothing in the chain can move (minio 8.0.7 is the latest release and pins `query-string: ^7.1.3`, which pins `decode-uri-component: ^0.2.2`), and the fixed 0.5.0 is ESM-only where `query-string@7` is CommonJS, so an override would fail at boot instead of at audit.
- `GHSA-528h-pc64-c93x` (moderate, denial of service; added 2026-09-03 when it turned every pull request red) covers every `stream-json` at or below 3.4.0, whose `pick`/`ignore`/`filter`/`replace` filters are O(depth^2) on nested input, and arrives as `minio > stream-json`. minio requires `stream-json: ^1.8.0` and the fix is 3.5.0, two majors outside it. It is unreachable twice over: minio imports exactly one thing from the package (`stream-json/jsonl/Parser.js`, in its bucket-notification module) and none of the four filters, and media-service never calls that API (its whole use of the client is `bucketExists`, `fPutObject`, `getObject`, `makeBucket`, `putObject`, `removeObject`).
- Third and fourth, 2026-10-06: `GHSA-hqr4-qq8f-hg3x` (JSONC parser/verifier re-scan, <= 3.5.0) and `GHSA-mjw6-4jj6-33hc` (Assembler prototype pollution, < 3.6.0) on the same `minio > stream-json` edge. The override to 3.x was refused: the fixed stream-json is `type: module` with `src/` entry points where minio's CJS build `require`s it, and nothing proves that boot. Both ride leg one, now an ALLOWLIST (minio may import only `stream-json/jsonl/Parser.js`) in `.github/scripts/stream-json-premise.sh`, self-tested by `tests/stream-json-premise.test.sh`.

**What retires them:** minio publishing a release that moves either pin (dropping `query-string@7`, or requiring a `stream-json` at or above 3.5.0, 3.6.0 being the floor for the fourth). The ignore and the premise assertion beside it are then deleted the same day. Until then the assertions are what stop the suppressions outliving their reason: CI fails if minio ever parses a query string, if the `stringify` call site the measurement was taken on disappears, if minio starts importing a stream-json FILTER, or if the service starts calling the notification API.

**The third retirement condition originally listed is dead, not pending**: `query-string` DOES now depend on a fixed `decode-uri-component` (latest 9.5.1, on `^0.5.0`), but minio's pin is `^7.1.3` and cannot reach a 9.x, so only minio moving retires either suppression.

**Retirement is ASSERTED, not polled (2026-10-10).** The premises step audits media-service without its ignores and fails when any ignored id is no longer reported (`ignored-advisories-still-reported.sh`, `tests/ignored-advisories-still-reported.test.sh`; a registry that did not answer concludes nothing). The five hand re-checks logged here until 2026-10-09 each found `minio` still 8.0.7, `query-string: ^7.1.3`, `stream-json: ^1.8.0`.

### Two frontend advisories wait on the kit 3 chantier (2026-10-24)

`GHSA-pfhg-q3qv-9q6r` and `GHSA-27mw-82g8-phjj` are LOW SvelteKit advisories (an open redirect through enhanced form submission, an XSS through an untrusted `cache-control` header on a prerendered page), fixed only in `@sveltejs/kit` 3.x. The user put the majors (kit 3, adapter-node 6, webrtc 0.21) after the stable as their own chantiers, so the frontend tree ignores both until Dependabot's #2154 lands, and that pull request deletes them. Unlike media-service's, these rest on a decision, not on reachability. **The retirement check is now its own step, `Every ignored advisory is still reported`, run for every tree whose `matrix.audit` carries an `--ignore`**: it re-audits the tree at its own level without them and fails on an id nothing reports any more, so the day kit 3 merges the two ignores go red rather than stay.

A third frontend ignore, `GHSA-gcqx-w48m-w2h4` (2026-10-28), is the other kind: LOW, `deepmerge` <= 4.3.1, no fixed version, reachable only through build tooling (`@sveltejs/vite-plugin-svelte`, `@rollup/plugin-node-resolve`), merging the project's own configuration. That no copy reaches the shipped bundle was not verified; the same retirement step removes it when the audit stops naming it.

### The Rust ignores live in `.cargo/audit.toml` and retire themselves too (2026-10-24)

Each of the four Rust trees carries its ignores in its own `.cargo/audit.toml`, and **each entry's
reachability statement is written there, the only copy**. Until 2026-10-24 nothing retired them:
`RUSTSEC-2026-0381` (webpki-roots) kept its entry in `frontend/src-tauri` after the advisory was
amended to call 0.26.11 unaffected, and nothing said so. The `cargo-audit` job now has the step the
bun trees have, `Every ignored Rust advisory is still reported`: every lockfile is re-audited from a
directory holding no `audit.toml`, against the database the audit step just fetched, and
`ignored-advisories-still-reported.sh` fails on an id nothing reports any more.

`RUSTSEC-2026-0387` (crypto-bigint 0.5.5, constant-time operations that may branch on secrets; fix
only in 0.7.6) turned `main` red on 2026-10-24 in all four trees. It cannot be taken by a lockfile
change: crypto-bigint 0.7 means elliptic-curve 0.14, and every p256/p384 0.13 user here is at its
newest release (jsonwebtoken 11.1.0, openmls_rust_crypto 0.6.0, webrtc 0.17.2's dtls). It is
unreachable in chat-gateway (HS256 only), mls-wasm and src-tauri (one X25519/Ed25519 suite), and
**reachable in code in call-service**, whose DTLS runs P-256/P-384 ECDHE on a per-handshake
ephemeral secret - bounded by that secret living for one operation and by the SFU never having
placed a production call. The webrtc 0.21 port ([calls](frontend/modules/calls.md#the-webrtc-020-port-measured-2026-09-15)) removes that edge.

### A merged branch that is still there was pushed back, not left behind (measured 2026-09-22)

Two specimens of a squash-merged branch still on the remote: #341 (2026-09-03, present twelve minutes after an auto-merge while #339 and #340 were already 404; a `DELETE /git/refs/heads/...` removed it with no error) and #825. Of 596 merges since 2026-09-17, exactly one branch was still there on 2026-09-22: `perf/le-blob-ne-traverse-plus-le-pont`, whose merge consumed head `9ff6d0755` (2026-09-17 19:09:28 Z) while the branch carried `4b4b5862b`, committed 22:08 Z, three hours AFTER the merge.

**GitHub re-creates a branch when something pushes to it**, so nothing failed to delete anything: the branch was deleted on merge and a workstation pushed it back (which also explains #341). The cost is not untidiness: the commit pushed there was a CHANGELOG shortening the user had asked for that evening, and it never travelled to `main` (a merged pull request does not carry another commit). **Work pushed to a merged branch is committed, pushed and unshipped, and nothing says so** - `git status` is clean and the push succeeds. The prevention is the `git branch -D` at the end of THE DEVELOPMENT CYCLE in `CLAUDE.md`: a local branch kept past its merge is the only thing that can be pushed back.

### A pre-release tag can still race a merge, between the head read and the tag

Gate 2 of `.github/scripts/release-preflight.sh` refuses an alpha whose sha `main` has moved past, and a rerun re-reads the SAME tag, so it cannot rescue one. The stable half closed with #1367 (a stable ships the latest pre-release of its version on `release/vX.Y.Z` and the tag moves, see above). **Measured 2026-10-09 over every alpha `release.yml` ever ran (108, since 2026-09-03): ONE was refused for it** (`v0.18.22-alpha.3`, 2026-09-24, `main has moved past 774e1455`, which the refusal reported before anything moved, so the cost was one more alpha), and none in the fifteen days since - the other two failed alphas died of a docker build and of the iOS WASM check. The window is only preflight to the bump push (about a minute), and the refusal is clean and names its remedy, so nothing here is broken enough to re-architect: moving an alpha off `main` would change what `main` carries (the manifests' version) for a 1 in 100 refusal. **Reopen if it recurs, with `gh run list --workflow release.yml` showing a second one**, and then: let the gesture name "the release" and the machine take `main` HEAD, never a sha a human read seconds earlier - and never a rebase or a lenient gate 4, which are fallbacks.

### The last node runtime: four jest suites that will not run under bun (decided 2026-08-27, after the campaign)

npm is gone (`node --run test` replaced the one `npm test` in `ci.yml` and the one `bun run test` in the Makefile's `test-history`). What survives is the node RUNTIME: `actions/setup-node` twice in `ci.yml` (backend suites, harness self-tests) and once in `code-analysis.yml`.

**The measured blocker is one file**: `apps/chat-delivery-service/src/controllers/admin-storage.controller.mls.spec.ts` passes 8/8 under node and fails under the bun runtime, which is why CI installs, lints and builds with bun but TESTS with node. Do not collapse the two runtimes without re-running that spec.

**The work**: port four NestJS services from jest to `bun test` - `jest.fn()`/`jest.spyOn` to bun's `mock`/`spyOn`, `ts-jest` (which TypeScript 7 already could not load, see [ecosystem-convergence](ecosystem-convergence.md) section 9), the `moduleNameMapper`, the `@nestjs/testing` fixtures. Days, not hours, and it touches suites guarding MLS storage - the wrong place to discover a mock that silently stopped asserting. It waits for the campaign ladder to reach the bottom, because a test-framework migration changes what "green" means for every rung still to be taken. Until then: bun is the package manager and runtime everywhere except one test invocation, which runs on node on purpose.

## Notable CI gotchas

- **A CONFLICTING PR PRODUCES NO `pull_request` RUN, AND THE CHECKS LIST STILL LOOKS BUSY.** The `pull_request` event is computed against the MERGE ref; with a conflict GitHub cannot build one, so `CI` is never queued - not red, not skipped, simply never created. `arm-auto-merge` is `pull_request_target`, evaluates against the base, and runs anyway, so one green row sits there while nothing tests the code. PR #525 waited twice and survived a close/reopen before the state was actually asked for. `gh run list` returning nothing is an ANSWER: read `gh pr view <n> --json mergeable,mergeStateStatus` (`CONFLICTING` / `DIRTY`), then rebase on a freshly fetched `main` and `git push --force-with-lease`.
- **`CHANGELOG.md`'s `## [Unreleased]` heading WAS an anchor every fix wrote to, so two PRs opened the same day conflicted by construction** - #837 and #838 did exactly that (2026-09-18). The first answer, `CHANGELOG.md merge=union` in `.gitattributes`, was verified with `git merge-file --union` and **never worked where it mattered: GitHub ignores `.gitattributes` merge drivers when it computes mergeability and squash-merges a PR.** Measured 2026-09-24 on #1067: `git merge-tree origin/main HEAD` merged clean locally while GitHub reported `CONFLICTING`. The anchor is gone instead: each PR adds its entry as a file in `changelog.d/`, the stable bump folds them under `## [X.Y.Z]` and deletes them ([changelog.d/README.md](../../changelog.d/README.md)), and `.github/scripts/tests/docs-merge-artefacts.test.mjs` fails a PR that writes under `[Unreleased]`. **A merge behaviour verified with local git is verified for local git** - the platform that performs the merge is the one to measure.
- **A Tauri plugin's JS package and its Rust crate must agree on major.minor, and only a RELEASE used to discover when they did not.** The CLI refuses to build (`tauri-plugin-log (v2.8.0) : @tauri-apps/plugin-log (v2.9.0)`), but nothing else in this pipeline compiles the Tauri app, so an ordinary `bun install` that re-resolves the JS half lands green and kills the next tag - it took out Android Release and AppImage Release on v0.14.6, while iOS Release passed because its path never runs the check. `frontend/scripts/check-tauri-plugin-versions.mjs` (step `Guard the Tauri JS/Rust version parity` in `code-analysis.yml`) now compares the two committed files on every run. Fix the Rust side with `cd frontend/src-tauri && cargo update -p <crate>`.
- **Recorded flake, not reproduced:** `chat-delivery-service` failed one test in one of five local runs on 2026-08-31; if it recurs, capture the suite name first and do not widen the dependency ceiling to feel safe.
- iOS `altool` can exit 0 while output says `UPLOAD FAILED` — the workflow greps for failure markers in the transcript.
- Android Play API rejects `changesNotSentForReview` post-launch — never include this flag.
- `workflow_run` triggered off a release-triggered workflow must NOT have a `branches` filter (GitHub silently drops them).
- Pre-commit hooks sweep the whole frontend and re-stage — isolate unrelated dirty files before committing (`git stash` them).
- Never assert a wall clock in a test. An unseeded generator with rejection sampling once drew 31s against a 15s budget on a runner and took CD down: seed the input, and let the `it` timeout guard non-termination.
- **`gh run rerun` replays the workflow FILE as it existed at that run's ORIGINAL trigger, never the current one on `main`.** Fixing a workflow bug and re-running the failed run will silently re-run the old, broken definition - confirmed on the v0.14.5 iOS recovery, where the rerun's step list was missing a step added by the fix. Only a fresh trigger (`workflow_dispatch`, or a new event) resolves the current file.
- **`softprops/action-gh-release` is no longer used in this repository, and this is why.** It can 403 with `Resource not accessible by integration` pointing at `update-a-release`, on its OWN second, `github.ref`-shaped lookup - after it has already found the release by `tag_name`. First seen for `refs/heads/main` under `workflow_dispatch` (where `github.ref` is the branch, not the tag). **The tag variant then cost Apple a whole release**: on the stable `v0.16.0` the iOS arm was refused with `Contents: write` granted and printed by the runner, on `refs/tags/v0.16.0` under a `release` event, and the re-run reproduced it - while the Android arm's identical step succeeded on the same release 24 minutes earlier, and on every stable since. The cause of that refusal is unexplained and now unanswerable, which does not matter: **attaching a file to a release needs no release UPDATE**, so both arms use `gh release upload "$TAG" ... --clobber`, one call, creating nothing when the release is absent. `release-chain.test.sh` refuses an `uses:` in either step.
- **`github.event.pull_request.author_association` skips a real collaborator whose ORGANISATION MEMBERSHIP IS PRIVATE, silently and every time.** `arm-auto-merge.yml` used to gate on `contains(["OWNER","MEMBER","COLLABORATOR"], author_association)`. Measured on #709: `gh api repos/.../pulls/709` answered `author_association: "MEMBER"` and `gh api repos/.../collaborators/<login>/permission` answered `admin`, queried seconds apart with a token that can see private membership - while the WEBHOOK payload the `if:` reads is computed without that visibility, so it fell back to a value outside the three names and the job's `if:` was false. A private membership setting is a choice about the author's own profile, unrelated to their access to the repository, so it cannot be what decides arming. The fix asks the real question directly, in a step (not the job-level `if:`, since that cannot make an API call): `gh api repos/$REPO/collaborators/$AUTHOR/permission`, gating the merge step on `admin`/`maintain`/`write` (Dependabot still by name). `release-chain.test.sh` now refuses `author_association` to come back.
- **A DRAFT RUN COULD CANCEL THE ARMING, BECAUSE BOTH SHARED ONE CONCURRENCY GROUP.** Measured on #1259 (2026-09-30): a push and `gh pr ready` in the same second queued a `synchronize` whose payload still read `draft: true` and a `ready_for_review`; `cancel-in-progress: true` kept one of them, and the one it kept skipped on the draft guard. The pull request sat with `CI passed` green and nothing armed, and `gh run rerun` of the cancelled run armed it. The group now ends in `-${{ github.event.pull_request.draft }}`, in all four repositories, so a draft run can only cancel another draft run; `release-chain.test.sh` asserts it.

## See also

- [`development.md`](development.md) — Local dev workflow, Makefile targets
- [`infrastructure/docker.md`](infrastructure/docker.md) — Docker Compose setup
- [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) — Server bootstrap and migration guide
