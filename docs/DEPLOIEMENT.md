# Déploiement et Infrastructure

## 1. Topologie de production

```
Internet (HTTPS)
  └── Cloudflare (TLS + WAF + DDoS)
        └── Cloudflare Tunnel → http://localhost:8080
              └── Nginx:80 (conteneur frontend, port host 8080→80)
                    ├── auth_request → core-service:3012/api/auth/verify
                    ├── /api/ws         → chat-gateway:3000
                    ├── /api/mls/*  → chat-delivery-service:3010
                    ├── /api/media/*    → media-service:3011
                    ├── /api/auth/*     → core-service:3012
                    ├── /api/channels/* → social-service:3014
                    └── /*              → build SvelteKit statique
```

Tous les services backend (`chat-gateway`, `chat-delivery-service`, `media-service`, `core-service`, `social-service`) sont exposés uniquement via `expose:` dans le docker-compose de prod - ils ne sont **pas** accessibles directement depuis l'hôte, uniquement depuis le réseau Docker interne.

---

## 2. Docker Compose

### Fichiers

| Fichier                                   | Usage                      |
| ----------------------------------------- | -------------------------- |
| `infrastructure/local/docker-compose.yml` | Développement local        |
| `infrastructure/docker-compose.dev.yml`   | Dev avec services distants |
| `infrastructure/docker-compose.prod.yml`  | Production                 |

### Services en production

```yaml
services:
  frontend:
    image: ghcr.io/emse-students/canari/frontend:latest
    ports: ['8080:80'] # Seul port exposé vers l'hôte

  chat-gateway:
    image: ghcr.io/emse-students/canari/chat-gateway:latest
    expose: ['3000'] # Interne uniquement

  chat-delivery-service:
    image: ghcr.io/emse-students/canari/chat-delivery-service:latest
    expose: ['3010']

  media-service:
    image: ghcr.io/emse-students/canari/media-service:latest
    expose: ['3011']

  core-service:
    image: ghcr.io/emse-students/canari/core-service:latest
    expose: ['3012']

  social-service:
    image: ghcr.io/emse-students/canari/social-service:latest
    expose: ['3014']

  redis:
    image: redis:7-alpine
    expose: ['6379']

  postgres:
    image: postgres:15
    expose: ['5432']
    environment:
      POSTGRES_DB: auth_db
      POSTGRES_USER: canari
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}

  mongo:
    image: mongo:7
    expose: ['27017']

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    expose: ['29092']

  minio:
    image: minio/minio
    ports:
      - '${MINIO_API_HOST_PORT:-19000}:9000'
      - '${MINIO_CONSOLE_HOST_PORT:-19001}:9001'
```

---

## 3. Variables d'environnement

Toutes les variables sont dans `infrastructure/.env` (jamais committé).

### Variables obligatoires

| Variable            | Description                     | Exemple                  |
| ------------------- | ------------------------------- | ------------------------ |
| `JWT_SECRET`        | Secret JWT HS256 (64 chars hex) | `openssl rand -hex 32`   |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL         |                          |
| `DOMAIN`            | Domaine principal               | `canari-emse.fr`         |
| `ALLOW_ORIGIN`      | CORS origin                     | `https://canari-emse.fr` |

### Variables optionnelles

| Variable                  | Défaut       | Description                           |
| ------------------------- | ------------ | ------------------------------------- |
| `FRONTEND_HOST_PORT`      | `80`         | Port host pour Nginx frontend         |
| `MINIO_API_HOST_PORT`     | `19000`      | Port host API MinIO                   |
| `MINIO_CONSOLE_HOST_PORT` | `19001`      | Port host console MinIO               |
| `MINIO_ROOT_USER`         | `minioadmin` | Accès MinIO                           |
| `MINIO_ROOT_PASSWORD`     | -            | Accès MinIO                           |
| `AUTHENTIK_URL`           | -            | URL Authentik OIDC                    |
| `AUTHENTIK_CLIENT_ID`     | -            | Client ID OIDC                        |
| `AUTHENTIK_CLIENT_SECRET` | -            | Secret OIDC (côté serveur uniquement) |
| `STRIPE_SECRET_KEY`       | -            | Clé secrète Stripe                    |
| `STRIPE_WEBHOOK_SECRET`   | -            | Secret webhook Stripe                 |
| `FCM_PROJECT_ID`          | -            | Firebase (push notifs Android)        |
| `FCM_PRIVATE_KEY`         | -            | Firebase credentials                  |
| `APNS_KEY_ID`             | -            | APNs (push notifs iOS)                |
| `ENABLE_DEV_ROUTES`       | `false`      | Active /api/auth/dev-login            |
| `MEDIA_MAX_SIZE_MB`       | `100`        | Taille max upload médias              |

