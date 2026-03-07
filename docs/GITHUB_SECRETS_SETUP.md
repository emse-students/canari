# Configuration des Secrets GitHub - Guide Visuel

## Vue d'ensemble

Pour que le déploiement automatique fonctionne, vous avez besoin de **secrets** et **variables** dans GitHub. Voici le guide complet étape par étape.

---

## 1️⃣ Accéder aux paramètres de secrets

```
Votre dépôt GitHub
  └─ Settings (⚙️ en haut à droite de la page)
     └─ Secrets and variables
        └─ Actions
```

**Adresse directe** : `https://github.com/emse-students/canari/settings/secrets/actions`

---

## 2️⃣ Générer la clé SSH

Avant d'ajouter les secrets, créez une clé SSH sur votre machine locale :

```bash
# Générer une nouvelle clé ED25519
ssh-keygen -t ed25519 -f ~/.ssh/canari_deploy -C "github-canari-deploy" -N ""

# Afficher la clé privée (pour GitHub)
cat ~/.ssh/canari_deploy

# Afficher la clé publique (pour le serveur)
cat ~/.ssh/canari_deploy.pub
```

Vous obtiendrez quelque chose comme :

**Clé privée** :
```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUtbm9uZS1ub25lAAAAAAAAAEUAAAA7c3NoLXJzYS
...
-----END OPENSSH PRIVATE KEY-----
```

**Clé publique** :
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFQ6FeU...
```

---

## 3️⃣ Ajouter les Secrets

Dans **Settings → Secrets and variables → Actions → Secrets**, cliquez sur **"New repository secret"** et ajoutez ces 4 secrets :

### Secret 1️⃣ : `SSH_PRIVATE_KEY`

**Nom** : `SSH_PRIVATE_KEY`

**Valeur** : Copier-coller **toute la clé privée** (incluant `-----BEGIN OPENSSH PRIVATE KEY-----` et la dernière ligne)

```
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUtbm9uZS1ub25lAAAAAAAAAEUAAAA7c3NoLXJzYS
...
-----END OPENSSH PRIVATE KEY-----
```

### Secret 2️⃣ : `SSH_USER`

**Nom** : `SSH_USER`

**Valeur** : Nom d'utilisateur sur le serveur (ex: `deploy`)

```
deploy
```

### Secret 3️⃣ : `SERVER_HOST`

**Nom** : `SERVER_HOST`

**Valeur** : Hostname ou IP du serveur de production

```
prod.example.com
```
ou
```
192.168.1.100
```

### Secret 4️⃣ : `DEPLOY_PATH`

**Nom** : `DEPLOY_PATH`

**Valeur** : Chemin complet du projet sur le serveur

```
/opt/canari
```

---

## 4️⃣ Ajouter les Variables

Dans **Settings → Secrets and variables → Actions → Variables**, cliquez sur **"New repository variable"** et ajoutez :

### Variable 1️⃣ : `DOMAIN`

**Nom** : `DOMAIN`

**Valeur** : Votre domaine ou IP de production

```
api.canari.example.com
```
ou
```
192.168.1.100
```

---

## 5️⃣ Configurer le serveur

Avant le premier déploiement, préparez le serveur :

```bash
# SSH au serveur
ssh root@YOUR_SERVER_IP

# Créer l'utilisateur deploy
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy

# Créer les répertoires SSH
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh

# IMPORTANT : Ajouter la clé publique
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFQ6FeU..." | sudo tee /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh

# Créer le répertoire du projet
sudo mkdir -p /opt/canari
sudo chown deploy:deploy /opt/canari

# Configurer Docker Compose
sudo mkdir -p /opt/canari/infrastructure
sudo chown -R deploy:deploy /opt/canari

# Login Docker pour GHCR (GitHub Container Registry)
sudo -u deploy sh -c 'echo "TOKEN_GITHUB" | docker login ghcr.io -u jolan --password-stdin'
# Remplacer jolan par votre username GitHub et TOKEN_GITHUB par votre GitHub Personal Access Token
```

---

## ✅ Vérification

Après la configuration, vérifiez que tout fonctionne :

1. **Poussez un commit** :
   ```bash
   git add .
   git commit -m "test: verify CI/CD setup"
   git push origin main
   ```

2. **Vérifiez les GitHub Actions** :
   - Allez dans votre dépôt GitHub
   - Onglet "Actions"
   - Vous devriez voir les workflows s'exécuter

3. **Vérifiez les logs CI** :
   - Cliquez sur le workflow "CI"
   - Vérifiez que `test-rust`, `test-typescript` passent

4. **Vérifiez les logs CD** (optionnel si déploiement configuré) :
   - Cliquez sur le workflow "CD"
   - Section "Build Docker images" - doit réussir
   - Section "Deploy to Production" - optionel, dépend de vos secrets

---

## 🔐 Sécurité - À FAIRE ABSOLUMENT

- ✅ Jamais commiter vos clés SSH dans Git
- ✅ Utiliser ED25519 (meilleure sécurité qu'RSA)
- ✅ Limiter l'accès SSH au serveur (firewall)
- ✅ Utiliser des clés SSH dédiées par CI/CD
- ✅ Régulièrement regénérer les clés
- ✅ Surveiller les accès debug dans Github Actions logs

---

## 🆘 Dépannage

### Erreur : "Context access might be invalid"

C'est juste un avertissement VS Code. Les secrets/variables n'existent pas encore localement - cela disparaîtra une fois configurés dans GitHub.

### Erreur SSH : "Permission denied"

Vérifiez sur le serveur :
```bash
ls -la /home/deploy/.ssh/
# Doit montrer: authorized_keys avec permissions 600
cat /home/deploy/.ssh/authorized_keys
# Doit contenir votre clé publique
```

### Erreur Docker : "authentication required"

Connectez-vous à GHCR sur le serveur :
```bash
sudo -u deploy docker login ghcr.io
# Username: votre_username_github
# Password: votre_PAT_github (Personal Access Token)
```

Générer un PAT : Settings → Developer settings → Personal access tokens → Tokens (classic)
- Sélectionner les scopes: `read:packages`, `write:packages`

### Erreur : "Could not find deploy_path"

Vérifiez que le répertoire existe :
```bash
ssh deploy@your.server
ls -la /opt/canari
```

---

## 📝 Checklist Finale

Avant de considérer la configuration complète :

- [ ] 4 secrets créés dans GitHub (SSH_PRIVATE_KEY, SSH_USER, SERVER_HOST, DEPLOY_PATH)
- [ ] 1 variable créée dans GitHub (DOMAIN)
- [ ] Clé SSH configurée sur le serveur dans `/home/deploy/.ssh/authorized_keys`
- [ ] Utilisateur `deploy` créé et peut exécuter `docker` 
- [ ] Répertoire `/opt/canari` existe et appartient à l'utilisateur `deploy`
- [ ] Docker login réussi sur GHCR
- [ ] Un test push réussi dans GitHub Actions

Une fois tout OK, **push automatiquement vers production à chaque commit sur `main`** ! 🚀

---

## Support

Si vous avez des problèmes :
1. Consultez les logs GitHub Actions (Settings → Environments peut aussi aider)
2. SSH au serveur et vérifiez les logs Docker
3. Créez une issue GitHub avec les détails de l'erreur

