# Authentik (OIDC provider)

**Stack**: Authentik (Docker Compose, project name `miconnect`)  
**Source**: `infrastructure/authentik/compose.yml`

Canari uses Authentik as its OpenID Connect identity provider. Authentik is deployed as a separate Docker Compose stack alongside the main application stack.

## The box, and the log that settles an OIDC question

Authentik does NOT run on `canari`. It is its own host, reached as **`ssh miconnect`** (via
ProxyJump through `canari`, so PowerShell and not Bash - see
[databases](databases.md#reaching-it-from-a-workstation)). Its containers are `miconnect-server-1`,
`miconnect-worker-1` and `miconnect-postgresql-1`.

**`docker logs miconnect-server-1` is an ACCESS LOG**, and it is the instrument for any question
about a login that failed on a client you cannot attach a debugger to. Every
`/application/o/authorize/` appears with its status, its `redirect_uri` and the client's
`user_agent` - which is what proved the iPad defect
([mobile](../frontend/mobile.md#the-ipad-that-called-itself-a-macintosh-and-the-login-app-review-could-not-finish)):
one `status 400` carrying `tauri://localhost/auth/callback` from a user agent calling itself
`Macintosh`. Read it before theorising about a client-side branch.

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

## Login page branding

`infrastructure/authentik/custom-login.css` is the versioned source of truth for the login flow's
custom CSS. Authentik has no mechanism to load this from a file or a repo path - it must be pasted
manually into the admin UI (System -> Brands -> the Canari brand -> "Custom CSS") after any edit,
and the field itself lives only in Authentik's Postgres DB, so a change made only there and never
copied back here is one lost/stale backup away from disappearing silently.

Two failure modes worth knowing before touching it again: a `z-index: -1` decorative element needs
its parent to actually establish a stacking context (`isolation: isolate`, not just
`position: relative`) or it paints behind the whole page instead of just behind its own sibling;
and an external `@import` (e.g. Google Fonts) can silently no-op under Authentik's default CSP,
which blocks it - self-hosting is the fix if an exact custom font is needed.

## Database and backup

The PostgreSQL database (volume `miconnect_database`) contains all Authentik configuration: providers, applications, users, OIDC settings. It is backed up daily by [`infrastructure/backup/backup.sh`](../../../infrastructure/backup/backup.sh) as `authentik_db.sql.gz`.

Restore: `./infrastructure/backup/restore.sh --latest-from-mitv --yes` (restores `authentik_db` alongside Canari data).

**THE USER COUNT IS A LIVE POPULATION AND IS NEVER EVIDENCE OF ANYTHING.** Two readings taken hours
apart on 2026-09-02 gave 465 and then 511, which was chased as a discrepancy after two test accounts
were created; a third gave 517. There is **no LDAP source** (`LDAPSource.objects.all()` is empty) -
real people are enrolling continuously, several in the hour that was measured. So a count is a
snapshot of something moving: compare identities, never totals, and if a total must be quoted, quote
the instant with it. Every account is `type=internal` (`external` and `service_account` are both
zero, with one `internal_service_account`), which is why the campaign's dedicated accounts had to be
`internal` too - see [cross-client-campaign-resume](../cross-client-campaign-resume.md).

## See also

- [`services/core-service.md`](../services/core-service.md) — OIDC callback, JWT issuance, auth verification
- [`architecture.md`](../architecture.md) — Auth flow diagram, per-request auth
- [`infrastructure/nginx.md`](nginx.md) — `auth_request` configuration
- [`infrastructure/backup.md`](backup.md) — Backup and restore procedures
- [`infrastructure/MIGRATION.md`](../../../infrastructure/MIGRATION.md) — Server bootstrap and migration
