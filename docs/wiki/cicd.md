# CI/CD pipeline

Canari uses GitHub Actions for continuous integration and deployment. The pipeline lives in `.github/workflows/`.

## Workflows

### CI (`ci.yml`)

Runs on every push and pull request to `main`:

| Job | What it checks |
|---|---|
| **Rust tests** | `cargo test` across all crates (`chat-gateway`, `call-service`, `mls-core`) |
| **TypeScript tests** | NestJS tests in `chat-delivery-service` |
| **Frontend tests** | `vitest` in `frontend/` |
| **Frontend lint** | `oxlint` + `oxvelte` + `oxfmt --check` + `svelte-check` (0 errors required) |
| **Build** | the generated sources first - [`.github/actions/build-mls-wasm`](../../.github/actions/build-mls-wasm/action.yml) then `bun run proto:gen` - then `bun run build` |

**The generated sources are not in git** (`frontend/src/lib/wasm/`, `src/lib/proto/canari.{js,d.ts}`),
so EVERY pipeline that ships a client builds them: `cd.yml`, the three release workflows, and
`ci.yml` because the gates import them. One composite action, one pinned
`wasm-pack`, one cache key over `mls-wasm/**` + `mls-core/**` + `rust-toolchain.toml` - the
committed binary went a crypto fix stale precisely because only some pipelines rebuilt it
([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)).

### CD (`cd.yml`)

Deploys to the production server on push to `main`, manual trigger, or after a release version bump:

1. Runs CI + CodeQL (skipped on post-release version-bump deploys)
2. Detects changed services and builds only those Docker images → GHCR
3. Self-hosted runner on production: sync `.env`, `docker compose pull` + `up -d`
4. Runs database migrations
5. Health check verification

`GITHUB_TOKEN` pushes from the version-bump workflow do **not** trigger `on: push`. CD is chained via `workflow_run` instead (no `branches:` filter — GitHub would silently drop release-triggered parents).

### Mobile CD (`ios-release.yml`, `android-release.yml`, `appimage-release.yml`)

Triggered on release (`vX.Y.Z` tag). Each builds the Tauri app for its platform:

| Workflow | Output |
|---|---|
| `ios-release.yml` | `.ipa` for TestFlight upload (uses `altool`) |
| `android-release.yml` | `.aab` for Google Play upload |
| `appimage-release.yml` | `.AppImage` for Linux desktop |

### Version bump (`bump-version.yml`)

Triggered on `release: published` (or manually). Bumps versions across `package.json` / `Cargo.toml` / Tauri / iOS pbxproj (app + NSE). Must stage the explicit file list — any new file the bump script patches must be added to the workflow.

After a successful bump push, CD runs in **rebuild-only** mode: skips CI and CodeQL, rebuilds `core-service` + `frontend` (so `/api/version` and the SPA match the release tag), then deploys.

## GitHub Secrets

See [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) (section 3) for the full secrets inventory.


**A credential is real in THREE places, not two.** The CD regenerates `infrastructure/.env` from the
repo secrets, so a value set over SSH lasts until the next deploy. It must therefore be a GitHub
secret AND named in `cd.yml` - and the third, just as mandatory and the easiest to forget, is the
service's own `environment:` block in `infrastructure/docker-compose.prod.yml` (and `.dev.yml` for
parity), spelt explicitly as `FOO: ${FOO:-}`. `.env` holding the value proves nothing about whether
Compose passes it INTO the container: `GOOGLE_SAFE_BROWSING_API_KEY` shipped correctly in `cd.yml`
and `.env.example` and was still absent from the running container (WP-SAFELINK-1), where the
endpoint answered 200 with a silently fail-open verdict rather than an error.
`docker exec <container> env | grep FOO` is the only way to catch it.

## Rotating `JWT_SECRET`

One HS256 secret signs every token of all six services, so a leak in the smallest of them mints
admin tokens for all. Rotating it is already a supported operation — nothing in the workflows needs
changing — but nothing schedules it either, which is why it is written down here.

**The procedure is two steps**, and the second is not optional:

