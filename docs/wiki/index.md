# Canari — Technical Wiki

> Language: English (all technical documentation).
> Audience: developers, LLMs, contributors.

## Table of contents

### Architecture

- [Architecture overview](architecture.md) — service topology, Nginx routing, auth flow
- [Shared libraries](libs.md) — proto, shared-rust (Kafka events), shared-ts
- [Glossary](glossary.md) — acronyms and terminology

### Protocols

- [MLS protocol](protocols/mls-protocol.md) — RFC 9420 integration, epochs, forward secrecy, device sync
- [MLS desync prevention](protocols/mls-desync-prevention.md) — Server + client tactics to avoid state drift
- [MLS recovery ladder](protocols/mls-recovery-ladder.md) — Step-by-step recovery (commit replay → external join → welcome_request)
- [WebSocket binary protocol](protocols/websocket-protocol.md) — protobuf wire format, AppMessage, MlsFrame
- [API surface](protocols/api-surface.md) — Full endpoint list across all services

### Backend services

- [chat-gateway](services/chat-gateway.md) — Rust/Axum WebSocket gateway, Redis pub/sub, Kafka
- [call-service](services/call-service.md) — Rust/Axum WebRTC SFU, Cloudflare TURN
- [chat-delivery-service](services/chat-delivery.md) — NestJS MLS API, message queue, sync engine, push
- [core-service](services/core-service.md) — OIDC auth (Authentik), users, Stripe payments
- [media-service](services/media-service.md) — Encrypted blob storage (MinIO)
- [social-service](services/social-service.md) — Posts, channels, associations, forms

### Frontend

- [Frontend architecture](frontend/architecture.md) — SvelteKit 5, stores, routing, Paraglide i18n
- [Mobile architecture](frontend/mobile.md) — Tauri 2, iOS NSE, Android push, native FFI
- [MLS WASM client](frontend/mls-wasm.md) — openmls compiled to WASM, key management, sync engine
- [Auth module](frontend/modules/auth.md) — Login flow, PIN, biometrics, device registration
- [Chat module](frontend/modules/chat.md) — Conversations, groups, channels, communities
- [Calls module](frontend/modules/calls.md) — WebRTC audio/video calls, CallKit, SFU relay
- [Associations module](frontend/modules/associations.md) — Club management, members, calendar, shop, documents
- [Forms module](frontend/modules/forms.md) — Form builder, submissions, cash/Stripe payments
- [Calendar module](frontend/modules/calendar.md) — Events, ICS export, global calendar
- [Posts module](frontend/modules/posts.md) — Feed, polls, reactions, comments
- [Payments module](frontend/modules/payments.md) — Stripe Connect, products, shop
- [Admin module](frontend/modules/admin.md) — Dashboard, moderation, platform config

### Infrastructure

- [Docker & services](infrastructure/docker.md) — Docker Compose setup, service dependencies
- [Nginx routing](infrastructure/nginx.md) — Route table (source of truth), auth_request
- [Authentik (OIDC)](infrastructure/authentik.md) — Identity provider, OIDC flow, deployment
- [Databases](infrastructure/databases.md) — PostgreSQL, MongoDB, Redis, MinIO
- [Kafka](infrastructure/kafka.md) — Topics, producers, consumers
- [Backup system](infrastructure/backup.md) — Daily cron, offsite rsync

### Features

- [Cotisations](cotisations.md) — Membership dues: cotisant tags, boutique products, form member pricing
- [Carte de la Vie Asso](carte-vie-asso.md) — Editable poster generator (drag & drop canvas, PDF export)

### Development & operations

- [Development workflow](development.md) — Local setup, Makefile, Docker Compose, pre-commit hooks
- [CI/CD pipeline](cicd.md) — GitHub Actions, mobile builds, releases, self-hosted runner

---

## Quick reference

| Concern | Where to look |
|---|---|
| Nginx routing (source of truth) | [`infrastructure/local/Dockerfile.frontend`](../infrastructure/local/Dockerfile.frontend) |
| Gateway routes | [`apps/chat-gateway/src/main.rs`](../apps/chat-gateway/src/main.rs) |
| Full MLS API | [`apps/chat-delivery-service/src/app.controller.ts`](../apps/chat-delivery-service/src/app.controller.ts) |
| i18n messages | [`frontend/messages/fr.json`](../frontend/messages/fr.json) (source), `en.json` |
| Environment setup | `scripts/setup-env.sh` |
| Available commands | `Makefile` |
| Server bootstrap | [`infrastructure/MIGRATION.md`](../infrastructure/MIGRATION.md) |
| Protobuf schema | [`libs/proto/canari.proto`](../libs/proto/canari.proto) |
| Shared event types | [`libs/shared-rust/src/lib.rs`](../libs/shared-rust/src/lib.rs) |
