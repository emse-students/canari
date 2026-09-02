# Canari — Technical Wiki

> Language: English (all technical documentation).
> Audience: developers, LLMs, contributors.

> **Start here: [Durable rules](durable-rules.md)** — every constraint this codebase has paid for,
> indexed by area. `CLAUDE.md` keeps only the rules that apply to every task and points here for the
> rest. Read the section matching what you are about to touch, before you write anything.

## Table of contents

### Architecture

- [Architecture overview](architecture.md) — service topology, Nginx routing, auth flow
- [Shared libraries](libs.md) — proto
- [Glossary](glossary.md) — acronyms and terminology

### Protocols

- [MLS protocol](protocols/mls-protocol.md) — RFC 9420 integration, epochs, forward secrecy, device sync
- [MLS desync prevention](protocols/mls-desync-prevention.md) — Server + client tactics to avoid state drift
- [MLS recovery ladder](protocols/mls-recovery-ladder.md) — Step-by-step recovery (commit replay → external join → welcome_request)
- [Channel encryption](protocols/channel-encryption.md) — **DESIGNED, NOT SHIPPED.** Why a salon is not an MLS group, and the sealed epoch key that replaces the server-held secret
- [WebSocket binary protocol](protocols/websocket-protocol.md) — protobuf wire format, AppMessage, MlsFrame
- [API surface](protocols/api-surface.md) — Full endpoint list across all services

### Backend services

- [chat-gateway](services/chat-gateway.md) — Rust/Axum WebSocket gateway, Redis pub/sub
- [call-service](services/call-service.md) — Rust/Axum WebRTC SFU, Cloudflare TURN
- [chat-delivery-service](services/chat-delivery.md) — NestJS MLS API, message queue, sync engine, push
- [core-service](services/core-service.md) — OIDC auth (Authentik), users, Stripe payments
- [media-service](services/media-service.md) — Encrypted blob storage (Garage)
- [social-service](services/social-service.md) — Posts, channels, associations, forms
- [NestJS framework](services/nestjs-framework.md) — which major each of the four services runs, why they differ, and what an ESM-only framework did to jest
- [Reporting and blocking](moderation-and-blocking.md) — the one report store, and what a block does and does not close

### Frontend

- [Frontend architecture](frontend/architecture.md) — SvelteKit 5, stores, routing, Paraglide i18n
- [Mobile architecture](frontend/mobile.md) — Tauri 2, iOS NSE, Android push, native FFI
- [Android / iOS parity audit](frontend/android-ios-parity.md) - where the two native projects DISAGREE, read from source 2026-08-28
- [MLS WASM client](frontend/mls-wasm.md) — openmls compiled to WASM, key management, sync engine
- [Backup and restore](frontend/backup.md) — the `.canari` file, and why a refusal is a code rather than a sentence
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
- [Databases](infrastructure/databases.md) — PostgreSQL, Redis, Garage
- [Backup system](infrastructure/backup.md) — Daily cron, offsite rsync
- [Dev environment](infrastructure/dev-environment.md) — `dev.canari-emse.fr`: what keeps it apart from production, the full copy and its three strips, the declared version gap, and the one kind of evidence that lifts a merge ceiling
- [Storage forecast](infrastructure/storage-forecast.md) — Measured unit costs, the model at 400 daily users, and why the backup scheme fails before the data does

### Features

- [Sessions, in every application](sessions.md) — The session model shared by Canari, Sky, MiGallery and Le Cercle: opaque token, rotation, replay, impersonation
- [Association permissions](association-permissions.md) — The eleven flags measured from their call sites, the one predicate answering "may this user act here", and the two tiers above a member
- [Cotisations](cotisations.md) — Membership dues: cotisant tags, boutique products, form member pricing
- [Carte de la Vie Asso](carte-vie-asso.md) — Editable poster generator (drag & drop canvas, PDF export)

### Development & operations

- [Durable rules](durable-rules.md) — the constraints, grouped by area, each linked to the page carrying its reasoning
- [The 2026-09-02 workflow migration](workflow-migration.md) — main-only, deploy at the bump, pull requests, local development, `-alpha.N` pre-releases: the decisions, the measurements, the ordered checklist
- [Ecosystem convergence](ecosystem-convergence.md) — The five projects measured side by side: tolerant search, outbound deadlines, the locale under SSR, the head, typed errors, the gates
- [The search contract](search-contract.md) — What every search box in the ecosystem promises, the tolerance ladder, and the roster measurement that chose its numbers
- [Development workflow](development.md) — Local setup, Makefile, Docker Compose, pre-commit hooks
- [CI/CD pipeline](cicd.md) — GitHub Actions, mobile builds, releases, self-hosted runner
- [Device verification runbook](device-verification.md) — The ordered Android + iOS pass: what compiling never proves, and the log line that is the verdict for each check
- [Testing methodology](testing-methodology.md) — How a result earns belief: the harness faults distilled into rules, plus the environment traps that read as application bugs
- [Mechanism audit](mechanism-audit.md) - What every part of the app is covered by, measured across the board, the unit tests and the hand pass - and the five things nothing watches
- [Cross-client testing](cross-client-testing.md) — The campaign board, state only: every check, its verdict, and the commit it ran on
- [Cross-client campaign](cross-client-campaign.md) — The campaign's design: the ladder, what it is allowed to contain, the standing rules, the preflight, and what does NOT exist
- [Resuming the cross-client campaign](cross-client-campaign-resume.md) — The delta since the 2026-08-30 pause and the ordered restart: what the dev estate and the dependency sweep do to a run, and what they do not
- [Server migration & bootstrap](../../infrastructure/MIGRATION.md) — Bare-metal setup, secrets, data restore, SSH backup

---

## Quick reference

| Concern | Where to look |
|---|---|
| Nginx routing (source of truth) | [`infrastructure/local/Dockerfile.frontend`](../../infrastructure/local/Dockerfile.frontend) |
| Gateway routes | [`apps/chat-gateway/src/main.rs`](../../apps/chat-gateway/src/main.rs) |
| Full MLS API | [`apps/chat-delivery-service/src/app.controller.ts`](../../apps/chat-delivery-service/src/app.controller.ts) |
| i18n messages | [`frontend/messages/fr.json`](../../frontend/messages/fr.json) (source), `en.json` |
| Environment setup | `scripts/setup-env.sh` |
| Available commands | `Makefile` |
| Server bootstrap | [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) |
| Protobuf schema | [`libs/proto/canari.proto`](../../libs/proto/canari.proto) |
