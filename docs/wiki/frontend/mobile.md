# Mobile architecture (Tauri)

**Stack**: Tauri 2 / Rust / SvelteKit  
**Source**: `frontend/src-tauri/`

Canari runs as a native mobile app on Android and iOS via Tauri 2, using the same SvelteKit frontend rendered in a WebView. This page documents mobile-specific architecture that extends the [frontend architecture](../architecture.md).

## Key differences from Web

| Aspect | Web (browser) | Tauri (mobile) |
|---|---|---|
| MLS | WASM (`WebMlsService`) | Native Rust (`TauriMlsService` via `invoke()`) |
| State storage | IndexedDB | Filesystem (`~/.canari/`) |
| HTTP | `fetch()` with cookies | `@tauri-apps/plugin-http` (bypasses CORS) |
| WebSocket auth | `canari_ws_token` cookie | `?token=` query param (cookie not sent on cross-origin WS) |
| MLS snapshot | Argon2 in worker thread → IndexedDB | Direct filesystem write under `mls_bin_write_lock` |
| Prekeys | 50 OTKPs | 200 OTKPs (more frequent offline periods) |
| Push notifications | — | FCM (Android), APNs via FCM (iOS) |

## Native MLS

`TauriMlsService` calls Rust functions via `invoke()` instead of WASM:

```typescript
// TauriMlsService.ts
async sendMessage(groupId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  return invoke('mls_send_message', { groupId, plaintext });
}
```

The Rust side is in `frontend/src-tauri/src/` (Tauri commands) and `frontend/mls-core/` (shared MLS logic, same crate used by WASM). `BaseMlsService` provides the shared `runCommitTransaction` / `stageAddMembers` / `mergePendingCommit` primitives that both `WebMlsService` and `TauriMlsService` extend.

> **The command name is an untyped string on both sides.** Nothing checks that the literal passed
> to `invoke()` matches a `#[tauri::command]` listed in `generate_handler!` in `lib.rs`; a stale or
> renamed name compiles, lints and type-checks, then fails only at runtime with "command not
> found". v0.11.0 shipped `initialiser_mls_avec_clef`, `sauvegarder_mls_et_persister_avec_clef` and
> `generer_key_packages_et_persister_avec_clef` against Rust commands that had kept their original
> names - every native MLS init, save and KeyPackage publication failed for as long as it was live.
> When renaming a command, grep both sides.
>
> The same hazard applies to **plugin** commands, with two extra ways to get it wrong: the prefix
> is the Tauri plugin name (`plugin:keystore|…`), not the Android class id, and the command must
> also appear in the plugin's `build.rs` ACL array. See
> [auth - calling the keystore plugin from JS](modules/auth.md).

### Device key on the biometric path

In biometric mode the at-rest key never reaches JS: `ctx.getDeviceKey()` stays `''` for the whole
session, so every `invoke` carries an empty `deviceKeyB64`. `initialiser_mls` resolves the key once
(`MlsManager::resolve_at_rest_key`, keystore Path A) and caches it in `AppState.device_key`; the
save and KeyPackage commands fall back to that cache. Resolving per call would instead fire one
`retrieve_device_key` BiometricPrompt per save.

### Tauri-specific MLS

- **Epoch caching**: `_epochByGroupId` + `refreshEpochCache()` — Tauri cannot read the WASM group directly, so epoch is cached and refreshed after each queue item, Welcome, and commit.
- **Queue priority**: `group_reset` control → Welcome queue → application queue.
- **Filesystem state**: MLS state persisted under `mls_bin_write_lock` (no IndexedDB).

### Local message store

Conversations, messages and the outbox live in `canari_<userId>.db`, opened by `SqliteStorage`
through `@tauri-apps/plugin-sql`. It is **frontend-only**: the native side owns a different
database, `mls_pending.db` (queued push payloads), so the two never contend for the same file.

`getStorage()` falls back to `IndexedDbStorage` when `SqliteStorage.init()` throws. That fallback
is a last resort, not a supported mode - it is a `console.warn` in a WebView, so a permanent
degradation looks exactly like a healthy start. Check for `[DB] Using SQLite storage (Tauri)` in
the logs to confirm the real backend.

