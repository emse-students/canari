<div align="center">
  <img src="frontend/static/favicon.png" alt="Canari Logo" width="200"/>

# Canari

**Messagerie Sécurisée E2E · Architecture Microservices**

[![Built with SvelteKit](https://img.shields.io/badge/Built%20with-SvelteKit-FF3E00?logo=svelte)](https://kit.svelte.dev/)
[![Powered by Bun](https://img.shields.io/badge/Powered%20by-Bun-000000?logo=bun)](https://bun.sh/)
[![Built with Rust](https://img.shields.io/badge/Built%20with-Rust-CE422B?logo=rust)](https://www.rust-lang.org/)

[![CI](https://github.com/emse-students/canari/actions/workflows/ci.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/ci.yml)
[![CD](https://github.com/emse-students/canari/actions/workflows/cd.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/cd.yml)
[![Code Analysis](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## 📋 Vue d'ensemble

Canari est une application de **messagerie instantanée sécurisée** avec chiffrement de bout en bout utilisant le **protocole MLS** (Messaging Layer Security). Bâtie sur une architecture **microservices moderne**, elle combine un frontend Svelte performant avec une infrastructure backend robuste en Rust et NestJS.

### ✨ Fonctionnalités principales

- 🔐 **Chiffrement E2E (MLS)** - Protocole de sécurité standard pour la messagerie de groupe
- 👥 **Conversations de groupe** - Support complet des groupes avec gestion des membres
- 💬 **Historique sécurisé** - Messages indexés et stockés en base de données
- 🔔 **Notifications en temps réel** - WebSocket avec routage smart online/offline
- 📱 **Support multi-device** - Synchronisation fluide entre appareils
- 🖥️ **Desktop & Web** - Frontend Tauri (desktop) et SvelteKit (web)
- ⚡ **Infrastructure scalable** - Kafka, Redis, PostgreSQL, MongoDB
- 🚀 **Déploiement automatisé** - CI/CD complet avec GitHub Actions et Docker

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────┐
│   Frontend (SvelteKit + Tauri)                       │
│   Chiffrement MLS côté client                        │
└────────────────────┬─────────────────────────────────┘
                     │
                [WebSocket]
                     │
      ┌──────────────▼──────────────┐
      │ Chat Gateway (Rust - Axum)  │
      │ • Routage temps réel        │
      │ • WebSocket management      │
      │ • Redis PubSub              │
      └────┬──────────┬──────────┬──┘
           │          │          │
     ┌─────▼──┐ ┌────▼─────┐ ┌──▼───────────┐
     │  Auth  │ │   User   │ │ Chat History │
     │Service │ │ Service  │ │ (NestJS)     │
     │(Spring)│ │(Spring)  │ │              │
     └────┬───┘ └────┬─────┘ └──┬───────────┘
          │         │          │
     ┌────▼─────────▼──────────▼────┐
     │ PostgreSQL • MongoDB • Redis  │
     │ Kafka • ZooKeeper             │
     └───────────────────────────────┘
```

### 📦 Stack Technique

| Couche       | Technologies                                       |
| ------------ | -------------------------------------------------- |
| **Frontend** | SvelteKit 2.9 • Svelte 5 • TailwindCSS 4 • Tauri 2 |
| **Gateway**  | Rust 1.87 (Axum) • Tokio • Tonic • Rdkafka         |
| **Services** | NestJS • Spring Boot • Node.js 20                  |
| **Data**     | PostgreSQL • MongoDB • Redis • Kafka               |
| **DevOps**   | Docker • Docker Compose • GitHub Actions • Nginx   |
| **Quality**  | ESLint • Prettier • Clippy • Husky • Pre-commit    |

---

## 🚀 Installation Rapide

### Prérequis

- **Docker** + **Docker Compose**
- **Make** (GNU Make)
- **Python** 3.9+ _(optionnel, pour pre-commit hooks avancés)_

**Auto-installé par `make` sur Linux/macOS :**
- Node.js 20+ LTS + npm (via nvm)
- Bun (gestionnaire de paquets rapide)
- Rust stable + cargo (via rustup)
- wasm-pack (build WASM)

Vérifier les dépendances :

```bash
node --version
npm --version
rustc --version
docker --version
docker compose version
make --version
```

### Démarrage local (dev, sans HTTPS)

1. **Cloner le dépôt**

```bash
git clone https://github.com/emse-students/canari.git
cd canari
```

2. **Configurer les variables d'environnement**

```bash
# Linux/macOS
chmod +x scripts/setup-env.sh
./scripts/setup-env.sh

**⚠️ Prérequis** : Les images Docker doivent être disponibles sur GHCR

**Option 1 : Via workflow CD (recommandé)**

Push sur `main` déclenche automatiquement :
- Build des images Docker
- Push sur `ghcr.io/emse-students/canari/*`
- Déploiement sur le serveur (si configuré via GitHub Actions)

**Option 2 : Déploiement manuel**

```bash
# 1) Configurer les secrets
./scripts/setup-env.sh --prod --sync-only

# 2) Pull des images depuis GHCR (buildées par CD)
docker compose -f infrastructure/docker-compose.prod.yml pull

# 3) Démarrer les services
docker compose -f infrastructure/docker-compose.prod.yml up -d
```

**Option 3 : Build local (dev/test)**

```bash
# Build local des images (sans GHCR)
docker compose -f infrastructure/local/docker-compose.yml up -d --build
```
4. **Lancer le frontend en mode dev (optionnel)**

```bash
cd frontend
bun run dev || npm run dev
```

L'application sera accessible sur **http://localhost:5173** 🎉

### Infrastructure locale

Les services Docker se lancent automatiquement avec `make`, ou manuellement depuis la racine :

```bash
docker compose -f infrastructure/local/docker-compose.yml up -d --build
```

Services disponibles :

- **Frontend** : http://localhost:5173
- **Chat Gateway** : ws://localhost:8000
- **PostgreSQL** : localhost:5432
- **MongoDB** : localhost:27017
- **Redis** : localhost:6379
- **Kafka** : localhost:9092

### Déploiement production (Linux)
**⚠️ Prérequis** : Les images Docker doivent être disponibles sur GHCR
 
**Option 1 : Via workflow CD (recommandé)**
 

```bash
Push sur main déclenche automatiquement :
- Build des images Docker
- Push sur ghcr.io/emse-students/canari/*
- Déploiement sur le serveur (si configuré)
 
**Option 2 : Déploiement manuel**
 
1) Configurer les secrets
./scripts/setup-env.sh --prod --sync-only

2) Pull des images depuis GHCR (buildées par CD)
3) Démarrer les services
docker compose -f infrastructure/docker-compose.prod.yml up -d --build
 
**Option 3 : Build local (dev/test)**
 
Build local des images (sans GHCR)
```

---

## 🔧 Développement

### Scripts Principaux

```bash
# Installation
make install           # Installer toutes les dépendances
make install-hooks    # Configurer les Git hooks Husky

# Build
make build-frontend   # Compiler le frontend (WASM + Svelte)
make nginx-install    # Configurer Nginx (production)

# Tests
make test             # Lancer tous les tests
make test-libs        # Tests Rust libs
make test-gateway     # Tests Chat Gateway
make test-history     # Tests History Service (NestJS)

# Nettoyage
make clean            # Supprimer les build artifacts
```

### Frontend (SvelteKit)

```bash
cd frontend

# Développement avec HMR
bun run dev

# Vérifications
bun run check         # TypeScript + Svelte
bun run check:watch   # Avec watch mode

# Linting & Formatage
bun run lint          # Vérifier avec ESLint
bun run lint:fix      # Auto-corriger les erreurs
bun run format        # Formatter avec Prettier
bun run format:check  # Vérifier le formatage

# Production
bun run build         # Compilation
bun run preview       # Prévisualisation
```

### Rust Gateway & Libs

```bash
# Format check
cargo fmt -- --check
cargo fmt             # Auto-fix

# Linting
cargo clippy --all-features -- -D warnings

# Tests
cargo test

# Build release
cargo build --release
```

### Services NestJS

```bash
cd apps/chat-delivery-service

npm install
npm run lint
npm test
npm run build  # Compilation TypeScript
npm start      # Lancer le service
```

---

## 📋 Vérifications de Qualité

### 🪝 Pre-commit Hooks (Husky)

Les vérifications s'exécutent **automatiquement avant chaque commit** :

```bash
# Installation automatique avec `make install`
# Pour passer les hooks :
git commit --no-verify
```

Vérifications incluses :

- ✅ ESLint (TypeScript/JavaScript)
- ✅ Prettier (Formatage)
- ✅ Trailing whitespace
- ✅ YAML/JSON validation
- ✅ Détection de clés privées

### 🧪 Pre-commit Framework

Pour des vérifications locales complètes avant le push :

```bash
# Installation (une seule fois)
pip install pre-commit
pre-commit install

# Exécution manuelle
pre-commit run --all-files
```

Vérifications :

- ✅ Trailing whitespace
- ✅ YAML/JSON/Markdown validation
- ✅ Détection clés privées
- ✅ Markdown linting
- ✅ Cargo fmt (Rust)
- ✅ ESLint (TypeScript/JavaScript)

### 🔍 Code Analysis Workflow

Workflow GitHub qui s'exécute à chaque push et quotidiennement à 2h UTC :

- 🔍 **CodeQL** - Vulnérabilités JavaScript/TypeScript
- 🔐 **TruffleHog** - Scannage des secrets
- 🧹 **ESLint** - Linting TypeScript/JavaScript
- 📦 **Audit dépendances** - npm audit + cargo audit
- 🦀 **Rust Analysis** - Clippy + cargo fmt

### 🤖 Dependabot

Mise à jour automatique des dépendances (exécution hebdomadaire) :

- **GitHub Actions** : Hebdomadaire
- **npm packages** : Hebdomadaire avec grouping intelligent
- **Cargo crates** : Hebdomadaire

Toutes les PR de Dependabot sont testées automatiquement via CI/CD

---

## 🚀 Déploiement

### Déploiement Automatique (CI/CD)

Chaque `push` sur `main` déclenche automatiquement :

1. **CI Pipeline** ✅
   - `cargo fmt --check` (Rust)
   - `cargo clippy` (Rust linting)
   - `cargo test` (Rust tests)
   - `npm run lint` (TypeScript linting)
   - Tests complets

2. **Frontend Build** 🏗️
   - Build WASM (mls-core, mls-wasm)
   - Build SvelteKit
   - Production artifacts

3. **Docker Build** 🐳
   - Construction 3 images Docker :
     - `chat-gateway` (Rust)
     - `chat-delivery-service` (NestJS)
     - `frontend` (Nginx + SvelteKit)
   - Push sur **GitHub Container Registry**

4. **SSH Deployment** 🚀 _(optionnel)_
   - SSH vers serveur production
   - Pull des images
   - Redémarrage services Docker Compose
   - Health checks post-déploiement

### Déploiement Manuel

```bash
# Déploiement local (simulation)
./scripts/deploy.sh local

# Production (requiert secrets GitHub)
./scripts/deploy.sh production
```

### Configuration du Déploiement

📖 **Guide complet avec instructions visuelles** : [GITHUB_SECRETS_SETUP.md](docs/GITHUB_SECRETS_SETUP.md)

1. **GitHub Secrets** (Settings → Secrets → Actions)

```
SSH_PRIVATE_KEY=<votre clé ED25519>
SSH_USER=<utilisateur déploiement>
SERVER_HOST=<IP/hostname>
DEPLOY_PATH=<chemin projet>
```

2. **GitHub Variables** (Settings → Variables)

```
DOMAIN=<votre-domaine.com>
```

3. **Préparation du serveur**

```bash
# Sur le serveur
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/canari
sudo chown deploy:deploy /opt/canari

# Configurer SSH
ssh-copy-id -i ~/.ssh/github_deploy.pub deploy@<SERVER_HOST>
```

---

## 📁 Structure du Projet

```
canari/
├── frontend/                      # SvelteKit + Tauri
│   ├── src/
│   │   ├── routes/               # Pages SvelteKit
│   │   ├── lib/
│   │   │   ├── components/       # Composants réutilisables
│   │   │   ├── encryption.ts     # Service MLS
│   │   │   └── db.ts             # BD locale
│   │   └── app.html
│   ├── mls-core/                 # Core MLS (Rust)
│   ├── mls-wasm/                 # WASM bindings
│   ├── src-tauri/                # Config Tauri
│   └── build/                    # Build output
│
├── apps/
│   ├── chat-gateway/             # Gateway WebSocket (Rust - Axum)
│   ├── auth-service/             # Auth Service (Spring Boot)
│   ├── user-service/             # User Service (Spring Boot)
│   └── chat-delivery-service/    # History Service (NestJS)
│
├── libs/
│   ├── shared-rust/              # Shared Rust utilities
│   └── shared-ts/                # Shared TypeScript utilities
│
├── infrastructure/
│   ├── local/                    # Docker Compose local dev
│   │   ├── docker-compose.yml
│   │   ├── Dockerfile.frontend
│   │   ├── Dockerfile.chat-gateway
│   │   └── Dockerfile.chat-delivery-service
│   ├── docker-compose.prod.yml   # Production config
│   ├── nginx/                    # Config Nginx
│   └── .env.example              # Template variables
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                # Tests & Linting
│   │   ├── cd.yml                # Build & Deployment
│   │   └── code-analysis.yml     # Security & Quality
│   └── dependabot.yml            # Auto-updates
│
├── scripts/
│   ├── deploy.sh                 # Manual deployment
│   ├── windows/                  # Windows scripts
│   └── linux/                    # Linux scripts
│
├── docs/
│   ├── ARCHITECTURE.md           # Architecture decisions
│   ├── DEVELOPMENT.md            # Development guide
│   ├── CHIFFREMENT.md            # Encryption details
│   ├── MULTI_DEVICE.md           # Multi-device sync
│   └── CI_CD.md                  # CI/CD docs
│
├── Makefile                      # Build automation
├── .prettierrc                   # Prettier config
├── .eslintrc                     # ESLint config
├── .editorconfig                 # Editor config
├── .pre-commit-config.yaml       # Pre-commit hooks
├── .gitignore                    # Git ignore
└── README.md                     # This file
```

---

## 📚 Documentation Complète

- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - Décisions architecturales et patterns
- **[DEVELOPMENT.md](docs/DEVELOPMENT.md)** - Guide de développement détaillé
- **[CHIFFREMENT.md](docs/CHIFFREMENT.md)** - Protocole MLS et chiffrement E2E
- **[MULTI_DEVICE.md](docs/MULTI_DEVICE.md)** - Synchronisation multi-device
- **[CI_CD.md](docs/CI_CD.md)** - Configuration CI/CD et déploiement
- **[GITHUB_SECRETS_SETUP.md](docs/GITHUB_SECRETS_SETUP.md)** - Guide complet des secrets GitHub

---

## 🤝 Contribution

Les contributions sont bienvenues ! Avant de commencer :

1. **Fork** le dépôt
2. **Créez une branche** (`git checkout -b feature/ma-feature`)
3. **Committez** vos changements (`git commit -m 'feat: description'`)
4. **Poussez** la branche (`git push origin feature/ma-feature`)
5. **Ouvrez une Pull Request**

### Conventions

- **Commits** : Utiliser les conventional commits (`feat:`, `fix:`, `docs:`, etc.)
- **Code** : Assurez-vous que `bun run lint:fix` passe avant de commiter
- **Tests** : Ajoutez des tests pour les nouvelles fonctionnalités
- **Documentation** : Mettez à jour les docs pertinentes

---

## 📄 Licence

Ce projet est licencié sous la [MIT License](LICENSE).

---

## 🙋 Support & Contact

Avez-vous des questions ? Besoin d'aide ?

- 📖 Consultez la [documentation](docs/)
- 🐛 Signalez un bug via [GitHub Issues](https://github.com/emse-students/canari/issues)
- 💬 Posez des questions via [GitHub Discussions](https://github.com/emse-students/canari/discussions)
- 📧 Contactez l'équipe de développement

---

## 🙏 Remerciements

- **[SvelteKit](https://kit.svelte.dev/)** - Framework frontend moderne
- **[Tauri](https://tauri.app/)** - Framework desktop léger
- **[Rust](https://www.rust-lang.org/)** - Langage système sécurisé
- **[MLS Protocol](https://messaginglayersecurity.rocks/)** - Standard de sécurité
- **EMSE** - École supportant ce projet

---

**Fait avec ❤️ par les étudiants de l'EMSE**

_Dernière mise à jour : Mars 2026_
