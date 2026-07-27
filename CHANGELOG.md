# Changelog

All notable changes to Canari are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- PIN policy: new PINs are 4 to 8 digits, enforced on setup and on PIN change. Unlock stays permissive so PINs created before the policy still work
- Biometric enrolment is now offered in a bottom sheet after the first PIN entry, and the in-app biometric sheet accompanies the OS prompt during enrolment (from the post-login offer and the Settings toggle alike)

### Changed
- Database migrations are now tracked in a `schema_migrations` ledger (filename + checksum) instead of replaying every file on every deploy; one-shot data backfills no longer re-apply and silently revert admin changes
- Renumbered `007_mls_commit_log.sql` to `012_` (it collided with `007_drop_orphan_columns.sql`)
- "Stay signed in" now reflects the stored preference instead of always starting checked

### Fixed
- **Changing the PIN silently disabled biometric unlock**: the local finalisation step deleted the keystore entry that had just been rewritten with the new device key, and raised a confusing "disable biometric unlock" system prompt in the middle of the change. Same path ran during cross-device recovery
- **The "PIN changed on another device" recovery link never appeared in French**: the branch matched a regex against a localized message. It now uses the machine-readable `LoginErrorCode` already carried by `onLoginFailed`
- After a failed or cancelled biometric login, the PIN sheet kept hiding the "use fingerprint" button, forcing a PIN entry with no way to retry the prompt
- Biometric login could silently reuse a device key from a previous failed PIN attempt instead of reading the keystore

### Removed
- Orphan `showBiometricEnrollPrompt` session state and the deprecated `applyNewPinLocally` helper

## [v0.11.0] - 2026-07-27

### Changed
- **PIN replaced by `deviceKeyB64`** across the entire encryption chain: `mls.bin` uses ChaCha20-Poly1305 directly (no more Argon2id), local messages use AES-256-GCM directly (no more PBKDF2), PinVault replaced by DeviceKeyVault which stores the 32-byte key instead of the PIN. `mls.bin` format: `[nonce 12 || ciphertext]`. Local messages format: `[iv 12 || ciphertext]`. The PIN is now only used for the UI (PinModal) and initial `deviceKeyB64` derivation on first login. Changing the PIN re-derives a new `deviceKeyB64` and re-encrypts everything.

### Fixed
- Android keystore `store_device_key` is now best-effort, with a `BiometricPrompt` added to `storeKeyBytes`

## [v0.10.15] - 2026-07-25

### Fixed
- Reverted the PIN minimum length to 4 characters
- Duplicate key in the PIN-check response payload

## [v0.10.14] - 2026-07-25

### Fixed
- Keystore was never populated on first launch, which broke biometric login on the following session

### Security
- Audited corrections to the login chain (Authentik + MLS)

## [v0.10.13] - 2026-07-25

### Added
- Community settings: admins can now manage members and roles - change a member's role, remove a member, and edit each role's base permissions - plus a shareable invite link (fr/en)
- Per-channel write policy (`everyone` / `admins_moderators` / `admins`) for announcement-style channels, enforced server-side on send (migration 031)

### Changed
- Simplified community access model to public/private + admin-always-access; admins now reach every private channel without being explicitly added

### Fixed
- Biometric login now uses a single prompt (device keystore) instead of two: the PIN is no longer stored in the keystore; `biometricLoginImpl` delegates directly to `loginImpl` without a PIN, and the Rust side uses `retrieve_device_key` for the MLS decryption key (completing the PIN→Key migration)

### Removed
- Per-channel/per-role permission-override system (`channel_permission_overrides`, `usePermissionOverrides`) in favour of the simple model (migration 032)

## [v0.10.12] - 2026-07-25

### Fixed
- iOS build used the wrong `xcodebuild` configuration casing
- Restored the iOS keystore class structure and the Android `mls.bin` import
- Aligned `tauri-plugin-log` versions (npm 2.9.0 -> 2.8.0)
- Resolved all Rust warnings in `patches/tao` and npm deprecation warnings

## [v0.10.11] - 2026-07-24

### Changed
- Biometric enrollment no longer throws when no fingerprint/Face ID is configured; falls back to PIN with a user-facing toast (fr/en)
- Replaced all `unwrap()` calls with `?` in tauri-plugin-keystore `desktop.rs`
- MLS audit: modularization and API migration

### Fixed
- Race condition between `channel_key_distribution` and the MLS Welcome
- Docker image healthcheck commands
- Vitest v4 compatibility (restored from the downgrade)

### Security
- MLS encryption key now held in the native keystore (P1b)
- PIN zeroized after use; unified salt RNG

## [v0.10.10] - 2026-07-24

### Fixed
- Infinite `$effect` loop in the Sidebar caused by a tracked `orderedWorkspaces` read
- CD pipeline cache invalidation

## [v0.10.9] - 2026-07-24

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
- Added `SECURITY.md` with vulnerability disclosure policy

> _Earlier releases predate this changelog. See git tags for historical release notes._
