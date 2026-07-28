# Changelog

All notable changes to Canari are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **A community can now be deleted.** There was no delete path at all: no `DELETE workspaces/:id` existed and the community settings modal offered only "Quitter la communaute", so a community created by mistake was permanent for everyone in it and its admin leaving simply orphaned it. `DELETE /api/channels/workspaces/:workspaceId` requires MANAGE_WORKSPACE - deliberately stricter than a kick or a channel archive, which also accept MANAGE_CHANNEL, because this one acts on every member at once. It is a soft delete: `channel_workspaces.archived` (migration 033) and the workspace's channels flip to archived, every read path filters them out (listing, slug lookup, invite preview, invite accept - a link must not resurrect a deleted community), and nothing is dropped, so recovery is two `UPDATE`s. Connected members are cleaned up by a new `workspace.deleted` broadcast rather than by polling

### Changed
- **The two biggest families of one-way colour are gone.** A one-way utility is one with no `dark:` counterpart in the same class list: it does not flip, while the `text-text-main` on top of it does, so the pair degrades to white-on-white exactly where the theme changes. Every raw `[#151B2C]` (47 sites) is now the `cn-ink` token - identical colour, since `--color-cn-ink` *is* `#151b2c`, but it can no longer drift from it - and the red error banner triad (`bg-red-50` / `border-red-200` / `text-red-700`, ~120 sites) now draws from `red-err`, which flips on its own; the `dark:bg-red-900` overrides that used to compensate were dropped with it. Amber, emerald and the remaining dark hexes are still to do. Worth recording: a plain grep over-reports this by 4x, because `bg-white dark:bg-slate-900` is perfectly fine - the detection has to be per class list, and must not tokenize on `:` or it strips the very `dark:` prefixes it is looking for
- **Revoking a device now asks before it fires.** The trash icon in "Gestion des appareils" ran `deleteDevice` on a single click, and that call is a full purge - KeyPackages, prekeys, push tokens, group memberships, queued messages, Redis routing entry - so anything still in flight for that device was lost with no way back and no warning. Kicking a member from a channel already goes through `showConfirm`; revoking a device is at least as destructive and now gets the same treatment, naming the device and stating what is lost. The dialog renders above the device modal (`z-[300]` over `z-[280]`)
- **"Rester connecte" described a secret that is no longer stored.** Both the settings row and the PIN sheet still promised to keep the PIN ("Conserve votre PIN", "Votre PIN sera conserve"), copy written before v0.11.0 moved the at-rest secret to a 32-byte device key. The PIN has not been persisted since; what the toggle actually does is move the AES-GCM-wrapped device key from `sessionStorage` to `localStorage`. Misleading copy on a security control is a defect in the control, so both strings now say what is kept and add that the PIN itself never is
- The device list no longer hardcodes "Appareil {n}" in French - it goes through Paraglide like every other user-visible string

### Security
- **iOS never got the device key out of its keystore.** Follow-up to the change below, caught by dispatching the iOS release workflow as a compile check - the first time any of that Swift/ObjC had been through a compiler. Two defects, both silent: `KeystorePlugin.swift` had a `guard` body that fell through, which is not valid Swift and killed the build outright; and the two background readers pulled the key out of the Keychain with `String(data:encoding:.utf8)`, while `storeKeyBytes` writes the RAW 32 bytes (it base64-decodes its argument, which is why `getKeyBytes` re-encodes on the way out). Random key bytes are almost never valid UTF-8, so the reader returned nil, the key arrived empty and every push fell back to generic text - exactly the failure this work exists to remove. The iOS migration had the mirror error, writing the base64 text where the login path writes bytes, so a migrated install would have disagreed with a fresh one. Android was right on both counts. The contract - raw bytes at rest, base64 across the FFI - is now asserted across all five files by `pushContextFields.test.ts`, since nothing else checks it off macOS
- **The MLS device key no longer sits in cleartext application data.** `push_context.json` held `deviceKeyB64` - the single key that decrypts `mls.bin` and every local message - as plain text, because a background FCM/NSE handler runs with no user present and so cannot satisfy a biometric prompt. The requirement was real; the plaintext file was not the way to meet it, and on iOS that file is swept up by an unencrypted Finder/iTunes backup. The key now lives only in the platform keystore. Android needed no new key: the existing alias is already `setUserAuthenticationRequired(false)`, so the gap was a Context-only reader (`MlsDeviceKeyStore`) - the plugin's own accessor demands an Activity for a purely cosmetic prompt. It deliberately does **not** set `setUnlockedDeviceRequired(true)`, which would make the key unusable while the screen is locked, i.e. exactly when a push arrives. iOS did need a second keychain item (`mls_bg_key_<alias>`, `AfterFirstUnlockThisDeviceOnly`, no access control, shared with the NSE via access group `group.fr.emse.canari`) because the existing one is `.userPresence`-gated and an extension can never satisfy that. A one-shot migration promotes the key at the next app start and strips the field, including the App Group mirror; the background readers have no JSON fallback, so at most one push before that launch shows generic text

