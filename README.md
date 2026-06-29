<div align="center">
  <img src="frontend/static/favicon.png" alt="Canari Logo" width="200"/>

# Canari

**Messagerie securisee E2E pour l'EMSE · Architecture microservices**

[![Built with SvelteKit](https://img.shields.io/badge/Built%20with-SvelteKit-FF3E00?logo=svelte)](https://kit.svelte.dev/)
[![Powered by Bun](https://img.shields.io/badge/Powered%20by-Bun-000000?logo=bun)](https://bun.sh/)
[![Built with Rust](https://img.shields.io/badge/Built%20with-Rust-CE422B?logo=rust)](https://www.rust-lang.org/)

[![CI](https://github.com/emse-students/canari/actions/workflows/ci.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/ci.yml)
[![CD](https://github.com/emse-students/canari/actions/workflows/cd.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/cd.yml)
[![Code Analysis](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

Canari est la plateforme de messagerie et de vie associative de l'Ecole des Mines de Saint-Etienne.
Les conversations privees et les groupes sont chiffres de bout en bout avec le **protocole MLS**
(RFC 9420). Les communautes (workspaces/channels) utilisent un chiffrement symetrique derive par HKDF.

---

## Architecture

```
Navigateur / Tauri
    | (HTTPS + WS)
    v
 Nginx  --auth_request--> core-service:3012
    |
    |-> chat-gateway:3000      (Rust/Axum)  WebSocket temps reel, presence
    |-> chat-delivery:3010     (NestJS)     API MLS, messages offline, historique
    |-> media-service:3011     (NestJS)     Blobs chiffres (MinIO)
    |-> core-service:3012      (NestJS)     Auth OIDC, utilisateurs, paiements
    `-> social-service:3014    (NestJS)     Posts, formulaires, channels/communautes

Infrastructure : PostgreSQL . MongoDB . Redis . Kafka . MinIO
```

> En production, Cloudflare Tunnel termine le TLS et pointe sur `http://localhost:8080 -> Nginx`.

---

## Documentation

La documentation technique est dans [`docs/wiki/`](docs/wiki/index.md) (en anglais, par feature/module).

| Page wiki | Contenu |
|---|---|
| [Architecture](docs/wiki/architecture.md) | Topologie, routage Nginx, flux auth, schemas DB |
| [API surface](docs/wiki/api-surface.md) | Tous les endpoints de tous les services |
| [MLS protocol](docs/wiki/mls-protocol.md) | RFC 9420, epochs, forward secrecy, sync devices |
| [chat-gateway](docs/wiki/services/chat-gateway.md) | Gateway Rust, WebSocket, Redis pub/sub |
| [chat-delivery](docs/wiki/services/chat-delivery.md) | API MLS, messages, push, locks |
| [core-service](docs/wiki/services/core-service.md) | Auth OIDC, utilisateurs, Stripe |
| [media-service](docs/wiki/services/media-service.md) | Blobs chiffres, CEK, MinIO |
| [social-service](docs/wiki/services/social-service.md) | Posts, channels, formulaires, associations |
| [Frontend](docs/wiki/frontend/architecture.md) | SvelteKit 5, Svelte 5 runes, Paraglide i18n |
| [MLS WASM](docs/wiki/frontend/mls-wasm.md) | openmls compile en WASM, gestion cles, sync |
| [Infrastructure](docs/wiki/infrastructure/docker.md) | Docker Compose, bases de donnees, Kafka |

Docs de reference en cours d'evolution (vivantes, garder) :

- [`docs/AUDIT-MLS-2026-06.md`](docs/AUDIT-MLS-2026-06.md) — audit securite MLS en cours
- [`docs/MLS_DESYNC_PREVENTION.md`](docs/MLS_DESYNC_PREVENTION.md) — prevention des desync MLS
- [`docs/MLS_RECOVERY_LADDER.md`](docs/MLS_RECOVERY_LADDER.md) — procedure de recovery MLS
- [`docs/TESTS-DEVICE-PENDING.md`](docs/TESTS-DEVICE-PENDING.md) — tests appareil en attente

---

## Demarrage rapide (dev local)

### Prerequis

- Docker + Docker Compose
- Node.js 24+, [Bun](https://bun.sh/), [Rust stable](https://rustup.rs/), `cargo install wasm-pack`
- `make`

### Lancer l'environnement

```bash
git clone https://github.com/emse-students/canari.git
cd canari

# Genere infrastructure/.env et frontend/.env avec des secrets aleatoires
./scripts/setup-env.sh

# Installe les dependances (Node + Rust + hooks)
make install

# Demarre tous les services Docker (DB, Kafka, Redis, gateway, services)
make run-services

# Dans un autre terminal : frontend avec HMR
cd frontend && bun run dev
# -> http://localhost:1420
```

> **Windows** : executer `scripts/windows/setup_environment.ps1` pour installer les prerequis,
> puis utiliser les memes commandes `make`.

### URLs locales

| Service | Adresse |
|---|---|
| Frontend (dev) | http://localhost:1420 |
| Chat Gateway (WS) | ws://localhost:3000 |
| Chat Delivery | http://localhost:3010 |
| Media Service | http://localhost:3011 |
| Core Service | http://localhost:3012 |
| Social Service | http://localhost:3014 |
| MinIO Console | http://localhost:9001 |

---

## Commandes utiles

```bash
# Tests
make test                 # Tous les tests (Rust + NestJS + Vitest)
make test-gateway         # Uniquement le chat-gateway Rust
make test-frontend        # Frontend (Vitest)
make run-ci               # Pipeline CI complet

# Build
make build-frontend       # Compile WASM + bundle SvelteKit

# Services
make run-services         # Demarre les conteneurs locaux
make reload-services      # Redemarre
make reset-services       # Redemarre + vide les bases de donnees

# Qualite de code (frontend)
cd frontend
bun run check             # paraglide:compile + svelte-kit sync + svelte-check (0 erreur requis)
npm run lint:fix          # Corrige les erreurs ESLint
npm run format            # Formate avec Prettier

# Rust (depuis n'importe quel service)
cargo clippy
cargo test
```

---

## Stack technique

| Couche | Technologies |
|---|---|
| **Frontend** | SvelteKit 5 . Svelte 5 (runes) . TailwindCSS 4 . Tauri 2 . Paraglide i18n |
| **MLS client** | Rust (openmls) compile en WASM . ChaCha20-Poly1305 . Argon2 |
| **Gateway** | Rust . Axum . Tokio . Redis pub/sub |
| **Services** | NestJS 10 . TypeORM . Node.js 24 . Bun |
| **Infrastructure** | PostgreSQL . MongoDB . Redis . Kafka . MinIO |
| **Auth** | Authentik (OIDC) . JWT HS256 . cookies HttpOnly |
| **DevOps** | Docker . GitHub Actions . Nginx . Cloudflare Tunnel |

---

## Structure du monorepo

```
canari/
|-- apps/
|   |-- chat-gateway/          # WebSocket gateway (Rust/Axum, port 3000)
|   |-- chat-delivery-service/ # API MLS + messages (NestJS, port 3010)
|   |-- media-service/         # Blobs chiffres (NestJS, port 3011)
|   |-- core-service/          # Auth + users + paiements (NestJS, port 3012)
|   `-- social-service/        # Posts + channels + formulaires (NestJS, port 3014)
|-- frontend/
|   |-- src/                   # Application SvelteKit
|   |-- mls-core/              # Librairie MLS (Rust pur)
|   |-- mls-wasm/              # Bindings WASM (wasm-bindgen)
|   `-- src-tauri/             # Application desktop Tauri
|-- libs/
|   |-- proto/                 # Definitions Protobuf
|   |-- event-contracts/       # Schemas Kafka (JSON Schema)
|   |-- shared-rust/           # Utilitaires Rust partages
|   `-- shared-ts/             # Types TypeScript partages
|-- infrastructure/
|   |-- local/                 # Docker Compose + Dockerfiles (dev)
|   |-- docker-compose.prod.yml
|   `-- docker-compose.dev.yml
|-- scripts/                   # Setup, deploiement, utilitaires
|-- docs/                      # Documentation (wiki dans docs/wiki/)
`-- Makefile
```

---

## CI/CD

Chaque push sur `main` declenche automatiquement :

1. **CI** - `cargo clippy`, `cargo test`, `eslint`, `svelte-check`, `vitest`
2. **Build** - WASM + SvelteKit + 6 images Docker -> `ghcr.io/emse-students/canari/*`
3. **Deploiement** - Pull des images sur le serveur via runner self-hosted, restart Docker Compose

Pour configurer un nouveau serveur, voir [`infrastructure/MIGRATION.md`](infrastructure/MIGRATION.md)
(source de verite du bootstrap serveur).

---

## Contribuer

```bash
# Travailler directement sur main (pas de branches de features)
# Hooks Husky : eslint + prettier au commit, svelte-check + cargo clippy au push
git commit -m "feat: description"   # conventional commits
git push
```
