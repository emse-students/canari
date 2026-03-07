# Canari - Messagerie Sécurisée E2E

[![CI](https://github.com/YOUR-ORG/canari/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-ORG/canari/actions/workflows/ci.yml)
[![CD](https://github.com/YOUR-ORG/canari/actions/workflows/cd.yml/badge.svg)](https://github.com/YOUR-ORG/canari/actions/workflows/cd.yml)
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
