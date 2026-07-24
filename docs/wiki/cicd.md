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

Deploys to the production server on push to `main` (or manual trigger):

1. Generates `infrastructure/.env` from GitHub Secrets
2. Builds Docker images and pushes to GHCR (`ghcr.io/emse-students/canari/<service>`)
3. SSH into production server (self-hosted runner)
4. `docker compose pull` + `docker compose up -d`
5. Runs database migrations
6. Health check verification

### Mobile CD (`ios.yml`, `android.yml`, `appimage.yml`)

Triggered on release (`vX.Y.Z` tag). Each builds the Tauri app for its platform:

| Workflow | Output |
|---|---|
| `ios.yml` | `.ipa` for TestFlight upload (uses `altool`) |
| `android.yml` | `.aab` for Google Play upload |
| `appimage.yml` | `.AppImage` for Linux desktop |

### Version bump (`bump-version.yml`)

Triggered manually to bump `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` across iOS pbxproj (app + NSE targets) and Android manifest. Must stage the explicit file list — any new file the bump script patches must be added to the workflow.

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
1. Developer: git tag vX.Y.Z && git push origin vX.Y.Z
2. CD workflow builds + deploys backend
3. Mobile workflows build iOS/Android/AppImage artifacts
4. iOS: altool upload to App Store Connect (manual TestFlight submission after)
5. Android: upload to Google Play (automatic or manual depending on track)
```

## Notable CI gotchas

- iOS `altool` can exit 0 while output says `UPLOAD FAILED` — the workflow greps for failure markers in the transcript.
- Android Play API rejects `changesNotSentForReview` post-launch — never include this flag.
- `workflow_run` triggered off a release-triggered workflow must NOT have a `branches` filter (GitHub silently drops them).
- Pre-commit hooks sweep the whole frontend and re-stage — isolate unrelated dirty files before committing (`git stash` them).

## See also

- [`development.md`](development.md) — Local dev workflow, Makefile targets
- [`infrastructure/docker.md`](infrastructure/docker.md) — Docker Compose setup
- [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) — Server bootstrap and migration guide
