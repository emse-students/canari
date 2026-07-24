# Server migration / cloning Canari to a new host

Complete procedure to bring up Canari on a fresh machine. Most of it is
automated by the CD pipeline; this document covers the manual bootstrap that
cannot live in the CD itself (chicken-and-egg: the CD needs a server that is
already reachable).

Overview:

```
Manual bootstrap (this doc)        CD (automatic)               Data
─────────────────────────────       ─────────────────────       ──────────────────
Docker + runner + clone repo   ->   generates .env files    ->   restore.sh
SSH canari -> mitv (backups)        deploys Canari               (from mitv)
GitHub secrets present              deploys Authentik
```

## 0. Machine prerequisites

- Up-to-date Debian/Ubuntu, root/sudo access, domain DNS pointing to the server.
- Docker Engine + `docker compose` plugin:
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"   # re-login afterwards
  ```
- An application user `canari` (the deployment lives in `/home/canari`).

## 1. Self-hosted GitHub Actions runner

The `deploy-to-server` job runs on a self-hosted runner (label `self-hosted`).

1. GitHub → repo → Settings → Actions → Runners → New self-hosted runner.
2. Follow the provided commands (download + `config.sh` with the token).
3. Install as a service so it survives reboots:
   ```bash
   sudo ./svc.sh install canari
   sudo ./svc.sh start
   ```

## 2. Clone the repository

```bash
sudo -u canari git clone https://github.com/emse-students/canari.git /home/canari/canari
```

The CD then runs `git reset --hard origin/main` on each deployment; the initial
clone is sufficient.

## 3. GitHub Secrets

The CD generates all `.env` files from the repo secrets. On a new repo/fork,
recreate them (Settings → Secrets and variables → Actions). Secrets required
for **server deployment**:

| Category | Secrets |
|---|---|
| Core | `JWT_SECRET`, `INTERNAL_SECRET`, `INTERNAL_SHARED_SECRET`, `CHANNELS_ENCRYPTION_SECRET`, `CALL_ROOM_SECRET` |
| Database | `POSTGRES_USER`, `POSTGRES_PASSWORD` |
| Media storage (MinIO) | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` |
| Auth (Authentik) | `AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `MICONNECT_PG_PASS`, `MICONNECT_AUTHENTIK_SECRET_KEY` |
| App / frontend | `BASE_URL`, `STRIPE_PUB_KEY`, `KLIPY_API_KEY`, `ANDROID_APP_LINK_SHA256`, `APPLE_TEAM_ID` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Push / calls / avatars | `FIREBASE_SERVICE_ACCOUNT_JSON`, `CLOUDFLARE_CALLS_API_TOKEN`, `CLOUDFLARE_TURN_KEY_ID`, `MIGALLERY_API_KEY` |
| iOS calls (CallKit, optional) | `APNS_VOIP_KEY_P8` (APNs .p8 key, raw PEM or base64), `APNS_VOIP_KEY_ID`, `APNS_VOIP_TEAM_ID` (`4CLNB8SR6L`) — direct VoIP push to APNs to ring CallKit when the app is killed; without these, iOS falls back to an FCM banner |
| External API (Sky) | `EXTERNAL_API_KEY` (key for `/api/external/*`, public profile; must match `CANARI_API_KEY` on Sky's side); `SKY_API_KEY` (key for reading the Sky sponsorship tree displayed on profiles; must match `SKY_API_KEY` on Sky's side) |

Optional secret: `SERVICE_ACCOUNT_USER_ID` overrides the Google/Apple verification
account ID (hides it from non-admins in search, directory, and feed; only sees
admins itself). If not defined, falls back to the default value in `.env.example`.
This is not a sensitive secret (just a user ID), but exposing it as a secret allows
changing it without a commit.

Generate strong values: `openssl rand -hex 32` (secrets), `openssl rand -base64 60`
(`MICONNECT_AUTHENTIK_SECRET_KEY`).

## 4. SSH access for offsite backup (mitv)

Backups push to `mitv` via SSH. On the new server:

```bash
# Server key (if missing)
sudo -u canari ssh-keygen -t ed25519 -N "" -f /home/canari/.ssh/id_ed25519

# Trust mitv
sudo -u canari ssh-keyscan -H 10.0.0.4 >> /home/canari/.ssh/known_hosts
```

On `mitv` (once only), authorize the server's public key for the dedicated
`canaribackup` user (member of `_ssh` group, store `/srv/canari-backups`):

```bash
useradd -m -s /bin/bash canaribackup 2>/dev/null
usermod -aG _ssh canaribackup
install -d -m 700 -o canaribackup -g canaribackup /srv/canari-backups /home/canaribackup/.ssh
echo "<contents of /home/canari/.ssh/id_ed25519.pub>" >> /home/canaribackup/.ssh/authorized_keys
chown canaribackup:canaribackup /home/canaribackup/.ssh/authorized_keys
chmod 600 /home/canaribackup/.ssh/authorized_keys
```

Test: `sudo -u canari ssh canaribackup@10.0.0.4 'echo ok'`.

## 5. First deployment

Trigger the CD (push to `main`, or Actions → CD → Run workflow). It will:

1. generate `infrastructure/.env` from secrets (regenerated from the template);
2. deploy the Canari stack (`docker compose -f infrastructure/docker-compose.prod.yml up -d`);
3. deploy the Authentik `miconnect` stack (see [authentik/](authentik/));
4. apply SQL migrations and verify service health.

## 6. Data restore

From the latest offsite backup:

```bash
cd /home/canari/canari
./infrastructure/backup/restore.sh --latest-from-mitv --yes
```

Restores PostgreSQL (`auth_db`), MinIO (media), media_meta, and the Authentik database.
See [backup/README.md](backup/README.md).

## 7. Enable recurring backups

```bash
sudo -u canari crontab -e
# Add:
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * cd /home/canari/canari && ./infrastructure/backup/backup.sh >> /home/canari/backups/backup.log 2>&1
```

(Alternative via root: systemd timer, see [backup/README.md](backup/README.md).)

## 8. Network / reverse proxy

The `frontend` container embeds Nginx and publishes the host port `FRONTEND_HOST_PORT`
(8080 by default). Place a reverse proxy / TLS (Caddy, Traefik, host Nginx, or
Cloudflare) in front, pointing the domain to this port. API routes are resolved
internally by the container's Nginx (see `infrastructure/local/Dockerfile.frontend`).

## Quick checklist

- [ ] Docker + compose installed
- [ ] Self-hosted runner registered and active
- [ ] Repository cloned at `/home/canari/canari`
- [ ] GitHub secrets created
- [ ] SSH canari → mitv working
- [ ] CD passed green (Canari + Authentik)
- [ ] Data restored from mitv
- [ ] Backup cron installed
- [ ] Reverse proxy / DNS / TLS in place
