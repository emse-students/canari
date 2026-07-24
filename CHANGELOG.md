# Changelog

All notable changes to Canari are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Biometric enrollment no longer throws when no fingerprint/Face ID is configured; falls back to PIN with a user-facing toast (fr/en)
- Replaced all `unwrap()` calls with `?` in tauri-plugin-keystore `desktop.rs`

### Security
- Added `SECURITY.md` with vulnerability disclosure policy

## [v0.10.9]

### Added
- Call service (WebRTC SFU) with Cloudflare TURN relay
- iOS CallKit integration for incoming VoIP calls
- Android incoming call handling with foreground service
- Tauri 2 mobile architecture (iOS + Android)
- MLS recovery ladder (commit replay → external join → welcome_request)
- MLS desync prevention tactics (epoch-gated commits, coordinated reset)
- Unified rich notification grouping (WP-XP-7)
- Priority notifications for calls & @mentions (WP-XP-5)
- Shared deferred-retry push notification engine (WP-XP-8)
- Boot/relaunch push re-registration (WP-XP-4)
- Rich media notification thumbnails (image/GIF)
- Notification quick actions (reply / mark as read)
- Carte de la Vie Asso (editable poster generator)
- Payment delegation (parent-association Stripe routing)
- Multi-tier cotisations (named membership variants)
- Cercle integration (balance topup webhook + cotisant status API)
- Private user notepad (Markdown)
- Channel push notifications with per-channel level (all/mentions/none)

### Changed
- Migrated frontend to Svelte 5 (runes: $state, $derived, $effect)
- Switched from OpenMLS 0.5 to openmls 0.6 (Rust edition 2024)
- Upgraded to TailwindCSS 4
- Migrated to Bun as the primary frontend package manager
- Replaced individual Dockerfiles with unified Docker Compose setup
- Moved from `ws` library to native WebSocket handling in NestJS

### Fixed
- iOS Notification Service Extension background execution
- MLS epoch desync on concurrent commits
- Device discovery re-bootstrap on stale placeholder
- IndexedDB write-if-newer guard for cross-tab MLS state

### Security
- JWT HS256 with 15-minute access token TTL
- HttpOnly refresh cookie with rotation on each use
- WebSocket auth via dedicated `canari_ws_token` cookie
- Nginx `auth_request` on every service route
- Cross-service communication behind `InternalSecret` guard

> _Earlier releases predate this changelog. See git tags for historical release notes._
