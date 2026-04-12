<div align="center">
  <img src="frontend/static/favicon.png" alt="Canari Logo" width="200"/>

# Canari

**Messagerie sécurisée E2E pour l'EMSE · Architecture microservices**

[![Built with SvelteKit](https://img.shields.io/badge/Built%20with-SvelteKit-FF3E00?logo=svelte)](https://kit.svelte.dev/)
[![Powered by Bun](https://img.shields.io/badge/Powered%20by-Bun-000000?logo=bun)](https://bun.sh/)
[![Built with Rust](https://img.shields.io/badge/Built%20with-Rust-CE422B?logo=rust)](https://www.rust-lang.org/)

[![CI](https://github.com/emse-students/canari/actions/workflows/ci.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/ci.yml)
[![CD](https://github.com/emse-students/canari/actions/workflows/cd.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/cd.yml)
[![Code Analysis](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

Canari est la plateforme de messagerie et de vie associative de l'École des Mines de Saint-Étienne. Les conversations privées et les groupes sont chiffrés de bout en bout avec le **protocole MLS** (RFC 9420). Les communautés (workspaces/channels) utilisent un chiffrement symétrique dérivé par HKDF.

---

## Architecture en un coup d'œil

```
Navigateur / Tauri
    │  (HTTPS + WS)
    ▼
 Nginx  ──auth_request──► core-service:3012
    │
    ├──► chat-gateway:3000      (Rust/Axum)  WebSocket temps réel, présence
    ├──► chat-delivery:3010     (NestJS)     API MLS, messages offline, historique
    ├──► media-service:3011     (NestJS)     Blobs chiffrés (MinIO)
    ├──► core-service:3012      (NestJS)     Auth OIDC, utilisateurs, paiements
    └──► social-service:3014    (NestJS)     Posts, formulaires, channels/communautés

Infrastructure : PostgreSQL · MongoDB · Redis · Kafka · MinIO
```

> En production, Cloudflare Tunnel termine le TLS et pointe sur `http://localhost:8080 → Nginx`.

---

## Documentation

| Document | Contenu |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Topologie complète, routage Nginx, flux inter-services |
| [docs/MLS.md](docs/MLS.md) | Protocole MLS, implémentation Rust/WASM, flux de messages |
| [docs/COMMUNITIES.md](docs/COMMUNITIES.md) | Workspaces, channels, chiffrement des communautés |
| [docs/BACKEND.md](docs/BACKEND.md) | Services NestJS : endpoints, entités, auth |
| [docs/CHAT_GATEWAY.md](docs/CHAT_GATEWAY.md) | Gateway Rust : WebSocket, Redis Pub/Sub, présence |
| [docs/FRONTEND.md](docs/FRONTEND.md) | SvelteKit, Tauri, stores, routes, UI |
| [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md) | Docker Compose, CI/CD, premier déploiement |

---

## Démarrage rapide (dev local)

### Prérequis

- Docker + Docker Compose
- Node.js 20+, [Bun](https://bun.sh/), [Rust stable](https://rustup.rs/), `cargo install wasm-pack`
- `make`

### Lancer l'environnement

```bash
git clone https://github.com/emse-students/canari.git
cd canari

# Génère infrastructure/.env et frontend/.env avec des secrets aléatoires
./scripts/setup-env.sh

# Installe les dépendances (Node + Rust + hooks)
make install

# Démarre tous les services Docker (DB, Kafka, Redis, gateway, services)
make run-services

# Dans un autre terminal : frontend avec HMR
cd frontend && bun run dev
# → http://localhost:1420
```

> **Windows** : utiliser `scripts/windows/setup_environment.ps1` puis `scripts/windows/start_all.ps1`.

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
make test                 # Tous les tests (Rust + NestJS)
make test-gateway         # Uniquement le chat-gateway Rust

# Build production
make build-frontend       # Compile WASM + bundle SvelteKit

# Services
make run-services         # Démarre les conteneurs locaux
make reload-services      # Redémarre

# Déploiement prod (sur le serveur)
make production           # Pull images GHCR + restart Docker Compose

# Qualité de code (frontend)
cd frontend
bun run lint:fix          # Corrige les erreurs ESLint
bun run format            # Formate avec Prettier
bun run check             # svelte-check (TypeScript + Svelte)
```

---

## Stack technique

| Couche | Technologies |
|---|---|
| **Frontend** | SvelteKit 2.9 · Svelte 5 (runes) · TailwindCSS 4 · Tauri 2 |
| **MLS client** | Rust (openmls, ChaCha20-Poly1305, Argon2) compilé en WASM |
| **Gateway** | Rust · Axum · Tokio · Redis Pub/Sub |
| **Services** | NestJS 10 · TypeORM · Node.js 20 |
| **Infrastructure** | PostgreSQL · MongoDB · Redis · Kafka · MinIO |
| **Auth** | Authentik (OIDC) · JWT HS256 · cookies HttpOnly |
| **DevOps** | Docker · GitHub Actions · Nginx · Cloudflare Tunnel |

---

## Structure du monorepo

```
canari/
├── apps/
│   ├── chat-gateway/          # WebSocket gateway (Rust/Axum)
│   ├── chat-delivery-service/ # API MLS + messages (NestJS)
│   ├── core-service/          # Auth + users + paiements (NestJS)
│   ├── media-service/         # Blobs chiffrés (NestJS + MinIO)
│   └── social-service/        # Posts + channels + formulaires (NestJS)
├── frontend/
│   ├── src/                   # Application SvelteKit
│   ├── mls-core/              # Librairie MLS (Rust pur)
│   ├── mls-wasm/              # Bindings WASM (wasm-bindgen)
│   └── src-tauri/             # Application desktop Tauri
├── libs/
│   ├── proto/                 # Définitions Protobuf
│   ├── event-contracts/       # Schémas Kafka (JSON Schema)
│   ├── shared-rust/           # Utilitaires Rust partagés
│   └── shared-ts/             # Types TypeScript partagés
├── infrastructure/
│   ├── local/                 # Docker Compose + Dockerfiles (dev)
│   ├── docker-compose.prod.yml
│   └── docker-compose.dev.yml
├── scripts/                   # Setup, déploiement, utilitaires
├── docs/                      # Documentation technique
└── Makefile
```

---

## CI/CD

Chaque push sur `main` déclenche automatiquement :

1. **CI** — `cargo clippy`, `cargo test`, `eslint`, `svelte-check`
2. **Build** — WASM + SvelteKit + 6 images Docker → `ghcr.io/emse-students/canari/*`
3. **Déploiement** — Pull des images sur le serveur via runner self-hosted, restart Docker Compose

Le seul secret à configurer dans GitHub est `JWT_SECRET` (voir [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md)).

---

## Contribuer

```bash
git checkout -b feat/ma-feature
# … faire les changements …
git commit -m "feat: description"   # conventional commits
git push origin feat/ma-feature
# → ouvrir une Pull Request
```

Les hooks Husky vérifient automatiquement ESLint + Prettier au commit, et `svelte-check` + `cargo clippy` au push.
