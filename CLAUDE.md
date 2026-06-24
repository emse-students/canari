# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

**Canari** is a secure messaging platform for EMSE with end-to-end encryption using the
**MLS protocol** (RFC 9420). It is a microservices monorepo with a SvelteKit frontend, a Rust WASM
MLS client, and NestJS/Rust backend services.

### Stack

- **Frontend**: SvelteKit 5 + TailwindCSS 4 + Tauri 2
- **MLS client**: Rust (openmls) compiled to WASM
- **Backend**: 5 services - chat-gateway (Rust/Axum) + chat-delivery, core, media, social (NestJS)
- **Infra**: Docker, PostgreSQL, MongoDB, Redis, Kafka, MinIO

### Repository structure

```
canari/
├── apps/                     # Backend services
│   ├── chat-gateway/         # WebSocket gateway (Rust, port 3000)
│   ├── chat-delivery-service/# MLS API (port 3010)
│   ├── core-service/         # Auth + users + payments (port 3012)
│   ├── media-service/        # Encrypted blobs (port 3011)
│   └── social-service/       # Posts + forms + channels + associations (port 3014)
├── frontend/                 # SvelteKit app + WASM + Tauri
├── libs/                     # Shared code (protobufs, shared types)
├── infrastructure/           # Docker compose + configs
├── docs/                     # Documentation (see "Documentation" below)
└── Makefile                  # Common commands
```

## Documentation

- **`docs/wiki/`** - Technical wiki (English), organised by feature/module. This is the canonical,
  in-progress source of truth for how the system works. Start at `docs/wiki/index.md`.
- **`docs/NORMALIZATION-PLAN.md`** - Master plan and task list for the ongoing normalization effort
  (i18n FR/EN + English wiki + English code comments). Read it before doing normalization work.
- **`docs/`** (top-level topical files) - Older docs, some French, being consolidated into the wiki.
  Living MLS docs are kept: `AUDIT-MLS-2026-06.md`, `MLS_DESYNC_PREVENTION.md`,
  `MLS_RECOVERY_LADDER.md`, `TESTS-DEVICE-PENDING.md`.

## Quick Commands

```bash
# Setup (first time)
./scripts/setup-env.sh      # Generate env files with random secrets
make install                # Install all deps (Node, Bun, Rust, wasm-pack)

# Development
make run-services           # Start Docker services
make reload-services        # Restart services
make reset-services         # Restart + clear DBs
cd frontend && bun run dev  # Frontend dev server -> http://localhost:1420

# Testing
make test                   # All tests (Rust + NestJS + Vitest)
make test-frontend          # Frontend only
make test-gateway           # Rust gateway only
make run-ci                 # Full CI pipeline

# Build
make build-frontend         # WASM + SvelteKit production build

# Frontend lint/format
bun run check               # paraglide:compile + svelte-kit sync + svelte-check (must be 0 errors)
npm run lint:fix            # ESLint auto-fix
npm run format              # Prettier

# Rust (any service)
cargo clippy
cargo test
```

## Architecture

### Nginx routing (source of truth: `infrastructure/local/Dockerfile.frontend`)

Nginx is the single public entry point. It authenticates each protected request via
`auth_request /internal/auth/verify` (calls core-service). On success it injects headers
`X-User-Id`, `X-Logged-In`, `X-Global-Admin`. Full detail in `docs/wiki/architecture.md`.

| Route                       | Upstream            | Auth | Notes                                                             |
| --------------------------- | ------------------- | ---- | ----------------------------------------------------------------- |
| `/api/ws`                   | chat-gateway:3000   | yes  | WebSocket upgrade                                                 |
| `/api/presence`             | chat-gateway:3000   | yes  | Online presence                                                   |
| `/api/mls/*`                | chat-delivery:3010  | yes  | MLS API, device sync, push, Redis history at `/api/mls/history/*` |
| `/api/chat-delivery-health` | chat-delivery:3010  | no   | Liveness probe only -> `GET /api/health` (no JWT)                 |
| `/api/media/*`              | media-service:3011  | yes  | Encrypted blob storage                                            |
| `/api/posts/*`              | social-service:3014 | yes  | Posts, polls, reactions                                           |
| `/api/forms/*`              | social-service:3014 | yes  | Forms with payments                                               |
| `/api/associations/*`       | social-service:3014 | yes  | Associations/Stripe Connect                                       |
| `/api/channels/*`           | social-service:3014 | yes  | Workspaces, channels                                              |
| `/api/auth/*`               | core-service:3012   | no   | OIDC login, refresh, logout                                       |
| `/api/users/*`              | core-service:3012   | yes  | User profiles, search                                             |
| `/api/payments/*`           | core-service:3012   | yes  | Stripe payments                                                   |

### Service summary

- **chat-gateway** (Rust/Axum, 3000): WebSocket routing, presence (Redis `user:online:{userId}:{deviceId}`),
  subscribes to Redis `chat:messages` / `chat:channel_events` and Kafka `post.created`.
- **chat-delivery-service** (NestJS, 3010): ~40-endpoint MLS API (devices, groups, messaging, sync
  engine, push). History via Redis Streams (`history:{groupId}`).
- **core-service** (NestJS, 3012): OIDC auth via Authentik (JWT HS256, 15 min) + refresh cookie (7 d);
  user profiles/search; Stripe payments.
- **social-service** (NestJS, 3014): Markdown posts (polls, reactions, comments); channels (role-based,
  HKDF-derived keys, server-assisted encryption); dynamic forms with optional Stripe payments.

### Key patterns

