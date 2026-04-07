# Configuration de la Branche Dev

## ✅ Complété

### 1. **Branche `dev` créée et commités localement**

- Branche `dev` créée : `git branch dev`
- Pull depuis `main` : les changements récents sont fusionnés

### 2. **Docker Compose pour Dev**

- Fichier `infrastructure/docker-compose.dev.yml` créé
- **Ports décalés** pour éviter les conflits avec la production:
  - PostgreSQL: `5433` (production: `5432`)
  - Redis: `6380` (production: `6379`)
  - MongoDB: `27018` (production: `27017`)
  - Kafka: `9093` (production: `9092`)
  - MinIO API: `19100` (production: `19000`)
  - MinIO Console: `19101` (production: `19001`)
  - Chat Gateway: `3100` (production: `3000`)
  - Chat Delivery: `3110` (production: `3010`)
  - Media Service: `3111` (production: `3011`)
  - Core Service: `3112` (production: `3012`)
  - Social Service: `3114` (production: `3014`)
  - Frontend: `3080` (production: `80`)
- Tous les services utilisent le tag d'image `dev` par défaut

### 3. **CI/CD modifié**

- **`.github/workflows/ci.yml`** : ajout de `dev` dans les branches acceptées pour les PRs
- **`.github/workflows/cd-dev.yml`** : nouveau workflow de déploiement pour dev
  - Déclenche automatiquement sur push vers `dev`
  - Tag des images Docker: `dev`
  - Déploiement sur path: `/home/canari/canari-dev`
  - Domaine: `dev.canari-emse.fr` (configurable)
  - Déploiement indépendant de la production

### 4. **Commits locaux**

```
- 0b117f7: chore(infra): ajouter docker-compose.dev.yml avec ports décalés
- 5ea5234: ci/cd: ajouter workflow CD dev et support CI dev
```

## ⚠️ À Faire: Push vers GitHub

### Problème rencontré

Le hook pré-push de Husky ne peut pas s'exécuter sous PowerShell natif (il utilise `#!/bin/sh`).

### Solutions

#### Option 1: Utiliser Git Bash (Recommandé si disponible)

```bash
# Ouvrir Git Bash et naviguer vers le projet
cd /d/Documents/Programmation/EMSE/Canari
git push -u origin dev
```

#### Option 2: Utiliser WSL2 (Si instalé)

```bash
wsl
cd /mnt/d/Documents/Programmation/EMSE/Canari
git push -u origin dev
```

#### Option 3: Désactiver temporairement les hooks (Non recommandé, mais possible)

```powershell
# ⚠️  ATTENTION : Cela viole la règle de validation
# À utiliser UNIQUEMENT si les autres options ne fonctionnent pas

# Désactiver husky temporairement
cd d:\Documents\Programmation\EMSE\Canari
git config core.hooksPath ""

# Faire le push
git push -u origin dev

# Réactiver husky
git config core.hooksPath .husky/_
```

#### Option 4: Corriger la configuration Git (Solution permanente)

```powershell
# Configurer Git pour utiliser Git Bash automatiquement
git config core.sharen on
git config core.autocrlf true

# Ou en configuration globale:
git config --global core.sharen on

# Puis relancer PowerShell et réessayer le push
git push -u origin dev
```

## 🚀 Après le Push

Une fois que vous avez pushé vers `dev`:

1. **GitHub Actions se déclenche automatiquement**
   - CI checks (tests, linting, builds)
   - Construction des images Docker avec le tag `dev`
   - Déploiement automatique sur `/home/canari/canari-dev`

2. **Status des services Dev**
   - Frontend: `https://dev.canari-emse.fr` (via Cloudflare)
   - Ports internes du serveur:
     - Chat Gateway: `localhost:3100`
     - Chat Delivery: `localhost:3110`
     - Media Service: `localhost:3111`
     - Core Service: `localhost:3112`
     - Social Service: `localhost:3114`

3. **Accès derrière Cloudflare**
   - Tout est accessible via Cloudflare sur le port 8080
   - Dev et prod coexistent sur le même serveur dans des répertoires séparés
   - Nginx doit avoir des entrées `dev.canari-emse.fr` et `canari-emse.fr`

## 📋 Structure de Déploiement

```
Serveur (même machine)
├── /home/canari/canari         (PROD - main branch)
│   ├── docker-compose.prod.yml
│   ├── infrastructure/.env
│   └── [Services sur ports 3000, 3010, 3011, 3012, 3014, 80]
│
└── /home/canari/canari-dev     (DEV - dev branch)
    ├── docker-compose.dev.yml
    ├── infrastructure/.env
    └── [Services sur ports 3100, 3110, 3111, 3112, 3114, 3080]
```

## 🔄 Workflow à Partir d'Ici

### Pour les nouveaux changements de dev:

1. Créer une branche feature: `git checkout -b feature/xxx dev`
2. Faire les changements et commits
3. Créer une PR vers `dev` (ne merge pas directement)
4. Une fois approuvée, merge vers `dev`
5. Push vers `origin dev`
6. Le workflow CD dev se déclenche automatiquement

### Merger dev vers main pour release:

1. Créer une PR `dev` → `main`
2. Review de dev avant intégration en prod
3. Merger et le workflow CD prod se déclenche
4. Images `latest` et `main` sont créées et déployées

## 🛠️ Commandes Utiles

```bash
# Voir l'état des branches
git branch -vv

# Voir les workflows deployment status
gh workflow view cd-dev.yml --json status

# Manuellement déclencher le workflow dev (si nécessaire)
gh workflow run cd-dev.yml -r dev

# Vérifier les images disponibles
docker pull ghcr.io/emse-students/canari/frontend:dev
```
