<div align="center">
  <img src="frontend/static/favicon.png" alt="Canari Logo" width="200"/>

# Canari

**End-to-end encrypted messaging & campus life platform for École des Mines de Saint-Étienne**

[![Built with SvelteKit](https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte)](https://kit.svelte.dev/)
[![Powered by Bun](https://img.shields.io/badge/Bun-000000?logo=bun)](https://bun.sh/)
[![Built with Rust](https://img.shields.io/badge/Rust-CE422B?logo=rust)](https://www.rust-lang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-E0234E?logo=nestjs)](https://nestjs.com/)

[![CI](https://github.com/emse-students/canari/actions/workflows/ci.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/ci.yml)
[![CD](https://github.com/emse-students/canari/actions/workflows/cd.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/cd.yml)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

</div>

---

## Overview

Canari is the messaging and campus life platform for École des Mines de Saint-Étienne.
Private conversations and groups are **end-to-end encrypted** with the [MLS protocol](docs/wiki/protocols/mls-protocol.md)
(RFC 9420). Communities (workspaces/channels) use HKDF-derived symmetric encryption.

Key features:
- **E2E encrypted messaging** — Direct messages, group chats, media sharing (AES-256-GCM + MLS)
- **Voice & video calls** — WebRTC with SFU relay, CallKit integration on iOS
- **Communities** — Role-based workspaces and channels with server-assisted encryption
- **Associations** — Club management, membership dues (cotisations), boutique shop (Stripe Connect)
- **Forms & payments** — Dynamic form builder with Stripe Checkout, cash payments, Excel export
- **News feed** — Markdown posts, polls, reactions, comments
- **Cross-platform** — Web (SvelteKit), Android & iOS (Tauri 2), Linux desktop (AppImage)

## Architecture

```
Browser / Tauri (Native App)
    | (HTTPS + WSS)
    v
 Nginx  ──auth_request──> core-service:3012
    |
    |-> chat-gateway:3000      (Rust/Axum)  WebSocket, presence, Redis pub/sub
    |-> call-service:3004      (Rust/Axum)  WebRTC SFU relay
    |-> chat-delivery:3010     (NestJS)     MLS API, offline queue, push, sync
    |-> media-service:3011     (NestJS)     Encrypted blob storage (MinIO)
    |-> core-service:3012      (NestJS)     OIDC auth (Authentik), users, Stripe
    `-> social-service:3014    (NestJS)     Posts, forms, channels, associations

Infrastructure: PostgreSQL · MongoDB · Redis · Kafka · MinIO
```

> In production, Cloudflare Tunnel terminates TLS and forwards to `localhost:8080` → Nginx.

## Quick start

### Prerequisites

- Docker + Docker Compose
- Node.js 24+, [Bun](https://bun.sh/), [Rust ≥ 1.93](https://rustup.rs/), `cargo install wasm-pack`
- `make`

### Setup

```bash
git clone https://github.com/emse-students/canari.git
cd canari

# Generate environment files with random secrets
./scripts/setup-env.sh

# Install all dependencies
make install

# Start all Docker services
make run-services

# In another terminal: start the frontend with HMR
cd frontend && bun run dev
# → http://localhost:1420
```

### Local URLs

| Service | URL |
|---|---|
| Frontend (dev) | http://localhost:1420 |
| Chat Gateway (WS) | ws://localhost:3000 |
| Chat Delivery | http://localhost:3010 |
| Media Service | http://localhost:3011 |
| Core Service | http://localhost:3012 |
| Social Service | http://localhost:3014 |
| MinIO Console | http://localhost:9001 |

## Commands

```bash
# Testing
make test              # All tests (Rust + NestJS + Vitest)
make test-gateway      # chat-gateway only
make test-frontend     # Frontend (Vitest)
make run-ci            # Full CI pipeline locally

# Build
make build-frontend    # WASM + SvelteKit bundle

# Services
make run-services      # Start Docker containers
make reload-services   # Restart
make reset-services    # Restart + wipe databases

# Code quality (frontend)
cd frontend
bun run check          # svelte-check (0 errors required)
npm run lint:fix       # ESLint auto-fix
npm run format         # Prettier

# Rust (from any crate)
cargo clippy
cargo test
```

## Documentation

### Technical

All technical documentation lives in [`docs/wiki/`](docs/wiki/index.md) — English, LLM-oriented, organized by feature and module.

| Page | Contents |
|---|---|
| [Architecture](docs/wiki/architecture.md) | Service topology, Nginx routing, auth flow |
| [Glossary](docs/wiki/glossary.md) | Acronyms and terminology |
| [MLS protocol](docs/wiki/protocols/mls-protocol.md) | RFC 9420, epochs, forward secrecy |
| [API surface](docs/wiki/protocols/api-surface.md) | Full endpoint inventory |
| [WebSocket protocol](docs/wiki/protocols/websocket-protocol.md) | Protobuf wire format |
| [Development](docs/wiki/development.md) | Local setup, Makefile, pre-commit hooks |
| [CI/CD](docs/wiki/cicd.md) | GitHub Actions, mobile builds, releases |

### User guide

French-language user documentation is in [`docs/user-guide/`](docs/user-guide/index.md):

| Page | Audience |
|---|---|
| [Member](docs/user-guide/membre.md) | Students and staff using Canari |
| [Association manager](docs/user-guide/responsable-association.md) | Club secretaries, treasurers, presidents |
| [Administrator](docs/user-guide/administrateur.md) | Platform administrators |

## Tech stack

| Layer | Technologies |
|---|---|
| **Frontend** | SvelteKit 5 · Svelte 5 (runes) · TailwindCSS 4 · Tauri 2 · Paraglide i18n |
| **MLS client** | Rust (OpenMLS) → WASM · ChaCha20-Poly1305 · Argon2 |
| **Gateway** | Rust · Axum · Tokio · Redis pub/sub |
| **SFU** | Rust · webrtc-rs · Axum · Cloudflare TURN |
| **Backend services** | NestJS 10 · TypeORM · Node.js 24 |
| **Data stores** | PostgreSQL · MongoDB · Redis · MinIO |
| **Auth** | Authentik (OIDC) · JWT HS256 · HttpOnly cookies |
| **DevOps** | Docker · GitHub Actions · Nginx · Cloudflare Tunnel |

## Repository structure

```
canari/
├── apps/
│   ├── chat-gateway/          # WebSocket gateway (Rust, port 3000)
│   ├── call-service/          # WebRTC SFU (Rust, port 3004)
│   ├── chat-delivery-service/ # MLS API + push (NestJS, port 3010)
│   ├── media-service/         # Encrypted blobs (NestJS, port 3011)
│   ├── core-service/          # Auth + users + payments (NestJS, port 3012)
│   └── social-service/        # Posts + channels + forms (NestJS, port 3014)
├── frontend/
│   ├── src/                   # SvelteKit app
│   ├── mls-core/              # Shared Rust MLS logic
│   ├── mls-wasm/              # WASM bindings (wasm-bindgen)
│   └── src-tauri/             # Tauri 2 native app
├── libs/
│   ├── proto/                 # Protobuf schema (canari.proto)
│   ├── shared-rust/           # Shared Rust types (Kafka events)
│   └── shared-ts/             # Shared TypeScript types
├── infrastructure/
│   ├── local/                 # Docker Compose & Dockerfiles (dev)
│   ├── docker-compose.prod.yml
│   ├── docker-compose.dev.yml
│   ├── backup/                # Backup scripts & systemd units
│   └── authentik/             # Authentik OIDC stack
├── scripts/                   # Setup, deployment, utilities
├── docs/
│   ├── wiki/                  # Technical documentation (English)
│   ├── user-guide/            # User-facing documentation (French)
│   └── diagrams/              # UML sequence diagrams
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── Makefile
```

## CI/CD

Every push to `main` triggers:

1. **CI** — `cargo clippy`, `cargo test`, `oxlint`, `oxvelte`, `svelte-check`, `vitest`
2. **Build** — WASM + SvelteKit + 6 Docker images → `ghcr.io/emse-students/canari/*`
3. **Deploy** — Pull images on production server via self-hosted runner, restart Docker Compose

For server bootstrap, see [`infrastructure/MIGRATION.md`](infrastructure/MIGRATION.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full guide: workflow, coding standards, pre-commit hooks, testing, and architecture constraints.

Quick reference:

```bash
# Work directly on main (no feature branches)
# Pre-commit hooks: oxlint + oxvelte + oxfmt on commit
git commit -m "feat: description"   # conventional commits
git push
```

Release history is in [`CHANGELOG.md`](CHANGELOG.md).

## License

Canari is distributed under the [**PolyForm Noncommercial License 1.0.0**](LICENSE).

- **Non-commercial use**: freely use, copy, modify, and redistribute for non-commercial purposes
  (education, research, associative projects, personal use, educational institutions).
- **Attribution required**: any copy or redistribution must retain the `Required Notice` from
  the [`LICENSE`](LICENSE) file (author + repository link).
- **Commercial use**: prohibited without a separate license agreement with the authors.

This is a source-available license, not an OSI-approved open-source license.
