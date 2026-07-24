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

### Tauri-specific MLS

- **Epoch caching**: `_epochByGroupId` + `refreshEpochCache()` — Tauri cannot read the WASM group directly, so epoch is cached and refreshed after each queue item, Welcome, and commit.
- **Queue priority**: `group_reset` control → Welcome queue → application queue.
- **Filesystem state**: MLS state persisted under `mls_bin_write_lock` (no IndexedDB).

## iOS specifics

### Notification Service Extension (NSE)

`canari_NSE/NotificationService.swift` is a separate target that runs when a push notification arrives while the app is killed:

- Decrypts MLS ciphertext via Rust FFI (`canari_native_decrypt_message`)
- Decrypts media thumbnails via Rust FFI (`canari_native_decrypt_media`)
- Builds visible notification content (title, body, attachment, category, badge)
- Budget: ~30 seconds; 2 MB media cap

The NSE shares data with the main app via App Group `group.fr.emse.canari`:
- `push_context.json` — push secret, device ID, user ID
- `mls_pending.db` — pending MLS state for background processing

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
