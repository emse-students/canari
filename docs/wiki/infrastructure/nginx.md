# Nginx routing

**Source of truth**: `infrastructure/local/Dockerfile.frontend`

## Overview

Nginx is the sole public HTTP entry point. It runs inside the `frontend` Docker image alongside the SvelteKit build assets. In production, Cloudflare Tunnel forwards to `http://localhost:8080` -> Nginx:80.

It no longer serves the app shell on the happy path: HTML navigations go to `frontend-ssr`, see [SSR head](#html-navigations-go-to-frontend-ssr). It keeps a prerendered shell to fall back on when that container is unreachable.

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
| `/_app/immutable/*`, `/.well-known/*`, `*.mjs`, other assets | static | no | Served from `build/client` + `build/prerendered` inside the image |
| `/*` (HTML) | `frontend-ssr:3000` | no | Named `@ssr` location, reached via `try_files $uri $uri/ @ssr`; falls back to `@app_shell` on 5xx |

## Adding a new route

When adding a new API route:
1. Add the `location` block in `infrastructure/local/Dockerfile.frontend`.
2. Decide whether it needs `auth_request` (most routes do).
3. Add `proxy_set_header X-User-Id $upstream_http_x_user_id;` if the upstream needs the user ID.
4. Update the route table in `docs/wiki/architecture.md` and `CLAUDE.md`.

Skipping step 1 means the route will be unreachable from outside Docker, even if the service implements it.

## HTML navigations go to `frontend-ssr`

`location /` is `try_files $uri $uri/ @ssr`: anything that exists on disk is served by Nginx with
its usual cache headers, and everything else - i.e. every page URL - is proxied to the SvelteKit
`adapter-node` server in the `frontend-ssr` container.

That server renders **no component**. The app is still a SPA (`ssr = false`); the server exists so
that `frontend/src/hooks.server.ts` can write the page's Open Graph tags into the shell before it
is sent. Nothing else can: an unfurler or a crawler never runs the client, so before this every
shared Canari link previewed as the bare `app.html`.

The two images are built from one artifact and deployed together (`cd.yml` rebuilds both whenever
either changes) - deploying only one ships an nginx whose assets do not match the server's.

### When `frontend-ssr` is down: `@app_shell`

`adapter-node` emits no `index.html`, so at first there was nothing to answer with and a dead
`frontend-ssr` meant a 502 on **every** navigation - the entire site, to spare a `<head>`. The app
is a SPA and needs no server at all to run, so that trade was wrong.

`frontend/src/routes/app-shell/` is prerendered to `build/prerendered/app-shell.html`: a plain
shell that boots the SPA on whatever URL was requested (`kit.start(app, element)` with no route
data, exactly like the static build's fallback). `@ssr` carries `error_page 502 503 504
@app_shell`, and `@app_shell` is `try_files /app-shell.html =502`.

Two details that are the whole point:

- **No `=` on that `error_page`.** With `=` the response would be 200; without it the original
  5xx is preserved while the body is the shell. A browser runs the scripts of a 5xx body, so a
  person gets a working app - but a crawler gets a status it will retry, instead of a 200 carrying
  `noindex`, which is a request to *deindex* the page.
- The response carries `X-Canari-Degraded: ssr-unavailable` and `Cache-Control: no-store`, so the
  outage is greppable in the access log and nothing caches the degraded answer.

What is lost while degraded is exactly the per-page `<head>`: the bonus the SSR container adds.
The outage stays visible through that container's healthcheck in `docker compose ps`.

Assets deliberately stay on Nginx rather than going through Node: they keep the proven
`immutable` caching, the `.well-known` content type and the `.mjs` `default_type` fix, and the
Node process only ever handles the small number of HTML requests.

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
