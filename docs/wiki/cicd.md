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
| **Build** | `wasm-pack build` + `npm run proto:gen` + `npm run build` |

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

## Signing

Two **named** provisioning profiles must exist and match `PROVISIONING_PROFILE_SPECIFIER` exactly:
one for the `Canari` app, one for the `CanariNotifications` notification-service extension. Team is
"Les Rootz" (`4CLNB8SR6L`); the profiles expire **2027-07-11**.

## Version bump

`scripts/bump-app-version.sh` must patch the NSE's `MARKETING_VERSION` and
`CURRENT_PROJECT_VERSION` alongside the app's — an NSE left behind on an older version is rejected
at upload. `bump-version.yml` stages an **explicit `git add` list**, so any new file the script
learns to patch has to be added there too, or the bump silently leaves it uncommitted.

## Notable CI gotchas

- iOS `altool` can exit 0 while output says `UPLOAD FAILED` — the workflow greps for failure markers in the transcript.
- Android Play API rejects `changesNotSentForReview` post-launch — never include this flag.
- `workflow_run` triggered off a release-triggered workflow must NOT have a `branches` filter (GitHub silently drops them).
- Pre-commit hooks sweep the whole frontend and re-stage — isolate unrelated dirty files before committing (`git stash` them).
- Never assert a wall clock in a test. An unseeded generator with rejection sampling once drew 31s against a 15s budget on a runner and took CD down: seed the input, and let the `it` timeout guard non-termination.

## See also

- [`development.md`](development.md) — Local dev workflow, Makefile targets
- [`infrastructure/docker.md`](infrastructure/docker.md) — Docker Compose setup
- [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) — Server bootstrap and migration guide
