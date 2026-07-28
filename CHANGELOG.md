# Changelog

All notable changes to Canari are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Every install that predated v0.11.0 was locked out of its own messages.** v0.11.0 changed the at-rest envelope of the MLS snapshot (Argon2id + 16-byte salt prefix, keyed on the PIN -> ChaCha20-Poly1305, keyed on the PBKDF2 device key) without shipping a reader for the old one, and neither the MLS IndexedDB (pinned at schema version 1) nor native `mls.bin` was ever versioned - so the old blobs stayed exactly where they were. The first v0.11.x login could not decrypt them and reported "your PIN was changed on another device", offering a recovery that no PIN could satisfy. Both platforms now try the legacy envelope once with the PIN just verified, then re-seal and persist the snapshot under the device key, so local history survives the upgrade
- **Native MLS was entirely dead on mobile and desktop since v0.11.0.** `TauriMlsService` invoked `initialiser_mls_avec_clef`, `sauvegarder_mls_et_persister_avec_clef` and `generer_key_packages_et_persister_avec_clef`; the Rust commands are registered as `initialiser_mls`, `sauvegarder_mls_et_persister` and `generer_key_packages_et_persister`. Every native MLS init, state save and KeyPackage publication failed with "command not found" - which also meant no Tauri device published a KeyPackage and none appeared under "Connected devices"
- **Biometric sessions could never save their MLS state.** The at-rest key stays in the platform keystore and never reaches JS, so every save and KeyPackage batch arrived with an empty `deviceKeyB64` and was rejected by `decode_base64_to_32_bytes`. `initialiser_mls` now resolves the key once via `MlsManager::resolve_at_rest_key` and caches it in `AppState`, keeping the BiometricPrompt to one per session
- **A credential identity mismatch was reported as "your PIN was changed on another device".** The two failures are now separated by `BaseMlsService.classifyStateLoadFailure`: only a state that will not decrypt pauses for the old-PIN recovery. A mismatch decrypted fine and no PIN can repair it, so it goes straight to a fresh start instead of stranding the user in a recovery they cannot complete
- **The fresh-start branch left the old state on disk**, so the new device id and the stored blob disagreed and the next launch mismatched again - four device ids minted and deleted in eight seconds in production. The fresh state is now persisted before anything else can fail
- **`/settings` and `/login` could bounce off each other indefinitely**, roughly one round trip per second with a token refresh each. The page guard required MLS readiness while the login page only checked the OIDC session, so the two never converged; `/settings` now tests for an account session, and the login page refuses a second identical auto-redirect within 5 seconds
- **Every session minted a new device id and deleted the previous one server-side.** `WebMlsService.init` and `TauriMlsService.init` redeclared the override without the `opts` parameter, silently dropping `noFreshStart`; an undecryptable local state then took the destructive fresh-start branch instead of surfacing the recoverable "state sealed with the old key" signal. The Tauri override also never cleared `initPromise` on failure, so a retry after recovery would have replayed the cached rejection - it now inherits `BaseMlsService.init`

### Changed
- PIN policy simplified back to a single rule - at least 4 characters - applied identically on setup, change, recovery and unlock. The 4-to-8-digit creation rule added in v0.11.1 is gone, along with the numpad and input caps it implied

## [v0.11.1] - 2026-07-27

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