1. Change the `JWT_SECRET` repository secret (`openssl rand -hex 32`).
2. Re-run the CD workflow.

`cd.yml` makes this safe by refusing every failure mode it can see:

| Step | What it does |
|---|---|
| l.498 | Fails the deploy outright when `JWT_SECRET` is absent — no accidental default |
| l.538 | Upserts it into `infrastructure/.env` on the server |
| l.863-869 | Re-reads the value **from inside the running core-service container** and compares its sha256 against the GitHub secret |

That last check is what makes a rotation believable: a deploy where the new secret did not actually
reach the running process **fails**, instead of reporting success over a service still signing with
the old key.

**Rotation is a hard cut, on purpose.** There is no `JWT_OLD_SECRET` grace window in Canari and
none should be added: the grace period is paid for with a second step that is invisible and
therefore never taken (Le Cercle's production is the standing proof — its old secret still signed
sessions months after the rotation "happened"), and it is exactly backwards for the case you
actually rotate in, a leak, where the old key must die *now*. Canari signs in through Authentik, so
the cost of the hard cut is one mostly transparent SSO redirect.

**A rotation is not the everyday revocation lever.** Signing one device out, or ending one stolen
session, is a row in `auth_sessions` — see [`services/core-service.md`](services/core-service.md).
Reach for the secret only when the secret itself is suspect.

## Container registry

All service images are published to GitHub Container Registry:

```
ghcr.io/emse-students/canari/<service>:<tag>
```

| Tag | Meaning |
|---|---|
| `latest` | Latest production build (push to `main`) |
| `dev` | Latest development build |

## Self-hosted runner

The `deploy-to-server` job runs on a self-hosted GitHub Actions runner (label `self-hosted`) on the production server (`canari`). This runner:

- Has direct access to the Docker socket (no SSH needed for container management)
- Has SSH access to `mitv` (offsite backup server)
- Runs as the `canari` system user

## Release workflow

```
1. Developer: gh release create vX.Y.Z --target $(git rev-parse HEAD)
2. Mobile workflows build iOS/Android/AppImage artifacts
3. bump-version.yml commits "chore: bump version to X.Y.Z" on main
4. CD (workflow_run) rebuilds core-service + frontend (no CI) and deploys
5. iOS: altool upload to App Store Connect (manual TestFlight submission after)
6. Android: upload to Google Play (automatic or manual depending on track)
```

## A manual workflow run is the only native compiler available off macOS

`android-release.yml` and `ios-release.yml` both accept `workflow_dispatch`, and **every** publish
step (GitHub Release, Google Play, TestFlight) is gated on `workflow_run`. A manual run is
therefore a pure compile check that ships nothing — and it is the only way to compile Swift, ObjC
or Kotlin from a Windows machine. Dispatch both before believing any native change.

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

`ios-release.yml`'s "Prebuild Rust static lib (libapp.a)" step calls `cargo build --lib --release
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
Android does not carry this risk: `android-release.yml` builds through `bun tauri android build`,
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