### Fixed
- **iOS decrypted no push notification at all, and had not since v0.11.0.** `canari_push.mm` and the notification service extension both parsed `json["pin"]` out of `push_context.json` and rejected the context when that field was empty - but the v0.11.0 rename made `store_push_context` write `deviceKeyB64`, and nothing has written `pin` since. `CanariLoadPushContext` therefore returned nil on *every* call: every push served the generic fallback, and quick reply, mark-read, welcome-request and the outbox drain all aborted at "push_context absent". The value was never wrong, only the key name - the Rust FFI parameter was already `device_key_b64`. Android was unaffected. Nothing could catch this: the contract is a JSON string key on one side and a string literal on three others, so Rust, Swift, ObjC and Kotlin all compiled happily. `pushContextFields.test.ts` now cross-checks what `store_push_context` writes against what all three native readers parse, and fails on drift
- **The community settings modal was unreadable in dark mode.** Its panels, cards, member list, invite row and inputs were painted with one-way light-mode classes (`bg-white`, `bg-white/50`, `bg-amber-100 text-amber-900`, `bg-red-50 text-red-600`, a `color-mix(var(--cn-surface), white)` sidebar) while the text on top of them used `text-text-main`, which correctly flips to near-white - white text on a white card. Only the text obeyed the theme, so the modal degraded exactly where the theme changed. The whole modal now draws from the `app.css` tokens (`bg-cn-surface`, `bg-cn-bg`, `text-red-err`, `text-green-ok`, `bg-cn-yellow`/`text-cn-ink`), which flip on their own. `--color-cn-surface` and `--color-surface-elevated` are new `@theme` entries so `bg-cn-surface` exists as a utility instead of every component reaching for `bg-[var(--cn-surface)]` or, worse, `bg-white`
- **The biometric sheets hardcoded their surfaces** (`bg-white/95 dark:bg-[#1a1f2e]/95`, where `#1a1f2e` is not even `--cn-surface`), pinning the enrolment and unlock sheets to a colour pair maintained by hand. Both now use `bg-cn-surface/95` and token borders. The `dark:` variant itself is sound on the web build - verified by computed style in both themes - so a sheet reported dark under a light theme on device points at the native runtime, not at these classes
- **"Moderer les messages" drove nothing.** The community role matrix advertised the permission per role - "pin or delete other members' messages" - but no channel message could be deleted by anyone, admin included: `MainChatPage` passed `onDelete`/`onEdit` as `undefined` for every channel, and the backend had no delete endpoint at all. Pinning, meanwhile, ignored the permission entirely and let any member pin anyone's message. `DELETE /api/channels/:channelId/messages/:messageId` now exists (author always, someone else's with `channel.moderate`), pinning someone else's message requires the same permission, and `memberCanModerateMessages` is the one check every moderation path shares, so the matrix and the enforcement cannot drift. The workspace listing gained `viewerCanModerate` so the client can offer the action without probing for a 403
- **System messages named everyone but their author "Utilisateur inconnu".** `resolveDisplayNames` gated its fetch on `getUserDisplayNameSync(id) !== id`, but that helper answers a cache miss with the localized "unknown user" label - never the id - so the guard always passed and the fetch below was unreachable. Only the current user resolved, via the separate `currentUserId()` branch. Inviting someone to a community therefore posted "X a ajouté Utilisateur inconnu au groupe" into the channel, and because system-message text is composed client-side and stored server-side, the wrong name was permanent. Resolution now goes through a new `peekUserDisplayName`, which returns `null` on a miss instead of inventing a placeholder
- **A device that rejoined a group by external commit received nothing afterwards.** `validateCommit` advanced the epoch and fanned the commit out to the existing members, but never created the joining device's `DeviceGroupMembership` row - the external commit is the one join path with no Welcome, so nothing else creates it. Recipient resolution filters on `status='active'`, so the rejoined device was invisible to routing while believing it was a member: its own messages went out, but the history bundle it solicited and every subsequent live message were fanned out to everyone except it. Observed end to end on a wiped device: the peer logged `Full history sent: 33 message(s)` three times over three minutes and the requester never saw a single frame. `validateCommit` now promotes the committing device to `active` when it has no active row

## [v0.11.2] - 2026-07-28

### Fixed
- **No MLS state could be saved through the encrypt worker since v0.11.0.** The PIN -> deviceKey rename updated the worker's reader (`payload.deviceKeyB64`) but left the sender posting `payload.pin`, so the worker sealed with `undefined` and wasm-bindgen died reading `undefined.length`. Harmless-looking on the checkpoint paths, where the rejection was only logged - fatal on the fresh-start path, which awaits the save and turned it into `can't access property "length", e is undefined` at login. The three MLS worker contracts (encrypt, catch-up decrypt, key packages) now live in one `mlsWorkerProtocol.ts` imported by both ends, so a renamed field fails `svelte-check` instead of arriving as `undefined`
- **Every install that predated v0.11.0 was locked out of its own messages.** v0.11.0 changed the at-rest envelope of the MLS snapshot (Argon2id + 16-byte salt prefix, keyed on the PIN -> ChaCha20-Poly1305, keyed on the PBKDF2 device key) without shipping a reader for the old one, and neither the MLS IndexedDB (pinned at schema version 1) nor native `mls.bin` was ever versioned - so the old blobs stayed exactly where they were. The first v0.11.x login could not decrypt them and reported "your PIN was changed on another device", offering a recovery that no PIN could satisfy. Both platforms now try the legacy envelope once with the PIN just verified, then re-seal and persist the snapshot under the device key, so local history survives the upgrade. Opening the envelope says nothing about whose state it is: a snapshot left by an interrupted fresh start names the previous device, and that verdict is re-read after the migration so it takes the fresh start it needs instead of escaping init as a raw "Credential identity mismatch"
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
