# Canari - Messagerie Sécurisée E2E

[![CI](https://github.com/emse-students/canari/actions/workflows/ci.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/ci.yml)
[![CD](https://github.com/emse-students/canari/actions/workflows/cd.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/cd.yml)
[![Code Analysis](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml/badge.svg)](https://github.com/emse-students/canari/actions/workflows/code-analysis.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Application de messagerie sécurisée avec chiffrement de bout en bout (protocole MLS) et architecture microservices moderne.

## Architecture

Le projet est composé de :

- **Frontend** : SvelteKit + Tauri (Desktop/Web)
- **Backend Gateway** : Rust (Axum)
- **Services** :
  - Auth (Spring Boot Java)
  - User (Spring Boot Java)
  - Chat History (NestJS)
- **Infrastructure** : Kafka, Redis, Postgres, MongoDB (Docker Compose)

## Pré-requis Installés

L'environnement de développement a été configuré avec :

- Java 21
- Node.js 24
- Rust & Cargo
- Make
- Docker Desktop
- Bun 1.3.6 (package manager)

## Vérifications Automatisées

Le projet utilise plusieurs outils pour garantir la qualité du code :

### Husky + Pre-commit Hooks

Les Git hooks sont configurés pour vérifier la qualité du code avant chaque commit :

```bash
# Installation automatique (copie du prepare script dans package.json)
bun install

# Pour passer les hooks (déconseillé) :
git commit --no-verify
```

### Pre-commit Framework

Pour une vérification complète locale avant le push :

```bash
# Installation (si pre-commit n'est pas installé)
pip install pre-commit

# Installation des hooks
pre-commit install

# Lancer manuellement
pre-commit run --all-files
```

### Linting et Formatage

```bash
# Frontend
cd frontend
bun run lint          # Vérifier avec ESLint
bun run lint:fix      # Auto-corriger ESLint
bun run format        # Formatter avec Prettier
bun run format:check  # Vérifier le formatage

# Services (npm)
cd apps/chat-delivery-service
npm run lint          # Vérifier avec ESLint

# Rust
cargo fmt -- --check  # Vérifier le formatage
cargo clippy          # Linter Rust
```

### Dependabot

Le projet est configuré avec Dependabot pour maintenir les dépendances à jour :

- **GitHub Actions** : Mise à jour hebdomadaire le lundi
- **npm (Frontend & Services)** : Mise à jour hebdomadaire avec grouping des dépendances
- **Cargo (Rust)** : Mise à jour hebdomadaire

Les pull requests de Dependabot sont automatiquement testées via CI/CD.

## Démarrage Rapide

### Développement Local

1. **Installer les dépendances** :

   ```bash
   make install
   ```

2. **Lancer l'infrastructure** :

   ```bash
   cd infrastructure/local
   docker compose up -d
   ```

3. **Lancer le frontend** :
   ```bash
   cd frontend && bun run dev
   ```

### Déploiement

#### Déploiement automatique (CI/CD)

Chaque push sur `main` déclenche automatiquement :

- ✅ Tests CI
- 🏗️ Build du frontend et des services
- 🐳 Push des images Docker
- 🚀 Déploiement sur le serveur de production

#### Déploiement manuel

```bash
# Déploiement local
./scripts/deploy.sh local

# Déploiement production (nécessite configuration)
./scripts/deploy.sh production
```

📖 **Documentation complète** : [docs/CI_CD.md](docs/CI_CD.md)

## Commandes Utiles

- `make` ou `make all` : Installation et déploiement complets
- `make install` : Installer toutes les dépendances
- `make test` : Lancer tous les tests du projet
- `make build-frontend` : Builder le frontend (WASM + Svelte)
- `make nginx-install` : Configurer Nginx
- `make reload-services` : Redémarrer les services Docker
- `make build` : Compile tous les composants.
