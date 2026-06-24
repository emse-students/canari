# Architecture overview

## Service topology

Canari is a microservices monorepo. The only public entry point is **Nginx** (bundled in the `frontend` Docker image), which acts as a reverse proxy and authentication gateway via `auth_request`.

In production, Cloudflare Tunnel exposes `http://localhost:8080`, which forwards to Nginx on port 80 of the frontend container.

| Service | Stack | Port | Database | Role |
|---|---|---|---|---|
| **frontend** (Nginx) | Nginx + SvelteKit static | 80 | - | Single HTTP entry point, reverse proxy |
| **chat-gateway** | Rust / Axum / Tokio | 3000 | Redis | Real-time WebSocket, MLS routing, presence |
| **chat-delivery-service** | NestJS | 3010 | PostgreSQL + Redis | MLS API, offline queue, Redis Stream history |
| **media-service** | NestJS | 3011 | MinIO | E2EE encrypted blob storage |
| **core-service** | NestJS | 3012 | PostgreSQL | OIDC auth (Authentik), users, Stripe payments |
| **social-service** | NestJS | 3014 | PostgreSQL + MongoDB | Posts, forms, channels/communities, associations |
| Redis | - | 6379 | - | Presence, pub/sub, history streams |
| Kafka | Confluent 7.5 | 9092 / 29092 | - | Async event bus |
| PostgreSQL | - | 5432 | `auth_db` | Relational data |
| MongoDB | - | 27017 | `chat_db` | Posts and document data |
| MinIO | - | 9000 / 9001 | - | Media blobs (S3-compatible) |
| Coturn | - | 3478 / 5349 | - | STUN/TURN WebRTC (local dev only; production uses Cloudflare TURN) |

## Nginx routing

Nginx is the sole HTTP entry point. It authenticates every protected request via `auth_request /internal/auth/verify`, which calls `core-service:3012/api/auth/verify` internally. On success, Nginx injects headers `X-User-Id`, `X-Logged-In`, `X-Global-Admin` into the upstream request.

**Source of truth**: `infrastructure/local/Dockerfile.frontend`

| Public route | Upstream | Auth | Notes |
|---|---|---|---|
| `/api/ws` | `chat-gateway:3000` | yes | WebSocket upgrade, token cookie |
| `/api/presence` | `chat-gateway:3000` | yes | Online presence (Redis) |
| `/api/admin/presence` | `chat-gateway:3000` | yes | Admin presence view |
| `/api/mls/*` | `chat-delivery-service:3010` | yes | MLS API (messages, groups, sync, push); Redis history at `/api/mls/history/*` |
| `/api/chat-delivery-health` | `chat-delivery-service:3010` | no | Liveness probe only |
| `/api/media/*` | `media-service:3011` | yes | Encrypted blobs (MinIO) |
| `/api/posts/*` | `social-service:3014` | yes | News feed |
| `/api/forms/*` | `social-service:3014` | yes | Forms with payments |
| `/api/associations/*` | `social-service:3014` | yes | Clubs (Stripe Connect) |
| `/api/channels/*` | `social-service:3014` | yes | Workspaces and channels |
| `/api/auth/*` | `core-service:3012` | no | OIDC login, refresh, logout |
| `/api/users/*` | `core-service:3012` | yes | User profiles, search |
| `/api/payments/*` | `core-service:3012` | yes | Stripe (checkout, webhooks) |

## Auth flow

1. Browser sends request to Nginx.
2. Nginx calls `auth_request /internal/auth/verify` (internal only, never public).
3. `core-service` validates the JWT (HS256, 15-min TTL) from the `Authorization: Bearer` header or the `canari_ws_token` cookie (WebSocket).
4. On success: Nginx injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` and forwards to the upstream service.
5. On failure (401): Nginx returns 401 directly; the frontend redirects to login.

Access token lives in memory only (never localStorage). Refresh token is an HttpOnly cookie (7-day TTL).

## Inter-service communication

Services communicate through:
- **Redis pub/sub**: `chat:messages`, `chat:channel_events` — chat-gateway subscribes, chat-delivery-service publishes.
- **Kafka**: `post.created` topic — social-service publishes, chat-gateway consumes and broadcasts to all WebSocket clients.
- **Direct HTTP** (internal Docker network, not through Nginx): e.g. chat-delivery-service calling core-service for user verification.

## Key design decisions

- **Single Nginx entry point**: all services are private; only Nginx is exposed. This centralises auth and simplifies firewall rules.
- **MLS encryption in WASM**: all encryption/decryption happens client-side. The server stores only ciphertexts.
- **Media encryption**: client generates a CEK (AES-256-GCM) before upload; key travels in the MLS ciphertext. The media-service sees only opaque blobs.
- **At-least-once delivery**: Kafka consumer in chat-gateway commits offsets only after successful delivery attempts.
