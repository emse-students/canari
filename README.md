# Mines App

Application de messagerie sécurisée (MLS) avec une architecture microservices.

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

1.  **Redémarrer votre terminal** (Important pour `cargo` et `make`).

2.  **Lancer l'infrastructure** :

    ```bash
    cd infrastructure/local
    docker compose up -d
    ```

3.  **Lancer les services** (dans des terminaux séparés) :
    - **Auth Service** : `cd apps/auth-service && ./gradlew bootRun`
    - **User Service** : `cd apps/user-service && ./gradlew bootRun`
    - **Chat History** : `cd apps/chat-history-service && npm run start:dev`
    - **Gateway** : `cd apps/chat-gateway && cargo run`

4.  **Lancer le Frontend** :
    - Web : `cd frontend && npm run dev`
    - Desktop : `cd frontend && npm run tauri dev`

## Commandes Utiles

- `make test` : Lance tous les tests du projet.
- `make build` : Compile tous les composants.
