# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Canari** is a secure messaging platform for EMSE with end-to-end encryption using the **MLS protocol** (RFC 9420). It's a microservices monorepo with SvelteKit frontend, Rust WASM client, and NestJS/Rust backend services.

### Stack
- **Frontend**: SvelteKit 5 + TailwindCSS 4 + Tauri 2
- **MLS Client**: Rust (openmls) compiled to WASM
- **Backend**: 5 services - chat-gateway (Rust/Axum), chat-delivery, core, media, social (all NestJS)
- **Infra**: Docker, PostgreSQL, MongoDB, Redis, Kafka, MinIO

### Repository Structure
```
canari/
├── apps/                     # Backend services
│   ├── chat-gateway/         # WebSocket gateway (port 3000)
│   ├── chat-delivery-service/# MLS API (port 3010)
│   ├── core-service/         # Auth + users + payments (port 3012)
│   ├── media-service/        # Encrypted blobs (port 3011)
│   └── social-service/       # Posts + channels (port 3014)
├── frontend/                 # SvelteKit app + WASM + Tauri
├── libs/                     # Shared code (protobufs, shared types)
├── infrastructure/           # Docker compose + configs
├── docs/                     # Architecture docs (some outdated - see below)
└── Makefile                  # Common commands
```

## Quick Commands

```bash
# Setup (first time)
./scripts/setup-env.sh      # Generate env files
make install                # Install all deps (Node, Bun, Rust, wasm-pack)

# Development
make run-services           # Start Docker services
make reload-services        # Restart services
make reset-services         # Restart + clear DBs

cd frontend && bun run dev  # Frontend dev server → http://localhost:1420

# Testing
make test                   # All tests (Rust + NestJS + Vitest)
make test-frontend          # Frontend only
make test-gateway           # Rust gateway only
make run-ci                 # Full CI pipeline

# Build
make build-frontend         # WASM + SvelteKit production build

# Lint/Format (frontend)
npm run check               # svelte-check + TypeScript
npm run lint:fix            # ESLint auto-fix
npm run format              # Prettier

# Rust (any service)
cargo clippy
cargo test
```

## Architecture

### Nginx Routing (source of truth: `infrastructure/local/Dockerfile.frontend`)

| Route | Upstream | Auth | Notes |
|-------|----------|------|-------|
| `/api/ws` | chat-gateway:3000 | ✅ | WebSocket upgrade |
| `/api/presence` | chat-gateway:3000 | ✅ | Online presence |
| `/api/mls/*` | chat-delivery:3010 | ✅ | MLS API, device sync, push, Redis history at `/api/mls/history/*` |
| `/api/chat-delivery-health` | chat-delivery:3010 | ❌ | Liveness probe only → `GET /api/health` (no JWT) |
| `/api/media/*` | media-service:3011 | ✅ | Encrypted blob storage |
| `/api/posts/*` | social-service:3014 | ✅ | Posts, polls, reactions |
| `/api/forms/*` | social-service:3014 | ✅ | Forms with payments |
| `/api/associations/*` | social-service:3014 | ✅ | Associations/Stripe Connect |
| `/api/channels/*` | social-service:3014 | ✅ | Workspaces, channels |
| `/api/auth/*` | core-service:3012 | ❌ | OIDC login, refresh, logout |
| `/api/users/*` | core-service:3012 | ✅ | User profiles, search |
| `/api/payments/*` | core-service:3012 | ✅ | Stripe payments |

**Auth Flow**: Nginx uses `auth_request /internal/auth/verify` which calls core-service. On success, it injects headers `X-User-Id`, `X-Logged-In`, `X-Global-Admin`.

### Service Details

#### Chat Gateway (Rust/Axum, port 3000)
- **Routes**: `GET /api/ws` (WebSocket), `GET /api/presence`, `GET /api/health`
- **Pub/Sub**: Subscribes to Redis `chat:messages`, `chat:channel_events`; Kafka `post.created`
- **Function**: Routes WebSocket frames, manages presence (Redis key `user:online:{userId}:{deviceId}`)

#### Chat Delivery Service (NestJS, port 3010)
- Large API surface (~40 endpoints) for MLS operations
- **Key areas**: Device management, group management, messaging, sync engine, push notifications
- **History**: Uses Redis Streams (`history:{groupId}`)

#### Core Service (NestJS, port 3012)
- **Auth**: OIDC via Authentik; issues JWT HS256 tokens (15min) + refresh cookie (7d)
- **Users**: Profile management, search, avatar proxy
- **Payments**: Stripe integration (onboarding, checkout, webhooks)

#### Social Service (NestJS, port 3014)
- **Posts**: Markdown posts with polls, reactions, comments
- **Channels**: Workspaces with role-based access, HKDF-derived keys (server-assisted encryption)
- **Forms**: Dynamic forms with optional Stripe payments

## Key Patterns

### MLS Protocol

- All encryption/decryption happens in WASM (openmls)
- Server stores only encrypted blobs (`/api/mls/send`)
- Keys derived per epoch; forward secrecy via MLS epoch transitions
- Device sync uses ECDH key exchange (SyncEngine)

### Auth

- Access token in memory only (never localStorage)
- Refresh token in HttpOnly cookie
- WebSocket auth via cookie `canari_ws_token`

### Media Encryption
- Client generates CEK (AES-256-GCM) before upload
- Media-service stores only encrypted blobs
- Key travels in MLS ciphertext (server never sees plaintext)

## Critical Do's and Don'ts

1. **Never modify MLS encryption keys manually** - breaks all DMs
2. **Don't add new API routes without updating Nginx config** - they won't be accessible
3. **Always rebuild WASM after changes** to `frontend/mls-core/` or `mls-wasm/`
4. **Regenerate protobuf bindings** after changes to `libs/proto/canari.proto` (`npm run proto:gen`)
5. **No localStorage for tokens** - use memory stores

## Documentation Status

**Outdated docs requiring updates:**
- `docs/ARCHITECTURE.md` - Routing table needs correction: remove `/api/groups`, add `/api/presence` and `/api/associations/*`, fix auth flags for media/channels/users
- `docs/CHAT_GATEWAY.md` - Remove sections about `/api/groups` HTTP routes (never implemented)
- `docs/MLS.md` - Endpoint table is incomplete; see `apps/chat-delivery-service/src/app.controller.ts` for full list

**Accurate reference:**
- `infrastructure/local/Dockerfile.frontend` - Nginx routing rules
- `apps/chat-gateway/src/main.rs` - Actual gateway routes (only `/api/ws`, `/api/presence`)
- `apps/chat-delivery-service/src/app.controller.ts` - Full MLS API surface

## Environment Setup

```bash
./scripts/setup-env.sh    # Generates .env files with random secrets
```

Key env vars:
- `JWT_SECRET` - Must be strong random (generate: `openssl rand -hex 32`)
- `POSTGRES_PASSWORD`, `DOMAIN` - For production
- `FRONTEND_URL`, `AUTHENTIK_*` - For auth integration

## Testing

- **Rust**: `cargo test` (with tarpaulin for coverage if installed)
- **NestJS**: `npm test -- --coverage` (Jest)
- **Frontend**: `vitest` with `happy-dom`

## Files to Read First

1. `README.md` - Quick start
2. This file (CLAUDE.md) - Architecture overview
3. `Makefile` - Available commands
4. `infrastructure/local/Dockerfile.frontend` - Nginx config (source of truth)
5. `apps/chat-gateway/src/main.rs` - Gateway entry
6. `apps/chat-delivery-service/src/app.controller.ts` (for full MLS API list)


## General Coding Behavior and Guidelines

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