---

## 4. Premier déploiement (pas à pas)

### Prérequis serveur

- Linux (Ubuntu 22.04+ recommandé)
- Docker Engine 24+ + Docker Compose V2
- Git
- Runner GitHub Actions self-hosted configuré

### Étapes

**1. Cloner le dépôt**

```bash
git clone https://github.com/emse-students/canari.git ~/canari
cd ~/canari
```

**2. Générer les secrets**

```bash
./scripts/setup-env.sh --prod
# Crée infrastructure/.env avec JWT_SECRET aléatoire
nano infrastructure/.env
# Remplir : POSTGRES_PASSWORD, DOMAIN, ALLOW_ORIGIN, Authentik, Stripe, Firebase...
```

**3. Configurer le secret GitHub**

GitHub → Settings → Secrets and variables → Actions → New repository secret :

```
JWT_SECRET = <même valeur que dans infrastructure/.env>
STRIPE_WEBHOOK_SECRET = <signing secret whsec_… du webhook Stripe>
```

Le workflow CD synchronise aussi `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` dans `infrastructure/.env` à chaque déploiement.

Ce secret est injecté dans le bundle JS à chaque build CI (variable `PUBLIC_JWT_SECRET`).

**4. Configurer Cloudflare Tunnel**

Dans le dashboard Cloudflare :

- Créer un tunnel pointant vers `http://localhost:8080`
- Assigner le domaine `canari-emse.fr` au tunnel
- Installer cloudflared sur le serveur :
  ```bash
  cloudflared service install <TOKEN>
  ```

**5. Premier démarrage**

```bash
make production
# Pull les images depuis ghcr.io/emse-students/canari/*
# Démarre tous les services avec docker compose up -d
```

**6. Initialiser MinIO**

```bash
# Créer le bucket canari-media
docker exec -it $(docker ps -q -f name=minio) sh
mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
mc mb local/canari-media
mc policy set private local/canari-media
```

---

## 5. CI/CD (GitHub Actions)

### Workflows

| Fichier                               | Déclencheur           | Actions                      |
| ------------------------------------- | --------------------- | ---------------------------- |
| `.github/workflows/ci.yml`            | Push, PR sur main     | Lint + tests                 |
| `.github/workflows/cd.yml`            | Push sur main         | Build + déploiement          |
| `.github/workflows/code-analysis.yml` | Push + cron quotidien | Sécurité + audit dépendances |

### Pipeline CD détaillé

```yaml
jobs:
  build-frontend:
    steps:
      - name: Install wasm-pack
      - name: Build mls-core WASM
        run: cd frontend/mls-wasm && wasm-pack build --target web
      - name: Build SvelteKit
        run: cd frontend && bun run build
        env:
          PUBLIC_JWT_SECRET: ${{ secrets.JWT_SECRET }}
          VITE_GATEWAY_URL: https://canari-emse.fr
          # ... autres VITE_* variables

  build-docker:
    needs: build-frontend
    steps:
      - name: Build and push images
        uses: docker/build-push-action
        with:
          context: .
          file: infrastructure/local/Dockerfile.frontend
          tags: ghcr.io/emse-students/canari/frontend:latest
      # Répété pour chaque service

  deploy:
    needs: build-docker
    runs-on: self-hosted # Runner sur le serveur de prod
    steps:
      - name: Pull and restart
        run: |
          cd ~/canari
          git pull
          docker compose -f infrastructure/docker-compose.prod.yml pull
          docker compose -f infrastructure/docker-compose.prod.yml up -d
```

### Analyse de sécurité (code-analysis.yml)

- **CodeQL** : détection de vulnérabilités JS/TS
- **TruffleHog** : scan de secrets dans les commits
- **npm audit** : vulnérabilités de dépendances Node.js
- **cargo audit** : vulnérabilités de crates Rust
- **cargo clippy** : linting Rust
- **ESLint** : linting TypeScript