**A migration outlives the schema it was written against.** Branches are keyed on
`PRAGMA user_version`, and a brand-new database starts at 0, so every historical branch runs on it.
The v1 -> v2 purge named a `salt` column that the deviceKeyB64 refactor had removed from
`CREATE TABLE messages`, and every fresh install threw `no such column: salt` and silently ran on
IndexedDB. Two rules follow, both enforced in `db/sqliteMigrations.ts` and its tests:

- A database created by the `CREATE TABLE IF NOT EXISTS` statements has nothing to migrate: stamp
  it at `SCHEMA_VERSION` and skip every branch. `user_version` alone cannot detect this - a
  pre-migration-system database also reports 0 - so the check reads `sqlite_master` **before** the
  creation statements run.
- A migration that inspects columns must build its statement from
  `PRAGMA table_info(...)`, so dropping a column can never break the migration that mentions it.

## Rules that hold across both platforms

**Push is all-FCM.** One transport for Android and iOS alike: the backend sends every `PushToken`
through `getMessaging().send()`, and FCM relays to APNs using the `.p8` key configured in the
Firebase console. There is no direct-APNs path for messages (VoIP calls are the exception, see
below), which is why `FirebaseAppDelegateProxyEnabled` must stay enabled. Architecture:
[`services/chat-delivery.md`](../services/chat-delivery.md).

**Firebase 12 moved the iOS data path.** `messaging:didReceiveMessage:` no longer exists. FCM data
now arrives through the `UIApplicationDelegate` swizzle (`CanariInstallRemoteNotificationHook`) and
the `UNUserNotificationCenter` callbacks, both funnelling into `CanariHandleFcmData()`. Hook new
iOS push work there.

**Branch on the runtime helpers, not on ad-hoc checks:** `isIosTauriRuntime()` and
`isMobileTauriRuntime()` in `appVersion.ts`. Several behaviours shipped Android-only and had to be
widened to all-mobile afterwards (heartbeat, notification suppression, `reloadStateFromDisk`) —
when adding one, decide deliberately which of the two it belongs to.

**Kotlin nested types go on the outer class body, never inside a companion object** — declared
there they are unreachable by class name, and the failure only appears in the release build, which
is the [first real Kotlin compile](../cicd.md).

## iOS specifics

### Notification Service Extension (NSE)

`canari_NSE/NotificationService.swift` is a separate target that runs when a push notification arrives while the app is killed:

- Decrypts MLS ciphertext via Rust FFI (`canari_native_decrypt_message`)
- Decrypts media thumbnails via Rust FFI (`canari_native_decrypt_media`)
- Builds visible notification content (title, body, attachment, category, badge)
- Writes decrypted messages to `fcm_message_cache.ndjson` in the App Group container, which the app drains into its own `app_data_dir` and pre-injects at boot (see "FCM message cache")
- Runs the same background MLS decrypt ladder as Android (direct decrypt → catch-up-first for local groups → Welcome-race retry for non-local groups)
- Budget: ~30 seconds; 2 MB media cap

The NSE shares data with the main app via App Group `group.fr.emse.canari`:
- `push_context.json` — device ID, user ID, backend base URL, push token. No key material: the
  device key comes from the shared keychain item `mls_bg_key_<alias>` (see
  [auth](modules/auth.md) "Where the key lives")
- `mls.bin` — read-only mirror of the persisted MLS state; the NSE never writes it
- `channel_keys.json` — read-only mirror for community/channel message decryption
- `push_secret.txt` — read-only mirror of the PushSecret for backend fetch paths

The NSE does **not** write `mls.bin`, process Welcome pushes, or drain the outbox. Those remain app-process responsibilities.

### CallKit (VoIP pushes)

When the app is killed, incoming calls use CallKit via direct APNs VoIP pushes:

1. Caller's client → `POST /api/calls/ring`
2. Backend sends APNs VoIP push (ES256 JWT, topic `<bundle>.voip`)
3. `PKPushRegistry` delivers → `CanariReportIncomingCall`
4. User answers → `pending_call_accept.json` written → accept deep link fired
5. App unlocks → TS store drains pending accept → `CallService` auto-accepts

