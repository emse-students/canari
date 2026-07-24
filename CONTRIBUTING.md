# Contributing to Canari

Thank you for contributing to Canari! This document outlines our workflow, coding standards, and how to get started.

## Workflow

Canari uses a **trunk-based development** model:

- Work directly on `main` — no feature branches, no pull requests.
- Commit small, incremental changes.
- Push frequently to avoid large merge conflicts.
- Use [conventional commits](https://www.conventionalcommits.org/) for clear history.

### Commit messages

```
feat: add biometric auth support
fix: resolve race condition in MLS epoch commit
refactor: extract presence manager to shared module
docs: update wiki architecture diagram
chore: bump dependencies
```

Common scopes: `gateway`, `mls`, `push`, `frontend`, `mobile`, `payments`, `associations`, `forms`, `channels`, `infra`.

## Pre-commit hooks

We use [Husky](https://typicode.github.io/husky/) + [pre-commit](https://pre-commit.com/) to enforce quality on every commit:

| Hook | Purpose |
|---|---|
| `oxlint` | JavaScript/TypeScript linting (frontend, zero warnings) |
| `oxvelte` | Svelte-specific linting rules |
| `oxfmt` | Opinionated code formatter |
| `cargo fmt --check` | Rust formatting check |
| `cargo clippy` | Rust linting |

All hooks must pass before a commit is accepted.

To install hooks:

```bash
make install-hooks
```

## Code quality (frontend)

```bash
cd frontend
bun run check          # svelte-check (0 errors required)
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier
```

## Code quality (Rust)

From any Rust crate (`apps/chat-gateway/`, `apps/call-service/`, `libs/shared-rust/`, `frontend/mls-core/`):

```bash
cargo clippy --all-targets --all-features
cargo fmt --check
cargo test
```

## Testing

```bash
make test              # All tests (Rust + NestJS + Vitest)
make test-gateway      # chat-gateway only
make test-frontend     # Frontend (Vitest)
make run-ci            # Full CI pipeline locally
```

Aim for tests on new features and bug fixes. No strict coverage threshold, but critical paths (auth, MLS, payments) should be well-tested.

## CI/CD

Every push to `main` triggers:

1. **CI** — lint, type-check, test (Rust + NestJS + frontend)
2. **Build** — WASM + SvelteKit + 6 Docker images → `ghcr.io/emse-students/canari/*`
3. **Deploy** — pull images on the production server via self-hosted runner, restart Docker Compose

The pipeline must be green before deploying. See [`docs/wiki/cicd.md`](docs/wiki/cicd.md) for details.

## Code style

- **TypeScript**: strict mode, prefer explicit types over inference for public API surfaces.
- **Rust**: follow [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/), use `anyhow` for application-level errors.
- **Svelte 5**: use runes (`$state`, `$derived`, `$effect`), avoid legacy stores.
- **Naming**: descriptive, avoid abbreviations (e.g., `peerConnection` not `pc`). Exceptions: well-known acronyms (MLS, JWT, OIDC).
- **Comments**: explain *why*, not *what*. The code should be self-documenting for the *what*.

## Architecture constraints

Before contributing, read the architecture overview:

- [Architecture](docs/wiki/architecture.md) — service topology, Nginx routing, auth flow
- [MLS protocol](docs/wiki/protocols/mls-protocol.md) — RFC 9420 integration
- [Development workflow](docs/wiki/development.md) — local setup, Docker Compose

Key rules:

- **No direct database access across services** — each service owns its database. Use HTTP APIs or Kafka for cross-service communication.
- **Nginx is the single entry point** — all client traffic goes through Nginx. Do not expose service ports directly in production.
- **Auth via `auth_request`** — Nginx validates every request through `core-service` before it reaches backend services.
- **MLS state is client-owned** — the server never decrypts MLS messages. It only routes opaque ciphertexts.

## Documentation

- **Technical documentation** lives in [`docs/wiki/`](docs/wiki/index.md) — English, LLM-oriented, organized by feature and module.
- **User-facing documentation** lives in [`docs/user-guide/`](docs/user-guide/index.md) — French, role-based (member, association manager, admin).
- Update the relevant wiki page when changing a service's behavior or adding a feature.

## Questions?

If you're unsure about something:

1. Search the [wiki](docs/wiki/index.md) first.
2. Check [`CLAUDE.md`](CLAUDE.md) for durable architectural gotchas.
3. Reach out to the maintainers directly.

---

**Thank you for contributing to Canari!** 🐤
