# Configuration des Secrets & Variables GitHub

Ce document explique comment configurer les **secrets** et **variables** requis pour le déploiement automatique via GitHub Actions.

## Localisation

Dans votre dépôt GitHub :
- **Secrets** : Settings → Secrets and variables → Actions → Secrets
- **Variables** : Settings → Secrets and variables → Actions → Variables

---

## Secrets Requis

### Pour le Déploiement SSH

Ajoutez ces secrets pour permettre le déploiement automatique sur votre serveur :

| Nom | Description | Exemple |
|-----|-------------|---------|
| `SSH_PRIVATE_KEY` | Clé SSH privée (ED25519 recommandé) | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `SSH_USER` | Utilisateur SSH pour la connexion | `deploy` |
| `SERVER_HOST` | Hostname ou IP du serveur | `prod.example.com` ou `192.168.1.100` |
| `DEPLOY_PATH` | Chemin du projet sur le serveur | `/opt/canari` |

### Génération de la clé SSH

```bash
# Sur votre machine locale
ssh-keygen -t ed25519 -f github_deploy -N "" -C "github-deploy@canari"

# Contenu de la clé publique (à ajouter au serveur)
cat github_deploy.pub

# Contenu de la clé privée (à ajouter dans GitHub Secrets)
cat github_deploy
```

### Configuration du serveur

```bash
# Sur le serveur de déploiement
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy

# Créer .ssh et ajouter la clé publique
sudo mkdir -p /home/deploy/.ssh
echo "contenu_de_github_deploy.pub" | sudo tee -a /home/deploy/.ssh/authorized_keys
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh

# Créer le répertoire du projet
sudo mkdir -p /opt/canari
sudo chown deploy:deploy /opt/canari

# Permettre à l'utilisateur deploy de redémarrer Docker sans mot de passe (optionnel)
sudo visudo
# Ajouter: deploy ALL=(ALL) NOPASSWD: /usr/bin/docker
```

---

## Variables Requises

### Pour le Déploiement

Ajoutez ces variables (Settings → Variables) :

| Nom | Description | Exemple |
|-----|-------------|---------|
| `DOMAIN` | Domaine/IP du serveur pour les URLs | `api.canari.example.com` |

---

## Exemple de Configuration Complète

### 1. Générer les clés SSH

```bash
ssh-keygen -t ed25519 -f ~/.ssh/canari_deploy -C "canari-deploy"
```

### 2. Ajouter à GitHub (Settings → Secrets)

```
SSH_PRIVATE_KEY = [contenu de ~/.ssh/canari_deploy]
SSH_USER = deploy
SERVER_HOST = prod.example.com
DEPLOY_PATH = /opt/canari
```

### 3. Ajouter à GitHub (Settings → Variables)

```
DOMAIN = api.prod.example.com
```

### 4. Configurer le serveur

```bash
# Sur prod.example.com
ssh -i ~/.ssh/canari_deploy deploy@prod.example.com

# Une fois connecté
cd /opt/canari
docker login ghcr.io  # Authentifier avec votre token GitHub
```

---

## Déploiement Manuel

Si vous préférez déployer manuellement sans GitHub Actions :

```bash
./scripts/deploy.sh production
```

Cela nécessite les variables d'environnement correspondantes.

---

## Dépannage

### "Context access might be invalid: DOMAIN"

Cette erreur VS Code signifie que la variable n'a pas été trouvée. C'est normal avant la configuration.

**Solution** : Créer la variable dans GitHub Settings → Variables

### Le déploiement SSH échoue

Vérifiez les logs GitHub Actions pour voir l'erreur exacte :
1. Allez à Code → Actions
2. Cliquez sur le dernier workflow
3. Vérifiez les détails de l'étape "Deploy via SSH"

Causes communes :
- Clé SSH mal configurée
- Utilisateur n'existe pas sur le serveur
- Permissions incorrectes sur `.ssh`
- Le répertoire `/opt/canari` n'existe pas

---

## Sécurité

⚠️ **Important** :
- Ne jamais commiter vos clés SSH
- Utilisez des clés ED25519 (meilleure sécurité)
- Limitez l'accès SSH à votre serveur (firewall)
- Changez le mot de passe de l'utilisateur `deploy` après la configuration initiale
- Revoyez régulièrement les secrets GitHub pour les keys obsolètes

---

## Références

- [GitHub Actions - Using Encrypted Secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)
- [OpenSSH Key Generation](https://man.openbsd.org/ssh-keygen)
- [Docker in GitHub Actions](https://docs.github.com/en/actions/publishing-packages/publishing-docker-images)