`ios-release.yml` also patches `ITSEncryptionExportComplianceCode` into `Info.plist` at build time
from the `APP_STORE_CONNECT_EXPORT_COMPLIANCE_CODE` secret (App Store Connect's own compliance
documentation code for this app - distinct from `ITSAppUsesNonExemptEncryption`, which is committed
since it's not account-specific). Kept as a secret rather than committed: this is a public repo, and
every other Apple-account value here is already handled that way. The step skips, not fails, when
the secret is unset - `Info.plist` stays as committed, and the TestFlight upload step fails with a
409 explaining exactly why.

## Version bump

`scripts/bump-app-version.sh` must patch the NSE's `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION` alongside the app's — an NSE left behind on an older version is rejected
at upload. `bump-version.yml` stages an **explicit `git add` list**, so any new file the script
learns to patch has to be added there too, or the bump silently leaves it uncommitted.

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
`frontend/src/lib/wasm/` was committed and rebuilt by `cd.yml` alone, so the web ran the current
`mls-core` while the Android, iOS and AppImage releases shipped the binary from the last commit that
thought to regenerate it - **two different cryptos in one fleet, with nothing comparing them**.
Rebuilding the untouched sources produced a different binary, which is how it was proven rather than
argued. The fix is not a habit: **every pipeline shipping a client builds the artefact itself**, from
one composite action with one pinned toolchain
([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)). A build step duplicated per pipeline is
the same defect wearing a different hat - two toolchains put two cryptos back in the fleet.

## Dependency updates, and the auto-merge that ships them

Dependabot opens the pull requests (`.github/dependabot.yml`); `dependabot-auto-merge.yml` decides
which of them merge, and `.github/scripts/dependabot-auto-merge.sh` is the decision itself. The
script is the ONE implementation - the workflow calls it from two triggers and adds nothing.

### What it refuses, and why it is not a semver rule

**A ceiling on an automatic merge is a statement about your tests, never about the version number.**
The first ceiling written here refused every major and every `0.x` minor, and the measurement that
condemned it is that 33 pull requests were open and it refused 28 - a queue nobody drains is worse
than the merge it prevented (user, 2026-08-31: *"Je prefere blinder de test et faire les choses
automatiquement qu'avoir une review humaine qui n'arrive jamais"*).

`base64` 0.22 -> 0.23 and `axum` 0.7 -> 0.8 break by **not compiling**, which is exactly what the
suite sees. What a suite cannot see has no relation to semver: a dependency that **writes a format
something else must still read** changes behaviour while compiling perfectly. So the ceiling is a
list of dependencies whose failure mode is unobservable here, and **every entry names the test that
retires it**:

| Family | Why the suite is blind to it | The test that retires it |
|---|---|---|
| `openmls*`, `tls_codec*`, `hpke-rs*`, `libcrux*` | a WIRE format is read by other devices on other VERSIONS; `cross_version_state.rs` covers only today opening what v0.14.14 wrote | the FORWARD half - an old binary reading a frame minted by the new one |
| `aes-gcm` | it opens a channel push sealed by ANOTHER member's device, so both directions are cross-version, and `src-tauri` freezes neither | a channel-push fixture |
| `webrtc*`, `str0m`, `sdp`, `ice`, `turn`, `stun` | the SFU's ten tests never touch the ICE stack | one relay-path call (campaign rung 15 CALL) |
| `stripe` | the SDK's literal `apiVersion` type stops a silent API crossing at COMPILE time, but nothing here proves the app still reads what a new API SENDS | fixtures per API version, over the webhook events and object fields the service actually reads |
| `postgres`, `redis`, `garage` - **a major crossing only** | a datastore major is refused by the data ALREADY ON DISK, and every gate here creates its cluster from an EMPTY volume - the one case that always works | starting the new major against a data directory written by the old one, and proving the documented upgrade path carries it |

**Four families have already LEFT this table, which is what a refusal is for** - it names a missing
gate, and it goes the day the gate arrives. `@nestjs/*` left because `boot-nest-apps` constructs the
real `AppModule` on all four services, which alone moved the ceiling from 5 merge / 28 refuse to 26
merge / 6 refuse. `chacha20poly1305`, `argon2` and `ciborium` left because `cross_version_state.rs`
opens artefacts they sealed in v0.14.14, and for an AT-REST envelope - read only by the device that
wrote it - that backward direction is the whole question. Bare `typeorm` left because
`app-module.boot-spec.ts` now issues a real query through every entity the app registered. The live
list is in
[backlog](backlog.md#p1---the-three-refusals-the-auto-merge-ceiling-makes-and-the-test-that-retires-each).

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
is stable *within* a major, so `redis 8.8-alpine -> 8.10-alpine` cannot meet the failure mode, and
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
next deploy.** `cd.yml` runs `git reset --hard origin/main`, so pinning the image back over SSH
restores service in seconds and survives exactly until the next dispatch - which is what happened at
13:29, when a deploy from an origin still carrying 18 took production down a second time. The manual
repair buys time to write the real one; it is never the repair.

Postgres is pinned at 15 until the upgrade procedure exists; that is a deliberate deferral, with the
two reasons 18 refuses the directory, in
[backlog](backlog.md#p2---postgresql-is-held-at-15-because-18-needs-a-migration-nobody-has-performed-after-the-outage-of-2026-09-01).

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
gate that reads as proof. `infrastructure/dev/copy-prod-to-dev.sh` is a **logical** copy - `pg_dump`
replayed into a cluster the new major initialised itself, from empty - so it never touches a data
directory written by the old major, and cannot fail the way production failed. It would have gone
green on 18 while saying nothing about `pg_upgrade` or the 18+ move of the mount point from
`/var/lib/postgresql/data` to `/var/lib/postgresql`. The next `postgres` major would then have
auto-merged on that green.

So each row states WHICH question its gap answers, and only one of the four answers lifts anything:

| `evidence` | What it demonstrates | Lifts |
| --- | --- | --- |
| `none` | There is no gap; dev runs production's major. | nothing |
| `fresh_cluster` | The new major serves a cluster it created from empty. This is what every gate here already proves, and it is the one case that always works. | nothing |
| `logical_restore` | The new major serves this application's schema and data after a dump and restore. Worth having - it catches a schema or query the new major rejects - but the cluster is still one the new major built. **This is what the dev environment produces on its own.** | nothing |
| `in_place_upgrade` | The new major serves production's OWN data directory, carried across by the documented upgrade path, with the mount layout the new image expects. | the refusal named in `lifts` |

It fails closed on every other input, proved against fixtures: the wrong evidence value, an
`in_place_upgrade` with an empty `proof`, a missing gap file, a different major, and a sibling image
in the same arm are all still refused.

### Why there are three triggers, and why the clock is the weakest of them

- **`workflow_run` on a Dependabot pull request's own CI** - the fast path, seconds after that one
  pull request goes green. Narrow by construction: it names a branch.
- **`workflow_run` on `CD - Deploy to Production`** - the convergent path. CD is what runs on every
  push to `main`, so its completion is the closest thing this repository has to "somebody did
  something", and it is answered with a FULL SWEEP of every open Dependabot pull request.
- **`schedule` (hourly) and `workflow_dispatch`** - also full sweeps, and the schedule is a bonus
  rather than the mechanism.

The convergent path is the one that matters: an event-only automation cannot touch a pull request
that was already green when it was installed, and on 2026-08-31 seven mergeable ones sat exactly
there.

**THE SCHEDULE WAS THAT PATH FOR ABOUT THREE HOURS, AND A MEASUREMENT TOOK THE JOB AWAY FROM IT -
THEN A SECOND MEASUREMENT CORRECTED THE FIRST.** The cron `17 * * * *` landed on `main` at 14:32 UTC
on 2026-08-31 and had produced **zero** runs by 17:00, and this page said on that basis that the
clock did not fire at all. It does. Counted on 2026-09-01, every one of the four repositories had
delivered a scheduled sweep - Canari twice, at 20:49 and 00:36 UTC, and Sky, MiGallery and
Portail-etu once each around 21:30. **A three-hour window is not enough to call a trigger dead**, and
the correction matters more than the conclusion it barely changes: a mechanism built on the first
quiet interval somebody happened to look at is built on nothing.

What the wider measurement does support is the SHAPE of the delivery, and that was always the real
argument: `code-analysis.yml` asks for `0 2 * * *` and actually ran at 03:01, 03:09, 08:05, 08:24,
08:47, 12:37 and **14:10** UTC on seven consecutive days. Scheduled delivery on a public repository
is best-effort, and **GitHub does not queue the slots an hourly cron misses - it drops them.** Two
deliveries in seven hours is not an hourly clock.

So the clock stays demoted, on the honest ground rather than the dramatic one: it arrives, with
hours of jitter, which makes it a floor under the worst case and never the thing a verdict waits on.
The convergent trigger is the event that happens whenever anybody works - a push to `main` - and the
cron covers the case where nobody does for days.

**AND A THIRD MEASUREMENT FOUND THAT COUNTING DELIVERIES WAS THE WRONG QUESTION ENTIRELY.** Both
counts above are about whether a run was DELIVERED. On 2026-09-01 the logs of those runs were read
rather than counted, and in two of the four repositories the sweep had never executed at all: the
script landed without its executable bit, `Permission denied` on every pull request, `merged 0`, and
the workflow went GREEN - six consecutive passes in Sky, every one reporting success. The step
swallowed the status by design (`if ...; then :; fi`), so one unmergeable branch could not stop the
sweep, and it swallowed "the script could not run" with it. **The script declines by PRINTING, never
by status**, so a non-zero status was never a refusal and never should have been survivable; it is
fatal and annotated now, and the script is invoked through `bash` so a mode bit cannot decide
whether the chain runs at all. A count of deliveries would never have found this. Reading one log
did.

**One measured limit of the push path, recorded because it is invisible otherwise:** the CD run the
sweep DISPATCHES after a merge does not come back. `workflow_dispatch` is the documented exception
that lets `GITHUB_TOKEN` start CD at all, but that run's completion emitted no `workflow_run` event
on 2026-08-31. It matters less than it looks - since the staleness predicate stopped firing on every
movement of `main` (below), one sweep merges everything mergeable rather than one pull request per
re-trigger.

### Why a green pull request is not enough

A check-run's conclusion is evidence about the workflow that PRODUCED it. PR #272 bumps
`@nestjs/platform-express` 11 -> 12 in media-service alone - the split that started all of this -
and was `CLEAN` with every check green: its suite has no `Boot the real AppModule` run at all,
because that job was written after its CI last ran. **An absent check and an inapplicable one look
identical**, so "nothing failed" is not a merge condition.

The script therefore refuses to merge on a suite that describes gates `main` no longer carries, and
marks such a head `STALE`.

**WHAT COUNTS AS "NO LONGER CARRIES" WAS TOO WIDE UNTIL 2026-09-01, AND IT MADE THE QUEUE
UNDRAINABLE.** The predicate asked whether the branch's base was current `main`. Every merge moves
`main`, so every merge invalidated every remaining pull request in the same instant - and the only
way out was a rebuild, which **nothing in CI is permitted to perform**:

- `PUT /pulls/{n}/update-branch` pushes a merge commit authored by `github-actions[bot]`. The
  `pull_request` run it re-triggers is created as `action_required`, parked for a human; Dependabot
  then refuses the branch for good; and the workflow's own entry filter admits only
  `dependabot[bot]`. It made the branch unmergeable by every path at once.
- `@dependabot recreate` is refused when the caller is `github-actions[bot]`. Measured on #303,
  three seconds after the ask: *"Sorry, only users with push access can use that command."*

**A gate whose only remedy is unavailable is not a gate, it is a stop** - and it stopped seven
mergeable pull requests. So the question is now asked the way #272 actually poses it: did the
definitions that BUILD a check suite move between the branch's base and `main`? Those are
`.github/workflows/` and `.github/scripts/`, which decide both which jobs run and what each one
asserts, and nothing else. Two dependency merges landing on `main` change neither, so a suite from
before them still describes today's gates and the pull request merges. A workflow edit changes both,
and then the suite proves nothing.

The predicate lives in `.github/scripts/lib/gate-moves.sh`, apart from its caller so that it can be
exercised on inputs GitHub will not produce on demand: **it fails closed on a compare it cannot
read, and on one whose file list the API truncated at 300** - a 300-entry answer is
indistinguishable from a longer one by inspection, so the count is read before the list. Those are
the branches a live run never reaches, which is exactly why
`.github/scripts/tests/gate-moves.test.sh` produces them instead, and why `make test-ci-scripts`
runs on every change under `.github/scripts/`.

**And the shell itself is linted, not merely parsed.** `.github/scripts/` is the only code here that
MERGES things, so `shellcheck -x` gates it before a merge, in each of the four repositories that
carry these scripts. Two details are the point. The linter is **pinned by version and digest** and
the runner's own copy is ignored: `ubuntu-latest` ships a shellcheck, but which one is the image's
business and it moves without this repository changing. And it was **run, and made to fail, before
it was turned on** - a throwaway copy across all four repositories named exactly one thing, SC1091,
the source it cannot resolve through `$(dirname "$0")`, which the `source-path=SCRIPTDIR` directive
beside each `.` answers; then an unquoted `rm $f` spliced into the library came back as SC2086, so
the gate is known to reject rather than merely to pass.

**One consequence changed with it.** Under the old predicate roughly one pull request merged per
pass, because each merge invalidated the rest. Now a single sweep merges everything that is
mergeable, which is what makes the chain converge without a re-trigger per merge.

**AND ONE THING STILL WANTS A HUMAN.** When the gates really did move, the branch really does need a
rebuild, and the sweep can only say so: it posts one comment per pull request behind
`<!-- canari-auto-merge-gates-moved -->` naming the single command that clears it. Closing the pull
request is not an alternative - Dependabot does not recreate a version whose pull request was closed
unmerged. Closing the gap is a **credential** decision rather than a code one: a fine-grained PAT or
a GitHub App token with push access would make `@dependabot recreate` succeed from the workflow. The
row is in [backlog](backlog.md).

A sweep may merge several pull requests that were only ever tested apart. That is safe here for one
reason and it is worth not breaking: **`deploy-to-server` needs `run-ci`**, so a combination that
breaks fails CI on `main` and the deploy is skipped. `main` can go red; production cannot follow it.
One dispatch is sent for the whole pass, not one per merge.

### Who pushes the refresh decides whether it is a refresh at all

Rebuilding a stale branch is the sweep's one write to somebody else's pull request, and **which
identity performs it is part of the mechanism**. The step was written as
`PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`, the obvious API for the job. It pushes a merge
commit authored by `github-actions[bot]`, and on 2026-08-31 that cost three things at once, across
seven pull requests:

1. **The re-triggered `pull_request` run is created as `action_required`** - parked until a human
   clicks Approve. A push authored by Dependabot is not. Twenty runs were sitting there.
2. **Dependabot then refuses the branch permanently.** Asked to rebase, it answers: *"Looks like this
   PR has been edited by someone other than Dependabot. That means Dependabot can't rebase it -
   sorry!"*
3. **The workflow's own entry condition** admits a `workflow_run` whose actor is `dependabot[bot]`,
   so even a human approval would not have let the branch back into the fast path.

The branch was left unmergeable by every path, and it was no longer *stale* - `update-branch` had
made its base current `main`, so the check above passed it straight through to a merge decision
reading checks that would never complete. Meanwhile every push to `main` made another branch stale
and fed another one in. **The step written to drain the queue was the one filling it.**

The refresh is now a `@dependabot recreate` comment. `recreate` rather than `rebase` because it ends
in the same state whatever was done to the branch before - a freshly generated branch on current
`main`, authored by Dependabot - where `rebase` refuses an edited branch, which is precisely the
state the old step spent a day creating. Dependabot answers asynchronously, so the step reads nothing
back: the next pass measures the outcome on durable state, whether the pull request's base is current
`main`, and a request that was ignored simply leaves the branch stale to be asked again.

Detection is on the STATE and never on how the state arose. The script reads the head commit's author
and marks any pull request whose head is not `dependabot[bot]` for rebuilding - so a branch touched by
a maintainer, by a bad rebase, or by an earlier version of this very workflow converges the same way,
and the six branches the old step had already trapped were healed by the sweep itself rather than by
hand.

### Two traps, both found by testing the gate against real pull requests

- **Dependabot YAML-quotes a dependency name starting with `@`**, so the commit trailer reads
  `"@nestjs/common"` with the quotes. A `case` on `@nestjs/*` matches nothing - which is how a first
  draft merged the exact major it was written to refuse. The script strips the quotes.
- **A "update the requirement to permit the latest version" pull request carries no `update-type`
  trailer at all** (PR #297, openmls 0.9.0), so any logic keyed on the update type reads an empty
  string. Treat unknown as major.

The `updated-dependencies` trailers are parsed **as blocks**, never as three independent `sed`
lists: a grouped pull request carries several, and an update Dependabot could not classify has no
`update-type`, so three lists pasted side by side would pair the wrong name with the wrong version.

### The chain, proven end to end

On 2026-08-31 a dependency update reached production with no human in it, which had never happened
in this repository before. PR #289 merged at 13:48:44; CD run `33399025542` started four seconds
later, event `workflow_dispatch`, on that merge commit; it completed `success` and prod answered
afterwards. **That is the fact worth not re-deriving** - the three pieces (a ceiling that decides, a
sweep that converges, a CD dispatch on the merge commit) compose, and a session finding one of them
apparently idle should look for a refusal it printed rather than assume the chain is broken.

### Verifying a change to it

Run the shipped script, unmodified, against real pull requests, with a `gh` shim on `PATH` that
passes reads through and intercepts `pr merge`, `pr comment` and `workflow run`. Testing a retyped
copy proves nothing about the file that runs.

**And lint it before pushing, because this workstation has no `shellcheck` and CI does.** A change to
these scripts went red on 2026-09-01 for two findings a local run would have named in one second
(`SC1091` - `# shellcheck source-path=SCRIPTDIR` is **per-command, not per-file**, so a second
`source` needs its own copy - and `SC2016` on a `'${'` case pattern that meant the brace literally).
Fetch the pinned version into a scratch directory and use the invocation `ci.yml` uses:

```sh
curl -sSL -o sc.zip https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.zip
# unzip, then, from the repo root:
./shellcheck.exe -x .github/scripts/*.sh .github/scripts/lib/*.sh .github/scripts/tests/*.sh
```

## Notable CI gotchas

- **A Tauri plugin's JS package and its Rust crate must agree on major.minor, and only a RELEASE used to discover when they did not.** The CLI refuses to build (`tauri-plugin-log (v2.8.0) : @tauri-apps/plugin-log (v2.9.0)`), but nothing else in this pipeline compiles the Tauri app, so an ordinary `bun install` that re-resolves the JS half lands green and kills the next tag - it took out Android Release and AppImage Release on v0.14.6, while iOS Release passed because its path never runs the check. `frontend/scripts/check-tauri-plugin-versions.mjs` (step `Guard the Tauri JS/Rust version parity` in `code-analysis.yml`) now compares the two committed files on every run. Fix the Rust side with `cd frontend/src-tauri && cargo update -p <crate>`.
- iOS `altool` can exit 0 while output says `UPLOAD FAILED` — the workflow greps for failure markers in the transcript.
- Android Play API rejects `changesNotSentForReview` post-launch — never include this flag.
- `workflow_run` triggered off a release-triggered workflow must NOT have a `branches` filter (GitHub silently drops them).
- Pre-commit hooks sweep the whole frontend and re-stage — isolate unrelated dirty files before committing (`git stash` them).
- Never assert a wall clock in a test. An unseeded generator with rejection sampling once drew 31s against a 15s budget on a runner and took CD down: seed the input, and let the `it` timeout guard non-termination.
- **`gh run rerun` replays the workflow FILE as it existed at that run's ORIGINAL trigger, never the current one on `main`.** Fixing a workflow bug and re-running the failed run will silently re-run the old, broken definition - confirmed on the v0.14.5 iOS recovery, where the rerun's step list was missing a step added by the fix. Only a fresh trigger (`workflow_dispatch`, or a new event) resolves the current file.
- `softprops/action-gh-release` can 403 with `Resource not accessible by integration` on a lookup for `refs/heads/main` specifically under `workflow_dispatch` (where `github.ref` is the branch, not the release tag) — even after it already found the release by `tag_name`, and even though the same step succeeds normally under `workflow_run`/`release` events (where `github.ref` is the tag).

## See also

- [`development.md`](development.md) — Local dev workflow, Makefile targets
- [`infrastructure/docker.md`](infrastructure/docker.md) — Docker Compose setup
- [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) — Server bootstrap and migration guide
