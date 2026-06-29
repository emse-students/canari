# Nginx routing

**Source of truth**: `infrastructure/local/Dockerfile.frontend`

## Overview

Nginx is the sole public HTTP entry point. It runs inside the `frontend` Docker image alongside the SvelteKit static bundle. In production, Cloudflare Tunnel forwards to `http://localhost:8080` -> Nginx:80.

Every protected request goes through `auth_request /internal/auth/verify`, which calls `core-service:3012/api/auth/verify` internally. On success, Nginx injects three headers into the upstream request:

| Header | Value | Description |
|---|---|---|
| `X-User-Id` | OIDC sub | Authenticated user ID |
| `X-Logged-In` | `true` | Auth confirmation |
| `X-Global-Admin` | `true` / `false` | Global admin flag |

## Route table

| Public route | Upstream | Auth | Notes |
|---|---|---|---|
| `/api/ws` | `chat-gateway:3000` | yes | WebSocket upgrade, token from `canari_ws_token` cookie |
| `/api/presence` | `chat-gateway:3000` | yes | Online presence (Redis) |
| `/api/admin/presence` | `chat-gateway:3000` | yes | Admin view of connected devices |
| `/api/mls/*` | `chat-delivery-service:3010` | yes | MLS API; Redis history at `/api/mls/history/*` |
| `/api/chat-delivery-health` | `chat-delivery-service:3010` | no | Liveness probe -> `GET /api/health` |
| `/api/media/*` | `media-service:3011` | yes | Encrypted blob storage (MinIO) |
| `/api/posts/*` | `social-service:3014` | yes | News feed |
| `/api/forms/*` | `social-service:3014` | yes | Forms with payments |
| `/api/associations/*` | `social-service:3014` | yes | Clubs (Stripe Connect) |
| `/api/channels/*` | `social-service:3014` | yes | Workspaces and channels |
| `/api/auth/*` | `core-service:3012` | no | OIDC login, refresh, logout |
| `/api/users/*` | `core-service:3012` | yes | User profiles, search |
| `/api/payments/*` | `core-service:3012` | yes | Stripe payments |
| `/internal/auth/verify` | `core-service:3012` | internal | `auth_request` subrequest only — never public |
| `/*` | SvelteKit static bundle | no | Served from `build/` inside the image |

## Adding a new route

When adding a new API route:
1. Add the `location` block in `infrastructure/local/Dockerfile.frontend`.
2. Decide whether it needs `auth_request` (most routes do).
3. Add `proxy_set_header X-User-Id $upstream_http_x_user_id;` if the upstream needs the user ID.
4. Update the route table in `docs/wiki/architecture.md` and `CLAUDE.md`.

Skipping step 1 means the route will be unreachable from outside Docker, even if the service implements it.

## WebSocket specifics

The `/api/ws` location requires these headers for the upgrade:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 86400s;  # keep alive for long-running connections
```

## Auth subrequest

```nginx
auth_request /internal/auth/verify;
auth_request_set $user_id $upstream_http_x_user_id;
auth_request_set $logged_in $upstream_http_x_logged_in;
auth_request_set $global_admin $upstream_http_x_global_admin;

proxy_set_header X-User-Id $user_id;
proxy_set_header X-Logged-In $logged_in;
proxy_set_header X-Global-Admin $global_admin;
```
