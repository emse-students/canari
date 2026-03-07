# Guide de Développement - Mines App

## Pré-requis

Pour développer sur ce projet, vous avez besoin des outils suivants installés et disponibles dans votre PATH :

1.  **Java JDK 21+** (Installé: Vérifié)
2.  **Node.js LTS (v20+)** (Installé: Vérifié)
3.  **Rust & Cargo** (Requis pour Gateway et WASM)
    - Installateur: https://rustup.rs/
    - Ou via Winget: `winget install Rustlang.Rustup` puis exécuter `rustup-init`
4.  **Make** (Optionnel mais recommandé pour utiliser le Makefile)
    - Via Winget: `winget install ezwinports.make`
    - Ou Chocolatey: `choco install make`
5.  **Docker & Docker Compose** (Requis pour l'infrastructure)

## Installation Automatisée

Un script PowerShell `setup_environment.ps1` est fourni à la racine pour installer les dépendances Node.js et vérifier votre environnement.

```powershell
./setup_environment.ps1
```

## Structure du Projet

- **Backend Auth (Java)**: `apps/auth-service`
  - Lancer: `./gradlew bootRun`
- **Backend User (Java)**: `apps/user-service`
  - Lancer: `./gradlew bootRun`
- **Backend Chat Delivery (NestJS)**: `apps/chat-delivery-service`
  - Dépend de `libs/shared-ts`
  - Lancer: `npm run start:dev`
- **Backend Chat Gateway (Rust)**: `apps/chat-gateway`
  - Lancer: `cargo run`
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
