# CI/CD pipeline

Canari uses GitHub Actions for continuous integration and deployment. The pipeline lives in `.github/workflows/`.

## Workflows

### CI (`ci.yml`)

Runs on every push and pull request to `main`:

| Job | What it checks |
|---|---|
| **Rust tests** | `cargo test` across all crates (`shared-rust`, `chat-gateway`) |
| **TypeScript tests** | NestJS tests in `chat-delivery-service` |
| **Frontend tests** | `vitest` in `frontend/` |
| **Frontend lint** | `oxlint` + `oxvelte` + `oxfmt --check` + `svelte-check` (0 errors required) |
| **Build** | the generated sources first - [`.github/actions/build-mls-wasm`](../../.github/actions/build-mls-wasm/action.yml) then `bun run proto:gen` - then `bun run build` |

**The generated sources are not in git** (`frontend/src/lib/wasm/`, `src/lib/proto/canari.{js,d.ts}`),
so EVERY pipeline that ships a client builds them: `cd.yml`, `cd-dev.yml`, the three release
workflows, and `ci.yml` because the gates import them. One composite action, one pinned
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
`frontend/mls-wasm/Cargo.lock`, `shared-rust` in `apps/chat-gateway/Cargo.lock`. So the script
collects the `[package] name` of every manifest it bumps and rewrites every matching `[[package]]`
block in every lock — a per-crate patch, not a per-directory one.

Until 2026-08-06 it patched no lock at all, and the symptom was not a broken build (nothing runs
`cargo --locked`) but a **misattributed diff**: the entry stayed a release behind until some
unrelated commit happened to run cargo and the pre-commit sweep carried the regenerated lock in.
`0.12.0 → 0.13.0` shipped inside a docs commit (`0e86b34c`) that way.

Which locks are committed is a separate decision, kept in `.gitignore`: a lock is committed when the
package it locks is itself built into a **shipped artefact** (`frontend/src-tauri`, `frontend/mls-wasm`,
`apps/*`), and ignored when the crate is only ever consumed as a dependency (`mls-core`,
`shared-rust`) — those resolve inside their consumer's lock. The negations must sit **after** the
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
