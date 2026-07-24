# Development workflow

**Source**: `Makefile`, `scripts/`, `infrastructure/local/`

## Quick start

```bash
# Full local setup
make all                  # installs deps + builds frontend + starts services

# Or step by step:
make install              # installs Node, Bun, Rust, wasm-pack, frontend + service deps
make install-hooks        # installs Git hooks (Husky + oxlint + oxfmt + svelte-check)
make build-frontend       # builds WASM + protobuf bindings + SvelteKit
make run-services         # starts Docker Compose (local dev)
```

After setup, run the frontend dev server:

```bash
cd frontend
bun run dev
```

## Makefile targets

### Installation

| Target | What it does |
|---|---|
| `make install` | Runs all install targets below |
| `make install-node` | Installs Node.js (nvm LTS), Linux/Mac only |
| `make install-bun` | Installs Bun, Linux/Mac only |
| `make install-rust` | Installs Rust >= 1.93 via rustup |
| `make install-wasm-pack` | Installs `wasm-pack` via cargo |
| `make install-frontend` | `npm install` + `svelte-kit sync` in `frontend/` |
| `make install-services` | `npm install` in all NestJS service dirs + shared-ts |
| `make install-hooks` | Husky + pre-commit hooks |

### Build

| Target | What it does |
|---|---|
| `make build-frontend` | `wasm-pack build` → `npm run proto:gen` → `npm run build` (SvelteKit) |

### Services

| Target | What it does |
|---|---|
| `make run-services` | `docker compose up -d` with local dev compose file |
| `make reload-services` | Down + up (restart) |
| `make reset-services` | Down -v + up (wipe volumes) |

### Testing

| Target | What it does |
|---|---|
| `make test` | Runs all test suites (libs + gateway + delivery + frontend) |
| `make test-libs` | `cargo test` in `libs/shared-rust` |
| `make test-gateway` | `cargo test` in `apps/chat-gateway` |
| `make test-history` | `npm test` in `apps/chat-delivery-service` |
| `make test-frontend` | `npm test` (Vitest) in `frontend/` |
| `make bench-mls` | Criterion benchmarks for mls-core hot paths |

### CI

| Target | What it does |
|---|---|
| `make run-ci` | `lint-frontend` + `test` (full local CI pipeline) |
| `make lint-frontend` | `check` + `lint` + `format:check` in frontend |

### Environment

| Target | What it does |
|---|---|
| `make setup-env` | Creates `frontend/.env` + `infrastructure/.env` with generated secrets |
| `make setup-env-prod` | Creates `infrastructure/.env` only (production) |

### Production

| Target | What it does |
|---|---|
| `make production` | `pull` + `up -d` with production compose file |
| `make reset-services-prod` | Wipe volumes + pull + start (production) |
| `make update-services-prod` | Pull new images + restart (production) |

## Pre-commit hooks

Husky runs on every commit:

```bash
# In frontend/:
oxlint       # Lint TypeScript
oxvelte      # Lint Svelte
oxfmt --check # Format check
svelte-check  # Type check
```

The hooks run across the **whole frontend** and re-stage modified files. Isolate unrelated dirty files before committing.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/setup-env.sh` | Interactive env file generator (dev + prod) |
| `scripts/bump-app-version.sh` | Bump mobile app version (Android + iOS) |
| `scripts/check-oidc.sh` | Test OIDC configuration against Authentik |
| `scripts/install-oxvelte.sh` | Install oxvelte (Svelte linter) |

## Local services (Docker Compose)

**File**: `infrastructure/local/docker-compose.yml`

All services + infrastructure run in Docker with host port mapping. Dev host ports are offset to avoid conflicts:

| Service | Container port | Dev host port |
|---|---|---|
| frontend (Nginx) | 80 | 3080 |
| chat-gateway | 3000 | 3100 |
| call-service | 3004 | 3104 |
| chat-delivery-service | 3010 | 3110 |
| media-service | 3011 | 3111 |
| core-service | 3012 | 3112 |
| social-service | 3014 | 3114 |
| Redis | 6379 | 6380 |
| PostgreSQL | 5432 | 5433 |
| MongoDB | 27017 | 27018 |
| Kafka | 9092 | 9093 |
| MinIO API | 9000 | 19100 |
| MinIO Console | 9001 | 19101 |

### Dockerfiles

Each service has a build-only `Dockerfile` in `infrastructure/local/`:

| Dockerfile | Service |
|---|---|
| `Dockerfile.frontend` | Nginx + SvelteKit static bundle |
| `Dockerfile.chat-gateway` | Rust chat-gateway |
| `Dockerfile.call-service` | Rust call-service |
| `Dockerfile.chat-delivery-service` | NestJS chat-delivery |
| `Dockerfile.core-service` | NestJS core-service |
| `Dockerfile.media-service` | NestJS media-service |
| `Dockerfile.social-service` | NestJS social-service |

## Production deployment

See [`cicd.md`](cicd.md) for the full CI/CD pipeline and [`infrastructure/docker.md`](infrastructure/docker.md) for production Docker Compose.

## Environment variables

Two env files:
- `frontend/.env` — build-time Vite variables (baked into the SvelteKit bundle)
- `infrastructure/.env` — runtime variables for all Docker services

See `infrastructure/.env.example` for the template.

### Frontend build-time variables

| Variable | Default |
|---|---|
| `VITE_GATEWAY_URL` | chat-gateway WS URL |
| `VITE_DELIVERY_URL` | chat-delivery-service URL |
| `VITE_MEDIA_URL` | media-service URL |
| `VITE_CORE_URL` | core-service URL |
| `VITE_SOCIAL_URL` | social-service URL |
| `VITE_OIDC_AUTHORITY` | Authentik issuer URL |
| `VITE_OIDC_CLIENT_ID` | OIDC client ID |
| `VITE_OIDC_REDIRECT_URI` | OIDC callback URI |

## Package manager

- **Frontend**: Bun (committed `bun.lock`, CI uses `--frozen-lockfile`).
- **Backend services**: npm (each service has its own `package.json`).
- **Makefile**: shells out to npm for service installs.

Prefer `bun` locally for frontend work; `npm` also works.

## Rust toolchain

Rust >= 1.93 required (enforced by `rust-toolchain.toml`). Relevant crates:

| Crate | Path | Purpose |
|---|---|---|
| `chat-gateway` | `apps/chat-gateway/` | WebSocket gateway |
| `call-service` | `apps/call-service/` | WebRTC SFU |
| `shared-rust` | `libs/shared-rust/` | Shared Kafka event types |
| `mls-core` | `frontend/mls-core/` | Core MLS operations |
| `mls-wasm` | `frontend/mls-wasm/` | WASM bindings for mls-core |
| `src-tauri` | `frontend/src-tauri/` | Tauri 2 native app |

### Linting

```bash
cargo clippy   # All Rust crates
```
