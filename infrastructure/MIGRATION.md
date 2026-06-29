# Migration / clonage de Canari sur un nouveau serveur

Procedure complete pour remonter Canari sur une machine vierge. La quasi-totalite
est automatisee par la CD ; ce document couvre le bootstrap manuel qui ne peut pas
vivre dans la CD elle-meme (poule et oeuf : la CD a besoin d un serveur deja
joignable).

Vue d ensemble :

```
Bootstrap manuel (cette doc)        CD (automatique)            Donnees
─────────────────────────────       ─────────────────────       ──────────────────
Docker + runner + clone repo   ->    genere les .env       ->    restore.sh
SSH canari -> mitv (backups)         deploie Canari              (depuis mitv)
secrets GitHub presents              deploie Authentik
```

## 0. Pre-requis machine

- Debian/Ubuntu a jour, acces root/sudo, DNS du domaine pointant vers le serveur.
- Docker Engine + plugin `docker compose` :
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"   # se reconnecter ensuite
  ```
- Un utilisateur applicatif `canari` (le deploiement vit dans `/home/canari`).

## 1. Runner GitHub Actions self-hosted

Le job `deploy-to-server` tourne sur un runner self-hosted (label `self-hosted`).

1. GitHub -> repo -> Settings -> Actions -> Runners -> New self-hosted runner.
2. Suivre les commandes fournies (download + `config.sh` avec le token).
3. Installer en service pour qu il survive aux reboots :
   ```bash
   sudo ./svc.sh install canari
   sudo ./svc.sh start
   ```

## 2. Cloner le depot

```bash
sudo -u canari git clone https://github.com/emse-students/canari.git /home/canari/canari
```

La CD fait ensuite `git reset --hard origin/main` a chaque deploiement ; le clone
initial suffit.

## 3. Secrets GitHub

La CD genere tous les `.env` a partir des secrets du repo. Sur un nouveau repo/fork,
les recreer (Settings -> Secrets and variables -> Actions). Secrets necessaires au
**deploiement serveur** :

| Categorie | Secrets |
| --- | --- |
| Coeur | `JWT_SECRET`, `INTERNAL_SECRET`, `INTERNAL_SHARED_SECRET`, `CHANNELS_ENCRYPTION_SECRET`, `CALL_ROOM_SECRET` |
| Base de donnees | `POSTGRES_USER`, `POSTGRES_PASSWORD` |
| Stockage media (MinIO) | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` |
| Auth (Authentik) | `AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `MICONNECT_PG_PASS`, `MICONNECT_AUTHENTIK_SECRET_KEY` |
| App / front | `BASE_URL`, `STRIPE_PUB_KEY`, `KLIPY_API_KEY`, `ANDROID_APP_LINK_SHA256`, `APPLE_TEAM_ID` |
| Paiements | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Push / appels / avatars | `FIREBASE_SERVICE_ACCOUNT_JSON`, `CLOUDFLARE_CALLS_API_TOKEN`, `CLOUDFLARE_TURN_KEY_ID`, `MIGALLERY_API_KEY` |
| API externe (Sky) | `EXTERNAL_API_KEY` (cle de `/api/external/*`, profil public ; doit etre identique a `CANARI_API_KEY` cote Sky) |

Generation de valeurs fortes : `openssl rand -hex 32` (secrets), `openssl rand -base64 60`
(`MICONNECT_AUTHENTIK_SECRET_KEY`).

## 4. Acces SSH pour la sauvegarde offsite (mitv)

Les backups poussent vers `mitv` via SSH. Sur le nouveau serveur :

```bash
# Cle du serveur (si absente)
sudo -u canari ssh-keygen -t ed25519 -N "" -f /home/canari/.ssh/id_ed25519

# Faire confiance a mitv
sudo -u canari ssh-keyscan -H 10.0.0.4 >> /home/canari/.ssh/known_hosts
```

Sur `mitv` (une seule fois), autoriser la cle publique du serveur pour l utilisateur
dedie `canaribackup` (membre du groupe `_ssh`, store `/srv/canari-backups`) :

```bash
useradd -m -s /bin/bash canaribackup 2>/dev/null
usermod -aG _ssh canaribackup
install -d -m 700 -o canaribackup -g canaribackup /srv/canari-backups /home/canaribackup/.ssh
echo "<contenu de /home/canari/.ssh/id_ed25519.pub>" >> /home/canaribackup/.ssh/authorized_keys
chown canaribackup:canaribackup /home/canaribackup/.ssh/authorized_keys
chmod 600 /home/canaribackup/.ssh/authorized_keys
```

Test : `sudo -u canari ssh canaribackup@10.0.0.4 'echo ok'`.

## 5. Premier deploiement

Declencher la CD (push sur `main`, ou Actions -> CD -> Run workflow). Elle :

1. genere `infrastructure/.env` depuis les secrets (regenere depuis le template) ;
2. deploie la stack Canari (`docker compose -f infrastructure/docker-compose.prod.yml up -d`) ;
3. deploie la stack Authentik `miconnect` (cf [authentik/](authentik/)) ;
4. applique les migrations SQL et verifie la sante des services.

## 6. Restauration des donnees

Depuis la derniere sauvegarde offsite :

```bash
cd /home/canari/canari
./infrastructure/backup/restore.sh --latest-from-mitv --yes
```

Restaure PostgreSQL (`auth_db`), MinIO (medias), media_meta et la base Authentik.
Voir [backup/README.md](backup/README.md).

## 7. Activer les sauvegardes recurrentes

```bash
sudo -u canari crontab -e
# Ajouter :
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * cd /home/canari/canari && ./infrastructure/backup/backup.sh >> /home/canari/backups/backup.log 2>&1
```

(Alternative root : timer systemd, cf [backup/README.md](backup/README.md).)

## 8. Reseau / reverse proxy

Le conteneur `frontend` embarque Nginx et publie le port hote `FRONTEND_HOST_PORT`
(8080 par defaut). Mettre un reverse proxy / TLS (Caddy, Traefik, Nginx hote, ou
Cloudflare) devant, pointant le domaine vers ce port. Les routes API sont resolues
en interne par le Nginx du conteneur (cf `infrastructure/local/Dockerfile.frontend`).

## Checklist rapide

- [ ] Docker + compose installes
- [ ] Runner self-hosted enregistre et actif
- [ ] Depot clone dans `/home/canari/canari`
- [ ] Secrets GitHub crees
- [ ] SSH canari -> mitv fonctionnel
- [ ] CD passee au vert (Canari + Authentik)
- [ ] Donnees restaurees depuis mitv
- [ ] Cron de sauvegarde installe
- [ ] Reverse proxy / DNS / TLS en place