VoIP push tokens are persisted to `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field).

### Force-quit constraint

Once the user swipes the app away on iOS:
- **No** silent `content-available` data pushes are delivered
- **No** `BGTask` runs until manual relaunch
- Visible (`mutable-content`) alert pushes still arrive and wake the NSE
- Background state-sync only resumes on next app open

Android has no equivalent restriction.

### iOS project

`canari.xcodeproj/project.pbxproj` is **hand-maintained** (not xcodegen). Key details:
- Two targets: `Canari` (app) + `CanariNotifications` (NSE)
- Custom URL scheme, `NS*UsageDescription` keys
- `FirebaseAppDelegateProxyEnabled` — must stay enabled
- Localized `InfoPlist.strings` (fr/en `PBXVariantGroup`)
- `aps-environment: production` for TestFlight/App Store
- Provisioning profiles: two named profiles matching `PROVISIONING_PROFILE_SPECIFIER`, team "Les Rootz" `4CLNB8SR6L`

## Android specifics

### Push notification handling

`CanariFirebaseMessagingService.kt` — the single FCM handler:

- `onMessageReceived` — processes data pushes (MLS messages, calls, channel events)
- Decrypts messages via JNI (`nativeDecryptMessage`)
- Decrypts media thumbnails via JNI (`nativeDecryptMedia`)
- Shows notifications: MessagingStyle for messages, CallStyle for calls
- Quick actions: Reply (text input) and Mark as Read (broadcast to `CanariNotificationActionReceiver`)

MessagingStyle takes two `Person`s and **both** need an icon. The sender's comes from `fetchAvatar(senderId)`; ours comes from `fetchAvatar(loadUserId())` - Android attributes the inline reply to the self `Person` while the reply is in flight, so an iconless self is a blank face on the only message in that thread the user actually wrote. `MlsContextLoader.loadUserId` reads just the `userId` field of `push_context.json`, deliberately not `loadPushContext`, whose expensive half is a Keystore round trip this caller has no use for. iOS shows a single attachment image rather than a thread, so it has no self `Person` and nothing to fix there.

#### Background MLS decrypt ladder

Both Android and the iOS NSE run the same ladder when an encrypted MLS message push arrives:

1. Try a direct decrypt (`tryDecrypt` / `decryptProto`).
2. If that fails and the group is already local (`isGroupLocal` → epoch ≥ 0), run in-memory commit catch-up (`tryDecryptWithCommitCatchup` / `decryptWithCommitCatchup`) immediately.
3. If the group is **not** local, retry a few times to give a concurrent Welcome push time to join the group (`WELCOME_RACE_RETRIES × WELCOME_RACE_RETRY_DELAY_MS` = 3 × 1.8 s on Android, mirrored by `welcomeRaceRetries × welcomeRaceRetryDelayMs` in the NSE).
4. If the group becomes local during that race, try commit catch-up as a last resort before falling back.
5. If everything fails, Android enqueues `MlsBackgroundWorker` and shows the generic fallback notification (unless the push is silent, in which case it returns quietly). The iOS NSE cannot enqueue work from the extension, so it shows the fallback directly.

This order matters because a silent commit push advances the epoch but cannot persist state while the app is closed; the next message push therefore looks like an epoch gap on a group that is already joined. Running catch-up first for local groups avoids the old ~9.6 s retry loop.

### FCM message cache

Both platforms write decrypted message previews to `fcm_message_cache.ndjson` after a successful decrypt:

- Android: `CanariFirebaseMessagingService.writeFcmCache` → `{app_data_dir}` directly. The FCM service runs in the app's own process, so it shares that directory.
- iOS NSE: `NotificationService.writeFcmCache` → the **App Group container**, then `CanariDrainAppGroupFcmCache` (called from `canari_ios_bootstrap` and on `didBecomeActive`) moves the entries into `{app_data_dir}`.

That extra hop is not optional: an app extension has its own data container, so `app_data_dir` resolved inside the NSE is a directory the app can never read. The App Group is the only storage the two processes share — the same reason `mls.bin` is mirrored there. The NSE also writes with `completeFileProtectionUntilFirstUserAuthentication`, because it runs on a locked device where the default protection class cannot be written.

The file is bounded to 50 entries and read at boot by `read_and_clear_fcm_cache` (Rust) so the app can pre-inject messages into the local store before the full MLS sync finishes. Both writers must produce the same JSON fields (`groupId`, `messageId`, `senderId`, `senderName`, `content`, `timestamp`, `type`, plus optional `replyTo` and `mediaKind`). `fcmCacheFields.test.ts` pins the fields **and** both halves of the iOS path - off macOS it is the only gate on either.

**The cache also carries OUTGOING messages, not only received ones.** A notification quick reply is built and delivered entirely natively (`writeSentMessageToCache` on Android, `CanariWriteSentMessageToCache` on iOS), so it never becomes a TypeScript outbox entry - and `reconcileOutboxSent` only *deletes* entries. Without an entry here, a reply the peers received would leave no trace whatsoever on the device that sent it, which from the app is indistinguishable from a reply that was never sent. The entry carries OUR user id as `senderId`, which is all the injection path needs: `mapStoredMessagesToChatMessages` derives `isOwn` from it, so the row renders as our own message and raises no phantom unread. It is written only once the drain reports the reply delivered - an undelivered reply must not appear as sent.

Note the asymmetry that leaves: an undelivered quick reply is kept in `outbox_pending.ndjson` only, and `store_outbox_mirror` **rewrites** that file from the TypeScript queue, so the next foreground outbox mutation wipes it rather than flushing it. The notification is deliberately left up as the retry affordance. Adopting an unknown mirror entry back into the TS outbox is the real fix and is still open (WP-NOTIF-1).

### Background execution

- **WorkManager** (`OutboxRetryWorker`): exponential backoff retry for unsent outbox messages
- **BootReceiver** (`CanariBootReceiver`): re-registers FCM token + drains outbox on boot
- **Foreground guard**: retry is deferred when the TS outbox flusher is active

### Outbox mirror

Both platforms maintain an `outbox_pending.ndjson` mirror for background sends:

- TS writes to the mirror on every outbox append
- Background path reads + drains the mirror
- Preserves `silent` flag per entry
- Shared drain path: encrypt via JNI/FFI → POST `/api/mls/push/send`

### Keyboard media (Android)

`KeyboardMediaBridge.kt` intercepts `InputConnection.commitContent` to handle GIF/sticker commits from the soft keyboard. Dispatches `canari-keyboard-media` DOM events picked up by `MainChatPage` → routed through the normal media pipeline.

## Shared native code

Rust FFI functions shared across both platforms via `frontend/src-tauri/src/mobile/`:

| Module | Purpose |
|---|---|
| `background.rs` | Background message decrypt, media decrypt, outbox drain |
| `proto_fields.rs` | Minimal protobuf encoder (no TS runtime in background) |
| `*_ffi.rs` | Platform-specific FFI exports (JNI for Android, C-ABI for iOS) |

Key FFI functions:
- `nativeDecryptMessage` / `canari_native_decrypt_message` — MLS decrypt in background
- `nativeDecryptMedia` / `canari_native_decrypt_media` — Media blob decrypt
- `nativeBuildTextMessageProto` / `canari_native_build_text_message_proto` — Reply proto encoder
- `nativeBuildReadReceiptProto` / `canari_native_build_read_receipt_proto` — Read receipt proto encoder

## CI/CD

| Workflow | Output |
|---|---|
| `ios.yml` | `.ipa` for TestFlight (uses `altool`) |
| `android.yml` | `.aab` for Google Play |
| `appimage.yml` | `.AppImage` for Linux desktop |
| `bump-version.yml` | Bumps `MARKETING_VERSION` across iOS + Android |

See [`cicd.md`](../cicd.md) for the full pipeline.

## See also

- [`frontend/architecture.md`](../architecture.md) — SvelteKit architecture, stores, routing
- [`frontend/mls-wasm.md`](../mls-wasm.md) — WASM MLS client (Web counterpart)
- [`frontend/modules/calls.md`](modules/calls.md) — CallKit and call signaling
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Push notification backend (FCM, APNs VoIP)
- [`cicd.md`](../cicd.md) — Mobile build workflows
