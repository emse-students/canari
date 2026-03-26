# Guide de Développement - Mines App

## Pré-requis

Pour développer sur ce projet, vous avez besoin des outils suivants installés et disponibles dans votre PATH :

1.  **Node.js LTS (v20+)** (Installé: Vérifié)
2.  **Rust & Cargo** (Requis pour Gateway et WASM)
    - Installateur: https://rustup.rs/
    - Ou via Winget: `winget install Rustlang.Rustup` puis exécuter `rustup-init`
3.  **Make** (Optionnel mais recommandé pour utiliser le Makefile)
    - Via Winget: `winget install ezwinports.make`
    - Ou Chocolatey: `choco install make`
4.  **Docker & Docker Compose** (Requis pour l'infrastructure)

## Installation Automatisée

Un script PowerShell `setup_environment.ps1` est fourni à la racine pour installer les dépendances Node.js et vérifier votre environnement.

```powershell
./setup_environment.ps1
```

## Structure du Projet

- **Backend Core (NestJS)**: `apps/core-service` (remplace Auth, User)
  - Lancer: `npm run start:dev`
- **Backend Social (NestJS)**: `apps/social-service` (remplace Post, Channel, Forms)
  - Lancer: `npm run start:dev`
- **Backend Delivery (NestJS)**: `apps/chat-delivery-service`
  - Lancer: `npm run start:dev`
- **Backend Media (NestJS)**: `apps/media-service`
  - Lancer: `npm run start:dev`
- **Frontend (SvelteKit)**: `frontend/`
  - Lancer: `npm run dev`

## Infrastructure Locale

Utiliser le Makefile pour démarrer les services de base (Kafka, DBs) :

```bash
make infra-up
```

Ou Docker Compose directement :

```bash
docker compose -f infrastructure/local/docker-compose.yml up -d
```

Les services sont accessibles via Nginx (port 80) ou directement (nouveaux ports) :

### Services Temps-Réel (Rust)

- **Chat Gateway**: `ws://localhost:3000` (Port Interne: 3000)

### Services Backend (NestJS - Ports 3010+)

- **Delivery Service**: `http://localhost:3010` (Port Interne: 3010)
- **Media Service**: `http://localhost:3011` (Port Interne: 3011)
- **Core Service**: `http://localhost:3012` (Port Interne: 3012)
- **Social Service**: `http://localhost:3014` (Port Interne: 3014)

### Frontend

- **Frontend**: http://localhost:5173 (dev) ou http://localhost (prod/docker)

- **Backend Chat Gateway (Rust)**: `apps/chat-gateway`
  - Lancer: `cargo run`
- **Backend Call Service (Rust)**: archivé dans `apps/_archived/call-service` (non utilisé actuellement)
- **Frontend (SvelteKit + Tauri)**: `frontend/`
  - Dépend de `libs/shared-ts` et `mls-wasm` (Rust)
  - Lancer Web: `npm run dev`
  - Lancer Desktop: `npm run tauri dev`
- **Infrastructure**: `infrastructure/local/`
  - Lancer: `docker compose up -d`

## Initialisation Manuelle

Si vous ne souhaitez pas utiliser le script, respectez cet ordre :

1.  **Démarrer l'infrastructure** :
    ```bash
    cd infrastructure/local
    docker compose up -d
    ```
2.  **Compiler la librairie partagée TypeScript** :
    ```bash
    cd libs/shared-ts
    npm install
    npm run build
    ```
3.  **Installer les dépendances Frontend & Delivery** :
    ```bash
    cd apps/chat-delivery-service && npm install
    cd frontend && npm install
    ```
4.  **Compiler le module WASM (si nécessaire)** :
    L'installation via npm dans `frontend` devrait gérer `mls-wasm` via des scripts ou plugins, sinon :
    ```bash
    cd frontend/mls-wasm
    wasm-pack build --target web
    ```

## Commandes Utiles

- `make test` : Lance tous les tests (Rust, TS).
