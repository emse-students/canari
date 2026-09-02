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
| Media storage (Garage, formerly MinIO) | `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_ACCESS_KEY_ID` (>= 8 chars), `GARAGE_SECRET_ACCESS_KEY` (>= 16 chars) - Garage's own minimums, which is why this is a dedicated key rather than reusing `MINIO_ROOT_USER`/`PASSWORD` |
| Auth (Authentik) | `AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `MICONNECT_PG_PASS`, `MICONNECT_AUTHENTIK_SECRET_KEY` |
| App / frontend | `BASE_URL`, `STRIPE_PUB_KEY`, `KLIPY_API_KEY`, `ANDROID_APP_LINK_SHA256`, `APPLE_TEAM_ID` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LYDIA_PROVIDER_TOKEN`, `LYDIA_PROVIDER_PRIVATE_TOKEN` (WP-LYDIA-1; core-service only, unlike Stripe's secrets which also reach social-service unused - which provider is actually live is `platform_config.paymentProvider`, an admin setting at `/admin/platform`, not an env var) |
| Push / calls / avatars | `FIREBASE_SERVICE_ACCOUNT_JSON`, `CLOUDFLARE_CALLS_API_TOKEN`, `CLOUDFLARE_TURN_KEY_ID`, `MIGALLERY_API_KEY` |
| iOS calls (CallKit, optional) | `APNS_VOIP_KEY_P8` (APNs .p8 key, raw PEM or base64), `APNS_VOIP_KEY_ID`, `APNS_VOIP_TEAM_ID` (`4CLNB8SR6L`) — direct VoIP push to APNs to ring CallKit when the app is killed; without these, iOS falls back to an FCM banner |
| External API (Sky) | `EXTERNAL_API_KEY` (key for `/api/external/*`, public profile; must match `CANARI_API_KEY` on Sky's side); `SKY_API_KEY` (key for reading the Sky sponsorship tree displayed on profiles; must match `SKY_API_KEY` on Sky's side) |
| External API (Le Cercle) | `CERCLE_API_KEY` (key for `/api/public/cotisant-status`, consumed by Le Cercle before it lets a member drink; must match `CANARI_API_KEY` on the Cercle's side). Empty rejects every request. The other half of the link, the `balance_topup` webhook secret, is per-product data in the database, not an environment variable - see [`docs/PROD-TEST-CERCLE.md`](../docs/PROD-TEST-CERCLE.md) |
| Link safety (WP-SAFELINK-1, optional) | `GOOGLE_SAFE_BROWSING_API_KEY` (Google Cloud Safe Browsing API key, restricted to the deploy server's outbound IP; fails OPEN when unset - no lookup, no warning shown, no link ever blocked) |

Optional secret: `SERVICE_ACCOUNT_USER_ID` overrides the Google/Apple verification
account ID (hides it from non-admins in search, directory, and feed; only sees
admins itself). If not defined, falls back to the default value in `.env.example`.
This is not a sensitive secret (just a user ID), but exposing it as a secret allows
changing it without a commit.

Generate strong values: `openssl rand -hex 32` (secrets), `openssl rand -base64 60`
(`MICONNECT_AUTHENTIK_SECRET_KEY`).

> **The dev environment needs its OWN value for every secret above, not a copy of production's, and
> it reads them under a `DEV_` PREFIX.** A row in
> [`infrastructure/deploy/env-manifest.tsv`](deploy/env-manifest.tsv) says `secret:JWT_SECRET`;
> production reads `JWT_SECRET`, dev reads `DEV_JWT_SECRET` **and never the bare name**. That
> indirection is the isolation: a dev secret nobody created is EMPTY rather than production's value,
> and the deploy then refuses. GitHub environment-scoped secrets would fail OPEN here - a forgotten
> dev secret resolving silently to the repo-level production value - which is exactly what the deleted
> `cd-dev.yml` did.
>
> `JWT_SECRET` is the one that must differ on principle rather than on hygiene: sharing it would make
> a token minted by either environment valid in the other, which is the whole isolation gone. The same
> holds for the Garage keys and the Authentik client.
>
> **Which `DEV_*` secrets to create, and what each absence costs, is the manifest itself** - every row
> whose DEV column is not `skip`, prefixed `DEV_`. Fourteen are `required` and the deploy refuses
> without them; nine are `warn` and each degrades one named feature; three are `silent` because a
> default answers for them. Rows marked `skip` must NOT be created: Stripe, Lydia and
> `CERCLE_API_KEY` are deliberately absent from dev (decided with the user), so that a copy of
> production's database can never charge a real card nor be answered as production by Le Cercle.
> **Push is NOT among them** - `copy-prod-to-dev.sh` truncates `push_token`, so dev has no real
> device to reach, and both halves of push (FCM and the three APNs values) are ordinary optional
> credentials.

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
4. apply SQL migrations (see below) and verify service health.

### SQL migrations

Production runs TypeORM with `synchronize: false`, so **an entity change without a matching SQL file
never reaches production**. The CD step "Run database migrations" collects
`apps/*/src/migrations/*.sql`, sorts by path, and applies every file not yet listed in the
`schema_migrations` ledger (`filename`, `checksum`, `applied_at`) with `ON_ERROR_STOP=1`.

Writing one: idempotent statements only (`IF NOT EXISTS` / `IF EXISTS`, or a `DO $$ ... $$` guard),
camelCase columns double-quoted, a fresh number in that service's directory, and no edits to a file
that has already been applied - the checksum mismatch only warns, production keeps the old version.
Full rationale in [`docs/wiki/infrastructure/databases.md`](../docs/wiki/infrastructure/databases.md).

On a **fresh** host there is nothing to migrate: the migration files are a patch set on top of a
schema TypeORM created long ago (migration 001 opens with `ALTER TABLE users`), so the database comes
from the restore in step 6, and the migrations then apply on top.

## 6. Data restore

From the latest offsite backup:

```bash
cd /home/canari/canari
./infrastructure/backup/restore.sh --latest-from-mitv --yes
```

Restores PostgreSQL (`auth_db`), Garage (media, in `garage_data`/`garage_meta`), media_meta,
and the Authentik database. No separate bucket/key bootstrap is needed afterwards: Garage's
`--default-bucket` startup flag (see `infrastructure/docker-compose.prod.yml`) re-provisions
the bucket/key from `GARAGE_ACCESS_KEY_ID`/`GARAGE_SECRET_ACCESS_KEY` on every boot, and is a no-op when
the restored volumes already contain them. See [backup/README.md](backup/README.md).

## 7. Enable recurring backups

```bash
sudo -u canari crontab -e
# Add:
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * cd /home/canari/canari && ./infrastructure/backup/backup.sh >> /home/canari/backups/backup.log 2>&1
0 4 * * * cd /home/canari/canari && ./infrastructure/backup/backup-objects.sh >> /home/canari/backups/backup-objects.log 2>&1
# Egress ledger, one sample a minute - see egress-probe/README.md
* * * * * cd /home/canari/canari && ./infrastructure/egress-probe/probe.sh >> /home/canari/egress/probe.err 2>&1
```

(Alternative via root: systemd timer, see [backup/README.md](backup/README.md).)

The egress probe is a MEASUREMENT, not a backup: it answers whether outbound stalls arrive together
or independently, which no one-shot probe can. It writes timings only - the repository is public -
and caps its own ledger at 30 days. `/home/canari/egress/probe.err` must stay empty; anything in it
is the probe failing, which is not the same as an upstream failing.
See [egress-probe/README.md](egress-probe/README.md).

### The restic repository password is a bootstrap step, and it is NOT a GitHub secret

`backup-objects.sh` keeps the media volumes in a deduplicated restic repository. Its
password must exist before the first run, and it deliberately lives OUTSIDE the deployment
cycle - the CD regenerates `infrastructure/.env` from the repo secrets on every deploy, and
a restic repository whose password changes is unreadable forever:

```bash
sudo -u canari mkdir -p /home/canari/.config/canari
sudo -u canari sh -c 'umask 077; openssl rand -base64 48 > /home/canari/.config/canari/restic-password'
```

**Copy that file off the machine and keep it with the disaster-recovery material.** Without
it, both the local repository and its offsite mirror are unreadable - the mirror is a copy
of an encrypted repository, not a second chance. The script aborts when the file is missing
rather than generating one, because generating one would silently start a SECOND repository
while every run kept reporting success.

## 8. Network / reverse proxy

The `frontend` container embeds Nginx and publishes the host port `FRONTEND_HOST_PORT`
(8080 by default). Place a reverse proxy / TLS (Caddy, Traefik, host Nginx, or
Cloudflare) in front, pointing the domain to this port. API routes are resolved
internally by the container's Nginx (see `infrastructure/local/Dockerfile.frontend`).

The web front is **two containers over one build artifact**:

| Container | Role | Published |
|---|---|---|
| `frontend` | Nginx: the only public entry point. Serves `build/client` + `build/prerendered` and proxies every `/api/*` | yes, `FRONTEND_HOST_PORT` |
| `frontend-ssr` | SvelteKit `adapter-node`. Answers HTML navigations only, writing each page's Open Graph head into the shell | no, Docker network only |

`frontend-ssr` needs **`INTERNAL_SECRET`** (already required by core, social,
chat-delivery and media) to read post/association/invite metadata straight from the
services. Without it the site still works - previews just stay generic.

There is **no static `index.html` fallback any more**: `adapter-node` does not emit one, so
Nginx answers a navigation with 502 if `frontend-ssr` is down. Both images must be deployed
from the same build; the CD rebuilds them together for exactly that reason.

## 9. The dev environment (`dev.canari-emse.fr`)

**Nothing here is required to bring production up, and on a fresh host there is nothing to do.** The
second estate is optional. Since 2026-09-01 the pipeline that deploys it exists - three jobs in
`cd.yml` plus `dev-refresh.yml` - all gated on the repository variable `DEV_ENVIRONMENT_ENABLED`.
**On THIS repository that variable is `true` since 2026-09-02, with all 14 `required` `DEV_*`
secrets present and the `canari-dev` Authentik client created; on a fresh host it is absent and
every dev job skips.** It is recorded here because turning that switch on is a bootstrap concern,
and because its prerequisites are credentials only a human can create. **Two traps that cost a
bootstrap each:** `gh secret set --body -` stores a literal dash instead of reading stdin (use
`printf '%s' "$v" | gh secret set NAME`), and the ingress rule below is the LAST step, never the
first - pointed at `3080` before dev answers there, it 502s a name that was serving production.

How it is put together, what its data copy strips, and why a green dev deploy is NOT evidence for a
PostgreSQL major upgrade are on
[`docs/wiki/infrastructure/dev-environment.md`](../docs/wiki/infrastructure/dev-environment.md), the
only copy. What a bootstrap owes:

| | |
|---|---|
| Compose file | [`infrastructure/docker-compose.dev.yml`](docker-compose.dev.yml), deployed as the compose project **`canari-dev`** - the project name is what keeps the two estates apart, since compose gives each its own network and volumes |
| Host ports | `3080` for the frontend (production uses `8080`) and `19100`/`19101` for Garage tooling (production `19010`/`19011`). **Both of dev's are bound to `127.0.0.1`** - stricter than production, whose frontend port is published on every interface - and these are the only two bindings that differ, since production publishes no host port for any internal service |
| Reverse proxy | one cloudflared ingress rule pointing `dev.canari-emse.fr` at `http://localhost:3080`. GET the tunnel config, save the original, change the single rule, PUT |
| Secrets | its own value for everything in [section 3](#3-github-secrets) - see the note there |
| Authentik | its own OIDC client, creatable on the box: `docker exec miconnect-server-1 ak shell -c ...` |
| Data | `infrastructure/dev/copy-prod-to-dev.sh` on the box. Supports `--dry-run`, which changes nothing and reports what it would do. It refuses to write anywhere but the `canari-dev` compose project, and that refusal is a re-read Docker label rather than a flag |
| Deployed from | `/home/canari/canari-dev`, a SEPARATE clone - two estates sharing one working tree would race, a `git reset --hard` for one rewriting the compose file the other is deployed from. `deploy-dev` creates it if absent, so there is nothing to do by hand |
| Images | the two frontends are dev's own (`frontend:dev`, `frontend-ssr:dev`), because SvelteKit bakes `import.meta.env.*` in at build time; **every backend image is shared with production**, which is deliberate - it means a behavioural difference between the estates can never be blamed on a different build |
| Deploy order | dev deploys BEFORE production, and a failed dev deploy stops production's. Setting `DEV_ENVIRONMENT_ENABLED` to anything but `true` is the escape hatch |
| Turning it on | (1) the ingress rule above, (2) the `DEV_*` secrets - see [section 3](#3-github-secrets), (3) set `DEV_ENVIRONMENT_ENABLED` to `true` in `Settings -> Secrets and variables -> Actions -> Variables` |
| Owed by a human, but NOT blocking | a dev Firebase project (push), a dev Android keystore and its backup location, and a Cloudflare Access service token for the test harness |

## Quick checklist

- [ ] Docker + compose installed
- [ ] Self-hosted runner registered and active
- [ ] Repository cloned at `/home/canari/canari`
- [ ] GitHub secrets created
- [ ] SSH canari → mitv working
- [ ] CD passed green (Canari + Authentik)
- [ ] Data restored from mitv
- [ ] Backup cron installed
- [ ] Egress probe cron installed (`/home/canari/egress/samples.ndjson` growing by one line a minute)
- [ ] Reverse proxy / DNS / TLS in place
- [ ] `frontend-ssr` running and `INTERNAL_SECRET` set (otherwise link previews stay generic)
