# Canari — Technical Wiki

> **Status**: work in progress — built incrementally alongside the i18n / normalization pass.
> Language: English (all technical documentation).
> Audience: developers, LLMs, contributors.

## Table of contents

### Architecture

- [Architecture overview](architecture.md) — service topology, Nginx routing, auth flow

### Backend services

- [chat-gateway](services/chat-gateway.md) — Rust/Axum WebSocket gateway, Redis pub/sub, Kafka
- [chat-delivery-service](services/chat-delivery.md) — NestJS MLS API, message queue, sync engine
- [core-service](services/core-service.md) — OIDC auth (Authentik), users, Stripe payments
- [media-service](services/media-service.md) — Encrypted blob storage (MinIO)
- [social-service](services/social-service.md) — Posts, channels, associations, forms

### Frontend

- [Frontend architecture](frontend/architecture.md) — SvelteKit 5, stores, routing, Paraglide i18n
- [MLS WASM client](frontend/mls-wasm.md) — openmls compiled to WASM, key management, sync engine
- [Auth module](frontend/modules/auth.md) — Login flow, PIN, biometrics, device registration
- [Chat module](frontend/modules/chat.md) — Conversations, groups, channels, communities
- [Associations module](frontend/modules/associations.md) — Club management, members, calendar, shop, documents
- [Forms module](frontend/modules/forms.md) — Form builder, submissions, cash/Stripe payments
- [Calendar module](frontend/modules/calendar.md) — Events, ICS export, global calendar
- [Posts module](frontend/modules/posts.md) — Feed, polls, reactions, comments
- [Payments module](frontend/modules/payments.md) — Stripe Connect, products, shop
- [Admin module](frontend/modules/admin.md) — Dashboard, moderation, platform config

### Infrastructure

- [Docker & services](infrastructure/docker.md) — Docker Compose setup, service dependencies
- [Nginx routing](infrastructure/nginx.md) — Route table (source of truth), auth_request
- [Databases](infrastructure/databases.md) — PostgreSQL, MongoDB, Redis, MinIO
- [Kafka](infrastructure/kafka.md) — Topics, producers, consumers
- [Backup system](infrastructure/backup.md) — Daily cron, offsite rsync

### Features

- [Cotisations](cotisations.md) — Membership dues: cotisant tags, boutique products, form member pricing

### Protocols

- [MLS protocol](mls-protocol.md) — RFC 9420 integration, epochs, forward secrecy, device sync
- [API surface](api-surface.md) — Full endpoint list across all services

---

## Quick reference

| Concern | Where to look |
|---|---|
| Nginx routing (source of truth) | `infrastructure/local/Dockerfile.frontend` |
| Gateway routes | `apps/chat-gateway/src/main.rs` |
| Full MLS API | `apps/chat-delivery-service/src/app.controller.ts` |
| i18n messages | `frontend/messages/fr.json` (source), `en.json` |
| Environment setup | `scripts/setup-env.sh` |
| Available commands | `Makefile` |
