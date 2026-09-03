# CI/CD pipeline

Canari uses GitHub Actions for continuous integration and deployment. The pipeline lives in `.github/workflows/`.

## Workflows

### CI (`ci.yml`)

Runs on every pull request to `main`, and again on every push to `main`:

| Job | What it checks |
|---|---|
| **Rust tests** | `cargo test` across all crates (`chat-gateway`, `call-service`, `mls-core`) |
| **TypeScript tests** | NestJS tests in `chat-delivery-service` |
| **Frontend tests** | `vitest` in `frontend/` |
| **Frontend lint** | `oxlint` + `oxvelte` + `oxfmt --check` + `svelte-check` (0 errors required) |
| **Build** | the generated sources first - [`.github/actions/build-mls-wasm`](../../.github/actions/build-mls-wasm/action.yml) then `bun run proto:gen` - then `bun run build` |

**The generated sources are not in git** (`frontend/src/lib/wasm/`, `src/lib/proto/canari.{js,d.ts}`),
so EVERY pipeline that ships a client builds them: `deploy.yml`, the three release workflows, and
`ci.yml` because the gates import them. One composite action, one pinned
`wasm-pack`, one cache key over `mls-wasm/**` + `mls-core/**` + `rust-toolchain.toml` - the
committed binary went a crypto fix stale precisely because only some pipelines rebuilt it
([mls-wasm](frontend/mls-wasm.md#why-it-is-not-committed)).

**The second trigger is what makes a merge on `main` mean something.** A pull request is tested
against its own head, so two pull requests that each pass can still break `main` between them; the
push run is the one that says whether the merged result is green. It also covers what a required
check cannot - an admin bypassing the ruleset for an emergency hotfix still gets told, on `main`,
what the bypass skipped. **Nothing here deploys**, so a red run on `main` is a statement about the
repository and never about production, which is still serving the last release.

### Deploy an estate (`deploy.yml`)

**IT HAS NO TRIGGER AT ALL: it is `workflow_call` only, and `release.yml` is its one caller**
(user, 2026-09-02: *"Le deploiement (production, android, ios...) se fait au bump. Pas au push sur
main."*). A push to `main` deploys nothing, and there is no `workflow_dispatch` either - a dispatch
would simply be a second door. Retrying a half-failed deploy is "Re-run failed jobs" on the release
run that already exists.

**IT IS THEREFORE A JOB OF THE RELEASE RUN, WHICH HAS ONE CONSEQUENCE WORTH KNOWING:**
`gh run list --workflow deploy.yml` returns NOTHING. A called workflow's jobs belong to the caller's
run, so the run to read is the `Release` one, and the harness's `deploy.mjs` names `release.yml` for
that reason.

**WHICH ESTATE IS DECIDED BY THE RELEASE, NOT BY A BRANCH, AND NOT BY THIS FILE EITHER.** It is
told, as three inputs - `sha`, `version`, `prerelease` - resolved ONCE by the caller's `preflight`
job. Until 2026-09-03 it read `frontend/package.json` back off a checkout and decided for itself,
which is how three chains came to each re-derive the same fact:

| The release | What is deployed | Image tag it moves |
| --- | --- | --- |
| `v0.15.0-alpha.1` (pre-release) | `dev.canari-emse.fr`, plus the Play *internal* track and TestFlight | `:dev` |
| `v0.15.0` (stable) | production | `:latest` |

1. `detect-changed-services` diffs against the previous release **of the same kind**
2. Builds the frontend against that estate's `VITE_*` set, then only the changed images → GHCR
3. Self-hosted runner: sync `.env`, `docker compose pull` + `up -d`
4. Database migrations, then health checks

**THE CALLER DECIDES, ONCE, AND A HYPHEN IS STILL THE DEFINITION.** The reason this used to be
read out of the manifest here is worth keeping, because it explains what NOT to go back to:
`github.event.release.prerelease` does not exist in a `workflow_run` context - the event was the
bump run's completion, not the release - and `workflow_run.head_branch` carried the tag for a
release-triggered bump but said `main` when the bump was dispatched by hand, which would silently
have sent an alpha to production. So the manifest was the only honest source available *to a
workflow woken by another workflow*. Now that all three arms are CALLED, the honest source is the
caller: `release_kind()` in `.github/scripts/lib/release-preconditions.sh` answers stable-or-
prerelease once, off the version being released, and the same answer reaches the estate, the Play
track and the App Store channel. A hyphen in a semver version IS the definition, and there is now
exactly one implementation of that sentence.

`GITHUB_TOKEN` pushes from the version-bump workflow do **not** trigger `on: push`. CD is chained via `workflow_run` instead (no `branches:` filter — GitHub would silently drop release-triggered parents).

#### The baseline is the previous release OF THE SAME KIND, and that is forced by the image tags

Production deploys `:latest`, which only a stable release moves; dev deploys `:dev`, which only a
pre-release moves. A service a release does not rebuild keeps whatever that estate's tag already
points at - so the honest question is "what changed since the last release THAT ESTATE received".
Taking the previous release of *either* kind for dev would skip rebuilding a service changed since
the last alpha but not since the intervening stable, and dev would run a months-old image under a
tag claiming otherwise. With no previous release of that kind, everything is built: over-building
is slow, under-building ships an estate referencing an image that does not exist.

**The order comes from the GitHub API, not from `git tag --sort=v:refname`**: git's version sort
places `v1.0.0-alpha` AFTER `v1.0.0` unless `versionsort.suffix` is configured, which is the wrong
way round for every pre-release. `gh api .../releases` returns them newest-first by creation, which
is the order they deployed in.

**`prod-deployed` is gone, and its replacement answers a different question.** That tag was the
change detector's INPUT; the detector reads releases now, so the tag survives only as `prod-released`
- the record of which commit production is serving, written by the deploy that made it true. The
user took that deletion knowing its cost: **after an emergency push straight to `main`, nothing says
which commit production is running** until the next release.


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
backlog said it needed - *deciding where the release's SHA is resolved ONCE for all three chains* -
and the answer is `bump.outputs.sha`. `release-chain.test.sh` asserts that no arm checks out
`ref: main` and that all three receive that output, because this is a wiring property and wiring is
what a file can be read for.

#### The dev estate is the PRE-RELEASE target, and the promotion is gone

| The release | Jobs that run |
| --- | --- |
| pre-release | `release-kind`, `detect-changed-services`, `build-frontend`, `build-docker-images`, `deploy-dev` |
| stable | the same four, then `deploy-to-server` |

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

**The deploy body is two scripts, not inlined YAML.** `infrastructure/deploy/render-env.sh` resolves
every `.env` key from `infrastructure/deploy/env-manifest.tsv` and refuses to write a partial file;
`infrastructure/deploy/deploy-environment.sh` then takes the environment as an argument. Dev reads
`DEV_<NAME>` for every secret and never the bare name, so a missing dev secret is EMPTY rather than
production's value. **Production's own deploy job is deliberately NOT on these scripts yet** — it
moves once dev has exercised them. Everything about the estate itself is on
[dev-environment](infrastructure/dev-environment.md), the only copy.

`dev-refresh.yml` copies production's data into dev weekly (Mondays 04:00 UTC) and on demand, behind
the same gate.

### The store arms (`ios.yml`, `android.yml`)

Called by `release.yml` with the same three inputs `deploy.yml` gets, so the estate, the Play track
and the App Store channel cannot disagree about what is being released:

| Workflow | Output | Stable | Pre-release |
|---|---|---|---|
| `android.yml` | `.aab` for Google Play | `production` track | `internal` track |
| `ios.yml` | `.ipa` via `altool`, then the App Store version created, the build attached and the whole thing **submitted for review** | App Store review | TestFlight |

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

`appimage-release.yml` was deleted on the owner's decision - *"il n'y a actuellement aucune
perspective de ce cote la"*. It worked: it built and attached a `.AppImage` to every release, and it
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
`tauri://localhost` - iOS, macOS *and* a Linux desktop build - WKWebView drops the refresh cookie,
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
confirmed on v0.9.21 (*"Version code 9021 has already been used"*) - and what changed is that
`bump-app-version.sh` bands the pre-release counter into the code, so an alpha and its stable are
different numbers. See the version-bump section for the band.

**AN ALPHA POINTS AT `dev.canari-emse.fr` AND A STABLE AT PRODUCTION, ASSERTED IN ALL THREE.** This
is the one place in the migration where a mistake ships to phones: a store build bakes its backend
origin in and cannot be re-pointed afterwards, so an alpha built against production would let the
tester programme write to real data, and a stable built against dev would point every user at a box
wiped every Monday. Neither is visible in a green pipeline, so each workflow resolves the URL and
FAILS on a mismatch. There is no fallback from the `DEV_*` secrets to the production ones - falling
back is precisely how an alpha ends up talking to production.

### Release (`release.yml`) - the one entry point

**THREE HUMAN GESTURES, AND NOTHING ELSE MOVES** (user, 2026-09-03): open a pull request, which
`auto-merge.yml` squash-merges onto `main` once `CI passed` is green and which deploys NOTHING;
publish a pre-release `vX.Y.Z-alpha.N`, which deploys `dev.canari-emse.fr` and feeds the store
tester programmes; publish a stable `vX.Y.Z`, which deploys production and both store production
channels.

`release.yml` is the only workflow either publication triggers, and it has five jobs:
`preflight` -> `bump` -> `deploy` + `android` + `ios`. The three arms are `uses:` calls, not
`workflow_run` listeners, so they are jobs of ONE run: one page to read, real `needs:` ordering,
and the same inputs to all three.

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

| # | Question | Why a refusal rather than a report |
|---|---|---|
| 1 | Is the version a version? | a typo must not reach a store band computation |
| 2 | Is the released commit on `main`? | everything downstream reads the trunk |
| 3 | Did `CI passed` conclude **success** on THAT commit? | "if the tests are green" was written nowhere at all, and an ABSENT check is not a passing one |
| 4 | Has the dev estate already served it? (stable only) | **production cannot be ahead of dev** |
| 5 | Do the App Store release notes name THIS version? | Apple refuses a submission without them, and refusing at the END of a release costs the whole release |

**Gate 4 is why this file exists** (user, 2026-09-03: *"Je ne veux pas un detecteur de retard, je ne
veux pas que ca soit possible"*). It compares the released commit against the `dev-deployed` marker
the dev deploy writes: `identical` or dev `ahead` both mean the code went through dev, and dev
`behind` is a refusal naming how many commits are missing and telling the reader to publish a
pre-release at that commit first. A detector was written first and deleted unshipped - the same
measurement, as a refusal instead of a report.

**THERE IS NO BYPASS INPUT, deliberately.** A skip flag is a fallback path, and reaching one means
the primary path failed - so the fix belongs there. The emergency path is unchanged and is not in
software: a human with admin rights acting by other means, written into `CHANGELOG.md` when taken.
Gate 4 costs one extra pre-release in a real emergency, which deploys dev in minutes.

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
`dependabot-auto-merge.yml` already mints installation tokens for it. The bump job now does the
same and checks out with that token, because a later `git push` uses whatever credential the
checkout persisted. **`auto-merge.yml` mints the same identity for the same asymmetry read the
other way round** - see below. The token is minted per run and expires in an hour, which is why an App beats a
long-lived PAT here: there is no secret to rotate before it silently expires.

**One side effect, and why it is harmless HERE.** A push made with an App token *does* raise a
`push` event, where a `GITHUB_TOKEN` push does not — `dependabot-auto-merge.yml` documents that
asymmetry and depends on it. The consequence is that `ci.yml` runs once on the bump commit, which is
useful rather than costly. **It does not double a deploy, only because `deploy.yml` has no trigger at all** - it is
`workflow_call` only. Anyone giving a deploy workflow a `push` trigger has to read this paragraph
first.

**AND THE SAME ASYMMETRY IS LOAD-BEARING IN THE OTHER DIRECTION, WHICH IS WHY `auto-merge.yml` USES
AN APP TOO.** Auto-merge merges as whoever armed it. Armed with `GITHUB_TOKEN`, the merge would
raise no `push` event, `ci.yml` would never run on `main`, the merge commit would carry no
`CI passed` check - and gate 3 above would then refuse EVERY release, on commits that had in fact
been tested. Someone "simplifying" `auto-merge.yml` to the default token would break releasing from
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

| Value | Example | Where it goes | Why |
|---|---|---|---|
| the full version | `0.15.0-alpha.1` | every `package.json`, `Cargo.toml`, `Cargo.lock` | all accept a semver pre-release, and `frontend/package.json` is what the client identifies itself by (`VITE_APP_VERSION`, so `minClientVersion` compares against it) |
| the numeric core | `0.15.0` | `tauri.conf.json`, `CFBundleShortVersionString`, `MARKETING_VERSION` | Apple requires the short version to be numeric; a suffix there is an App Store validation failure |
| the band | `1500001` | `bundle.android.versionCode`, `CFBundleVersion`, `CURRENT_PROJECT_VERSION` | one integer identifies a build on both stores, and every alpha needs its own |

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

## GitHub Secrets

See [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) (section 3) for the full secrets inventory.


**A credential is real in THREE places, not two.** The CD regenerates `infrastructure/.env` from the
repo secrets, so a value set over SSH lasts until the next deploy. It must therefore be a GitHub
secret AND named in `deploy.yml` - and the third, just as mandatory and the easiest to forget, is the
service's own `environment:` block in `infrastructure/docker-compose.prod.yml` (and `.dev.yml` for
parity), spelt explicitly as `FOO: ${FOO:-}`. `.env` holding the value proves nothing about whether
Compose passes it INTO the container: `GOOGLE_SAFE_BROWSING_API_KEY` shipped correctly in `deploy.yml`
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

`deploy.yml` makes this safe by refusing every failure mode it can see:

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

| Tag | Meaning | Moved by |
|---|---|---|
| `latest` | what production is deploying | a STABLE release |
| `dev` | what the dev estate is deploying | a PRE-RELEASE |
| `<sha>` | the immutable one - this exact commit | every release that builds the image |
| `v0.15.0-alpha.1` | the release that produced it | every release that builds the image |

**The two moving tags never cross**, and that is what lets one registry feed two estates from two
different commits. Neither decides what actually runs: both compose files are deployed with an
explicit tag, and a service a release did not rebuild keeps whatever its estate's tag already points
at - which is what a selective rebuild means.

## Self-hosted runner

The `deploy-to-server` job runs on a self-hosted GitHub Actions runner (label `self-hosted`) on the production server (`canari`). This runner:

- Has direct access to the Docker socket (no SSH needed for container management)
- Has SSH access to `mitv` (offsite backup server)
- Runs as the `canari` system user

### There is one runner, so a workflow that asks for it must say what it may not overlap with

`deploy.yml` declares `concurrency: { group: cd-deploy, cancel-in-progress: false }`. Until 2026-09-02 it
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
adds the third workflow. `dev-refresh.yml` carries its own `dev-refresh` group and satisfies the same
rule.

**Still open, and not covered by either group:** a dev refresh and a dev deploy can overlap, the
refresh stopping dev's containers to restore while `deploy-dev` brings them up on new images. A
workflow may declare only one group, so joining them would put a Monday-04:00 database restore in
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
       '- three arms, in parallel, each building THAT SHA
            |- deploy.yml   production (stable) or dev.canari-emse.fr (pre-release)
            |- android.yml  .aab -> Play `production` (stable) or `internal` (pre-release)
            '- ios.yml      .ipa -> App Store Connect, then for a stable: version created,
                            build attached, release notes written, SUBMITTED FOR REVIEW
```

A pre-release stops at TestFlight and the Play `internal` track, which is what a tester programme
is. A stable goes all the way on both stores. **Nothing here is reached by a push to `main`.**

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

Dependabot opens the pull requests (`.github/dependabot.yml`); `dependabot-auto-merge.yml` decides
which of them merge, and `.github/scripts/dependabot-auto-merge.sh` is the decision itself. The
script is the ONE implementation - the workflow calls it from two triggers and adds nothing.

### Every update merges onto `main`, and what protects production is that a merge does not deploy

For one day (2026-09-02) all six blocks of `dependabot.yml` carried `target-branch: "dev"`, asked by
the user (*"Est-ce qu'on pourrait dire a Dependabot de push sur la branche dev au lieu de la prod
?"*). The user cancelled the two-branch model the following day; the lines are gone and updates
merge onto `main` again.

**The danger they answered has MOVED, not gone.** Every gate in this repository answers a question
about the SOURCE - does it compile, do the tests pass, is the lockfile coherent. None runs anything
against real data, and that is the class the outage of 2026-09-01 came from: `postgres
15-alpine -> 18-alpine` passed every gate, merged, and PG 18 then refused production's data
directory. 33 minutes down.

**What stands between that update and production now is that nothing deploys at a merge.** An update
sits on `main` until somebody publishes a release, and a `X.X.X-alpha.N` pre-release deploys the dev
estate - which still carries a copy of production - before any stable does. The honest difference is
WHO DECIDES: the old mechanism ran with nobody at the keyboard, this one runs when a human publishes
an alpha. The ceiling in `dependabot-auto-merge.yml` is what still refuses the update classes this
repository cannot see the failure mode of; it is not a substitute for a rehearsal, and
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
The three ways out, and the detection that would have named it on day one rather than 25 days later,
are in [backlog](backlog.md).

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
next deploy.** `deploy.yml` runs `git reset --hard origin/main`, so pinning the image back over SSH
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
- **`workflow_run` on `CI`** - the convergent path, **and it was CD until 2026-09-03**. Whatever
  runs on every push to `main` is the closest thing this repository has to "somebody did something",
  and it is answered with a FULL SWEEP of every open Dependabot pull request. CD stopped being that
  workflow when deployment moved to the bump: hanging the sweep off it now would drain the queue
  once per RELEASE, which is weeks. **This is the rule below catching its own instance** - a
  convergent trigger names an EVENT, a workflow is only ever its current proxy, and nothing
  announces the day one stops being the other.
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