---

## 6. Développement local

### Stack locale complète

```bash
make run-services
# Lance via infrastructure/local/docker-compose.yml :
# postgres, mongo, redis, kafka, zookeeper, minio, coturn
# + chat-gateway, chat-delivery-service, media-service, core-service, social-service
```

Le frontend tourne séparément (Vite HMR) :

```bash
cd frontend && bun run dev
# → http://localhost:1420
```

### Makefiles targets

```makefile
install           # npm install + cargo build + husky hooks
install-hooks     # Husky hooks uniquement
build-frontend    # WASM + SvelteKit build
run-services      # Docker Compose local up
reload-services   # Docker Compose restart
stop-services     # Docker Compose down
test              # Tous les tests
test-gateway      # Tests Rust chat-gateway
test-libs         # Tests Rust libs partagées
test-history      # Tests NestJS chat-delivery-service
production        # Pull images GHCR + up (sur le serveur de prod)
```

---

## 7. Mise à jour en production

Les déploiements suivants sont entièrement automatisés :

```
git push origin main
  → GitHub Actions CI (lint, tests)
  → Build WASM + SvelteKit + Docker images
  → Push images vers GHCR
  → Runner self-hosted : git pull + docker compose pull + up -d
```

Pour un déploiement manuel d'urgence :

```bash
# Sur le serveur
cd ~/canari
git pull
docker compose -f infrastructure/docker-compose.prod.yml pull
docker compose -f infrastructure/docker-compose.prod.yml up -d --force-recreate
```

---

## 8. Monitoring et logs

```bash
# Logs d'un service
docker compose -f infrastructure/docker-compose.prod.yml logs -f chat-gateway

# État des conteneurs
docker compose -f infrastructure/docker-compose.prod.yml ps

# Ressources
docker stats
```

Les niveaux de log sont configurables via `RUST_LOG` (chat-gateway) et les variables d'environnement NestJS standard.

---

## 9. Liens mobiles (`canari-emse.fr` → app Android / iOS)

L'app native déclare des **App Links** (Android) et **Universal Links** (iOS) pour `https://canari-emse.fr` et `https://www.canari-emse.fr`. Le site sert les fichiers de vérification au build frontend :

| URL                                       | Rôle                                                    |
| ----------------------------------------- | ------------------------------------------------------- |
| `/.well-known/assetlinks.json`            | Android (empreintes SHA-256 du certificat de signature) |
| `/.well-known/apple-app-site-association` | iOS (Team ID Apple + bundle `fr.emse.canari`)           |

### Secrets GitHub (build frontend)

| Secret                    | Usage                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANDROID_APP_LINK_SHA256` | Empreinte(s) SHA-256 du keystore release (séparées par des virgules). Obtenir avec `./scripts/print-android-app-link-fingerprint.sh` après avoir préparé `release.jks`. |
| `APPLE_TEAM_ID`           | Identifiant d'équipe Apple (10 caractères), ex. `ABCDE12345`. Requis pour un AASA iOS valide.                                                                           |

Ces valeurs sont injectées dans le job `build-frontend` (`VITE_ANDROID_APP_LINK_SHA256`, `VITE_APPLE_TEAM_ID`) puis figées dans les JSON statiques du build nginx.

### Vérification après déploiement

```bash
curl -sS https://canari-emse.fr/.well-known/assetlinks.json | head
curl -sS https://canari-emse.fr/.well-known/apple-app-site-association | head
```

Les deux réponses doivent être du **JSON** (pas la page HTML SPA).

### Android

```bash
./scripts/print-android-app-link-fingerprint.sh
# Copier la sortie dans le secret ANDROID_APP_LINK_SHA256, rebuild + deploy frontend
```

Test sur appareil / émulateur :

```bash
adb shell am start -a android.intent.action.VIEW -d "https://canari-emse.fr/posts/<id>" fr.emse.canari
```

### iOS

Sur macOS, le build release doit inclure l'entitlement _Associated Domains_ (`applinks:canari-emse.fr`) - régénéré par le plugin Tauri `deep-link` avec `"appLink": true` dans `tauri.conf.json`. Après ajout de `APPLE_TEAM_ID`, reconstruire l'IPA et réinstaller l'app.
