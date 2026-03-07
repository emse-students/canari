# CI/CD Configuration Guide

## GitHub Actions Workflows

Le projet utilise deux workflows GitHub Actions :

### 1. CI (Continuous Integration) - `.github/workflows/ci.yml`
Exécuté sur chaque push et PR vers `main` :
- ✅ Tests des composants Rust (libs + gateway)
- ✅ Tests des services TypeScript
- ✅ Linting et formatage du code
- ✅ Vérification de la qualité du code avec Clippy

### 2. CD (Continuous Deployment) - `.github/workflows/cd.yml`
Exécuté automatiquement sur chaque push vers `main` :
- 🔨 Build du frontend (WASM + Svelte)
- 🐳 Build et push des images Docker vers GitHub Container Registry
- 🚀 Déploiement automatique sur le serveur de production
- 🔍 Health checks post-déploiement
- 🚨 Notifications en cas d'échec

## Configuration requise

### Secrets GitHub

Configurer les secrets suivants dans **Settings > Secrets and variables > Actions** :

#### Secrets
```
SSH_PRIVATE_KEY       # Clé SSH privée pour se connecter au serveur
SSH_USER              # Nom d'utilisateur SSH (ex: deploy)
SERVER_HOST           # Adresse IP ou hostname du serveur (ex: canari.example.com)
DEPLOY_PATH           # Chemin du projet sur le serveur (ex: /opt/canari)
```

#### Variables d'environnement
```
DOMAIN                # Domaine de production (ex: canari-emse.fr)
```

### Génération de la clé SSH de déploiement

```bash
# Sur votre machine locale
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_deploy_key

# Copier la clé publique sur le serveur
ssh-copy-id -i ~/.ssh/github_deploy_key.pub user@server.com

# Copier le contenu de la clé privée dans le secret GitHub
cat ~/.ssh/github_deploy_key
```

### Préparation du serveur

#### 1. Installer Docker et Docker Compose

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Docker Compose
sudo apt-get install docker-compose-plugin
```

#### 2. Créer l'utilisateur de déploiement

```bash
# Créer un utilisateur dédié
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy

# Créer le répertoire de déploiement
sudo mkdir -p /opt/canari
sudo chown deploy:deploy /opt/canari
```

#### 3. Cloner le dépôt sur le serveur

```bash
# En tant qu'utilisateur deploy
sudo su - deploy
cd /opt/canari
git clone https://github.com/votre-org/canari.git .
```

#### 4. Configuration Nginx

```bash
# Installer Nginx
sudo apt-get install nginx

# Utiliser le Makefile pour configurer
make nginx-install
```

## Workflow de déploiement

### Déploiement automatique

1. Commit et push vers `main`
2. GitHub Actions déclenche automatiquement :
   - Tests CI (doit passer)
   - Build du frontend
   - Build des images Docker
   - Push vers GitHub Container Registry
   - Déploiement SSH sur le serveur
   - Health checks

### Déploiement manuel

Depuis l'onglet **Actions** de GitHub :
1. Sélectionner le workflow "CD - Deploy to Production"
2. Cliquer sur "Run workflow"
3. Choisir la branche (main par défaut)
4. Cliquer sur "Run workflow"

### Rollback en cas de problème

```bash
# Se connecter au serveur
ssh deploy@server.com

cd /opt/canari

# Vérifier les images disponibles
docker images | grep canari

# Revenir à une version précédente
docker compose -f infrastructure/local/docker-compose.yml down
docker tag ghcr.io/org/canari/chat-gateway:previous-sha ghcr.io/org/canari/chat-gateway:latest
docker compose -f infrastructure/local/docker-compose.yml up -d
```

## Monitoring et logs

### Consulter les logs des conteneurs

```bash
# Tous les services
docker compose -f infrastructure/local/docker-compose.yml logs -f

# Service spécifique
docker compose -f infrastructure/local/docker-compose.yml logs -f chat-gateway
```

### Health checks

```bash
# Gateway
curl https://canari-emse.fr/health

# Delivery Service
curl https://canari-emse.fr/api/health
```

## Environnements

### Production
- **URL** : https://canari-emse.fr
- **Branche** : `main`
- **Auto-deploy** : ✅ Activé

### Staging (optionnel)
Pour ajouter un environnement de staging :

1. Créer une branche `staging`
2. Dupliquer `cd.yml` → `cd-staging.yml`
3. Modifier les conditions de déclenchement
4. Configurer les secrets pour le serveur de staging

## Troubleshooting

### Le déploiement échoue avec "Permission denied"

Vérifier que :
- La clé SSH est correctement configurée
- L'utilisateur deploy a les permissions Docker
- Le répertoire /opt/canari appartient à deploy

### Les images Docker ne se mettent pas à jour

```bash
# Sur le serveur
docker compose pull --force
docker compose up -d --force-recreate
```

### Le site ne répond pas après le déploiement

```bash
# Vérifier l'état des conteneurs
docker compose ps

# Vérifier les logs
docker compose logs --tail=100

# Vérifier Nginx
sudo nginx -t
sudo systemctl status nginx
```

## Sécurité

- ✅ Les secrets sont stockés dans GitHub Secrets (chiffrés)
- ✅ La clé SSH de déploiement a des permissions minimales
- ✅ Les images Docker sont signées et scannées
- ✅ HTTPS activé via Nginx
- ⚠️ Configurer un pare-feu (UFW) sur le serveur
- ⚠️ Activer fail2ban pour SSH

## Améliorations futures

- [ ] Ajout d'environnement de staging
- [ ] Tests E2E automatisés avant déploiement
- [ ] Monitoring avec Prometheus/Grafana
- [ ] Alertes Slack/Discord en cas d'échec
- [ ] Backup automatique de la base de données
- [ ] Blue-Green deployment
