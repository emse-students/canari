# MLS WASM client

**Source**: `frontend/mls-core/` (shared Rust logic), `frontend/mls-wasm/` (WASM bindings), `frontend/src/lib/mls-client/` (TypeScript wrapper layer)

## Overview

The MLS WASM client is the cryptographic core of Canari. It is a Rust library (OpenMLS) compiled to WebAssembly via `wasm-bindgen` and `wasm-pack`. All MLS group operations — key generation, message encryption/decryption, commit processing, group membership changes — execute inside the WASM sandbox. The server never touches plaintext or private keys.

In the Tauri desktop app the same Rust code runs natively (not WASM); the TypeScript side calls it via `invoke()` commands instead of WASM bindings.

## Package structure

```
frontend/mls-core/          # Shared Rust crate (no WASM-specific code)
├── src/
│   ├── lib.rs              # Core MLS operations
│   └── ...

frontend/mls-wasm/          # wasm-bindgen bindings
├── src/
│   └── lib.rs              # #[wasm_bindgen] exports
└── Cargo.toml

frontend/src/lib/mls-client/   # TypeScript wrapper layer
├── ARCHITECTURE.md
├── IMlsService.ts          # Interface (Web + Tauri)
├── incomingDelivery.ts     # Incoming message dispatch
├── initializeConnection.ts # syncAfterConnect(), single-pass reconnect
├── keyPackages.ts          # replenishKeyPackages(), prekey rotation
├── messagePipeline/        # handleWelcome, handleKnownGroup, handleUnknownGroup
├── mlsDeliveryApi.ts       # High-level API calls (groups, messages, invitations)
├── mlsDeliveryHttp.ts      # Low-level fetch helpers (keepalive POST, URL utils)
├── mlsQueueAckPolicy.ts    # ACK exactly once, at-least-once delivery
├── mlsStatePersister.ts    # Save/load WASM state (IndexedDB / filesystem)
├── mlsPerGroupScheduler.ts # Round-robin MLS ops under per-group mutex
├── mlsDesyncPrevention.ts  # Desync countermeasures (see MLS_DESYNC_PREVENTION.md)
├── mlsRecoveryMetrics.ts   # Recovery attempt counters + alerting
├── tabLeader.ts            # BroadcastChannel-based single-tab leader election
├── mlsWasmLoader.ts        # WASM init + lazy load
└── mlsTypes.ts             # Shared TypeScript types
```

## Package boundaries (from ARCHITECTURE.md)

### Preventive (normal online operation)

Measures that avoid entering bad MLS states:

- Single MLS tab leader + `BroadcastChannel` coordination (`tabLeader.ts`).
- Distributed add-lock (`acquireAddLock` / `releaseAddLock` on `IMlsService`).
- One staged commit transaction (`runCommitTransaction`): stage -> validate epoch server-side (`POST /api/mls/commit`) -> merge on accept / roll back on reject.
- Shared delivery HTTP helpers (`mlsDeliveryHttp.ts`): URLs, keepalive POST, response assertion.
- Correct Welcome-before-commit ordering (handled in the message pipeline).

### Resilience (partitions, crashes, multi-device)

Measures that restore correctness after failures:

- Redis delivery queue + ACK policy (`mlsQueueAckPolicy.ts`).
- Reconnect drain, `forgetGroup` / reinvite, phantom-group handling (message pipeline).
- Push wake (platform notification services).

## WASM exported API (`WasmMlsClient`)

The primary TypeScript interface to the WASM module, used by `WebMlsService`:

```typescript
class WasmMlsClient {
  static async new(userId: string, deviceId: string, savedState: string | null, pin: string): Promise<WasmMlsClient>

  // Key packages
  generateKeyPackage(pin: string): Promise<KeyPackageBundle>
  generateKeyPackages(pin: string, count: number): Promise<KeyPackageBundle[]>

  // Groups
  createGroup(groupId: string): Promise<void>
  addMembersBulk(groupId: string, keyPackages: Uint8Array[]): Promise<CommitBundle>
  processWelcome(welcomeBytes: Uint8Array, ratchetTree: Uint8Array | null): Promise<string>

  // Messaging
  sendMessage(groupId: string, plaintext: Uint8Array): Promise<Uint8Array>
  processIncomingMessage(groupId: string, ciphertext: Uint8Array): Promise<Uint8Array>
  processCommit(groupId: string, commitBytes: Uint8Array): Promise<void>

  // State
  saveState(pin: string): Promise<string>
  forgetGroup(groupId: string): Promise<void>
  getLocalGroups(): Promise<string[]>
}
```

## IMlsService interface

Both `WebMlsService` (WASM) and `TauriMlsService` (native) implement `IMlsService`:

```typescript
interface IMlsService {
  init(userId: string, deviceId: string, pin: string, savedState?: string): Promise<void>
  generateKeyPackage(pin: string): Promise<KeyPackageBundle>
  createGroup(groupId: string): Promise<void>
  addMembersBulk(groupId: string, devices: DeviceInfo[]): Promise<CommitBundle>
  sendMessage(groupId: string, appMessageBytes: Uint8Array): Promise<Uint8Array>
  processIncomingMessage(groupId: string, bytes: Uint8Array): Promise<Uint8Array>
  processWelcome(bytes: Uint8Array, ratchetTree: Uint8Array | null): Promise<string>
  processCommit(groupId: string, commitBytes: Uint8Array): Promise<void>
  forgetGroup(groupId: string): Promise<void>
  getLocalGroups(): Promise<string[]>
  saveState(pin: string): Promise<string>
  acquireAddLock(groupId: string): Promise<boolean>
  releaseAddLock(groupId: string): Promise<void>
}
```

## State persistence

WASM state is serialized by `saveState(pin)` as an encrypted blob (PIN-derived key). Storage backend:

| Platform | Storage |
|---|---|
| Browser | `IndexedDB` (key: `mls_state_{deviceId}`) |
| Tauri | Filesystem (`~/.canari/mls_state_{deviceId}`) |

The persister (`mlsStatePersister.ts`) debounces writes and flushes immediately on `visibilitychange` (page hide) and on commit completion.

## Message queue

All WASM calls are serialized through a single message queue to prevent concurrent state access:

```
WebSocket frame / fetchPendingMessages
        |
  enqueueMessage()
        |
   messageQueue[]
        |
   processQueue()  <- one message at a time
        |
  messageCallback()
        |
  messagePipeline handlers
```

**Welcome priority**: Welcome messages are shifted to the front of the queue. Messages for groups with a pending Welcome are buffered until the Welcome completes.

## Tab leadership

`tabLeader.ts` uses a `BroadcastChannel` + heartbeat to elect a single leader tab:
- Only the leader opens the WebSocket and runs `discoverMissingGroups`.
- Followers skip `initializeConnection()` entirely.
- Leadership transfers automatically if the leader tab is closed.

## Building

```bash
cd frontend
wasm-pack build mls-wasm --target web --out-dir src/lib/wasm-mls
# Or via make:
make build-frontend   # builds WASM + SvelteKit
```

After any change to `frontend/mls-core/` or `frontend/mls-wasm/`, always rebuild WASM before testing the frontend.