- **MLS**: all encryption/decryption in WASM (openmls); server stores only ciphertexts. Keys derived
  per epoch (forward secrecy via epoch transitions). Device sync uses ECDH key exchange (SyncEngine).
- **Auth**: access token in memory only (never localStorage); refresh token in HttpOnly cookie;
  WebSocket auth via cookie `canari_ws_token`.
- **Media**: client generates a CEK (AES-256-GCM) before upload; key travels in the MLS ciphertext;
  media-service sees only opaque blobs.

## Critical Do's and Don'ts

1. **Never modify MLS encryption keys manually** - breaks all DMs.
2. **Don't add new API routes without updating the Nginx config** - they won't be reachable.
3. **Always rebuild WASM after changes** to `frontend/mls-core/` or `mls-wasm/`.
4. **Regenerate protobuf bindings** after changes to `libs/proto/canari.proto` (`npm run proto:gen`).
5. **No localStorage for tokens** - use memory stores.
6. **Keep `infrastructure/MIGRATION.md` in sync** - update it whenever the new-server procedure changes
   (a GitHub secret added/renamed, a service/stack added to CD, backup/offsite setup changed, a
   bootstrap step added/removed). It is the source of truth for cloning the server.

## Environment

```bash
./scripts/setup-env.sh    # Generates .env files with random secrets
```

Key env vars: `JWT_SECRET` (strong random, `openssl rand -hex 32`), `POSTGRES_PASSWORD`, `DOMAIN`
(production), `FRONTEND_URL`, `AUTHENTIK_*` (auth integration).

## Testing

- **Rust**: `cargo test` (tarpaulin for coverage if installed)
- **NestJS**: `npm test -- --coverage` (Jest)
- **Frontend**: `vitest` with `happy-dom`

**Changing a file usually means changing its test.** When you modify a component, util, or service,
update the associated test in the same change - a stale test assertion (e.g. a translated log string
or a renamed key) will fail CI.

## Files to Read First

1. `README.md` - Quick start
2. This file - Architecture overview and rules
3. `docs/wiki/index.md` - Technical wiki entry point
4. `Makefile` - Available commands
5. `infrastructure/local/Dockerfile.frontend` - Nginx config (source of truth)
6. `apps/chat-gateway/src/main.rs` - Gateway entry
7. `apps/chat-delivery-service/src/app.controller.ts` - Full MLS API surface

## Non-Negotiable Code Quality Rules

These apply to every file, every function, every PR - no exceptions.

### Logs

Always add debug logs in new code:

- Kotlin: `Log.d(TAG, "…")`
- TypeScript: `appendLog("…")` (chat/session code) or `console.log(…)` (elsewhere)
- Rust: `log::debug!(…)` or `eprintln!(…)` for Android JNI

Logs must be present at: function entry for non-trivial paths, after key decisions, and on every
error/fallback branch. They are essential for diagnosing issues on real devices where a debugger is
unavailable.

### Factorisation

- Export the maximum - functions, types, constants. If it could be reused, export it.
- Never duplicate logic. Before writing something a second time, extract it to a composable / util /
  shared function.
- No two mechanisms that do the same thing. Consolidate before adding.

### Documentation and comments

Every exported function, class, interface, and non-trivial constant must have a JSDoc comment
(TypeScript/JavaScript) or a doc comment (Rust `///`, Kotlin `/**`). Match the existing style.

Write:

- **What** the thing does (one sentence is enough for simple functions).
- **Why** it exists or works a certain way, when non-obvious.
- Key constraints, side-effects, or invariants that would surprise a reader.

Do not write:

- Restatements of the type signature ("Takes a string and returns a boolean").
- References to the current task, issue number, or callers.
- Temporal language ("added for…", "now handles…").

Inline comments (`//`) inside function bodies: only for non-obvious logic, workarounds, or subtle
invariants. Not for every line.

**Language**: all comments (`//`, `/* */`, `/** */`, Rust `///`) **and all developer-facing string
literals** (`console.log`, `console.error`, `log::debug!`, `eprintln!`, internally thrown error
messages) must be **English** - no French, no mixed languages. Concise but complete enough for a
language model to grasp the intent. User-visible strings go through Paraglide i18n (FR and EN), never
inline string literals.

### Text characters (apostrophes, quotes, dashes)

Normalize all text to ASCII characters from the French keyboard, everywhere (code, visible strings,
comments, documentation, translation files):

- Straight apostrophe `'` - never a curly apostrophe (`'` U+2019, `'` U+2018).
- Straight quote `"` - never a curly quote (`"` U+201C, `"` U+201D) nor French guillemets
  (`«` U+00AB, `»` U+00BB).
- Hyphen `-` - never an em dash (`—` U+2014) nor an en dash (`–` U+2013).
- **Exception**: the ellipsis character `…` is intentionally kept everywhere.

In code, escape an apostrophe inside a single-quoted string as `\'`, and a quote inside a
double-quoted string as `\"` - never reintroduce a typographic character to avoid escaping.

This rule applies to every file in the project (TypeScript, Svelte, Rust, Kotlin, Markdown,
translation JSON). It avoids encoding divergence and keeps text consistent and searchable.

## General Coding Behavior

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, and ask.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No flexibility or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it (unless asked).
- Remove imports/variables/functions that YOUR changes made unused.

The test: every changed line should trace directly to the request.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

- "Add validation" -> "Write tests for invalid inputs, then make them pass".
- "Fix the bug" -> "Write a test that reproduces it, then make it pass".
- "Refactor X" -> "Ensure tests pass before and after".

For multi-step tasks, state a brief plan with a verification step each, and loop until it holds.
