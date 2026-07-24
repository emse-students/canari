# Authentik (OIDC provider)

**Stack**: Authentik (Docker Compose, project name `miconnect`)  
**Source**: `infrastructure/authentik/compose.yml`

Canari uses Authentik as its OpenID Connect identity provider. Authentik is deployed as a separate Docker Compose stack alongside the main application stack.

## Deployment

The CD pipeline ([`cicd.md`](../cicd.md), job `deploy-to-server`):

1. Creates `/home/canari/miconnect/{data,certs,custom-templates}` if absent
2. Copies `infrastructure/authentik/compose.yml` to `/home/canari/miconnect/compose.yml` (versioned source of truth)
3. Generates `/home/canari/miconnect/.env` from GitHub Secrets
4. Runs `docker compose up -d` from the miconnect directory

`up -d` is idempotent: without config changes, Authentik is not recreated.

## OIDC flow

Authentik acts as the OIDC **Provider**; Canari's [`core-service`](../services/core-service.md) acts as the **Relying Party**:

```
Browser → Authentik /authorize (PKCE + state)
  → User authenticates (login/password, SSO)
  → Redirect to /auth/callback?code=...&state=...
  → Browser POSTs code to core-service
  → core-service exchanges code for tokens (server-side)
  → core-service upserts user in PostgreSQL (sub = userId)
  → Returns { access_token (JWT HS256, 15 min), refresh (HttpOnly cookie, 7d) }
```

The user's `sub` claim from Authentik becomes the canonical `userId` across all Canari services (`findOrCreateFromOidc` uses `userinfo.sub` as the primary key).

## Nginx auth_request integration

Every protected request goes through `auth_request /internal/auth/verify`:

1. Nginx calls `core-service:3012/api/auth/verify` (internal only, never public)
2. `core-service` validates the JWT from the `Authorization: Bearer` header
3. On success: Nginx injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` headers
4. Upstream services trust these headers (Nginx strips client-supplied ones on all public locations)

## Configuration

### GitHub Secrets

| Secret | Role |
|---|---|
| `AUTHENTIK_CLIENT_ID` | OIDC client ID (Canari application in Authentik) |
| `AUTHENTIK_CLIENT_SECRET` | OIDC client secret |
| `AUTHENTIK_URL` / `AUTHENTIK_ISSUER` | Authentik issuer URL |
| `MICONNECT_PG_PASS` | Authentik PostgreSQL password |
| `MICONNECT_AUTHENTIK_SECRET_KEY` | Authentik secret key |

### Authentik-side setup

The following must be configured in the Authentik admin UI (not automated via CD):

- **Application**: Canari (OIDC provider, authorization code flow with PKCE)
- **Scopes**: `openid`, `profile`, `email`
- **Redirect URIs**: `https://<domain>/auth/callback`
- **Users**: managed in Authentik; synced to Canari's `users` table on first login

## Database and backup

The PostgreSQL database (volume `miconnect_database`) contains all Authentik configuration: providers, applications, users, OIDC settings. It is backed up daily by [`infrastructure/backup/backup.sh`](../../infrastructure/backup/backup.sh) as `authentik_db.sql.gz`.

Restore: `./infrastructure/backup/restore.sh --latest-from-mitv --yes` (restores `authentik_db` alongside Canari data).

## See also

- [`services/core-service.md`](../services/core-service.md) — OIDC callback, JWT issuance, auth verification
- [`architecture.md`](../architecture.md) — Auth flow diagram, per-request auth
- [`infrastructure/nginx.md`](nginx.md) — `auth_request` configuration
- [`infrastructure/backup.md`](backup.md) — Backup and restore procedures
- [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) — Server bootstrap and migration
